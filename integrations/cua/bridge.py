"""One bounded SDK request against a verified, Perpetual-owned Cua desktop.

Node verifies Docker ownership before calling this bridge. The desktop publishes
no port: each SDK command runs relay.py inside it through docker exec on the
local engine. No cloud/Localhost fallback and no typed sandbox.driver: that
accessor is Fleet-only in 0.8.0.
"""

import asyncio
import base64
import contextlib
import importlib.metadata
import json
import re
import sys
from pathlib import Path

SDK_VERSION = "0.8.0"
MAX_BYTES = 8 * 1024 * 1024
RESPONSE_LIMIT = 12 * 1024 * 1024
# The values src/sandbox/cua-local.ts checks readiness with: computer-server's own
# Python, run as the guest's UID, reaches computer-server on this port in the guest.
GUEST_PYTHON = "/opt/computer-server/venv/bin/python"
GUEST_USER = "1000"
GUEST_API_PORT = 8000
RELAY = Path(__file__).with_name("relay.py").read_text(encoding="utf-8")


class BridgeError(Exception):
    pass


def bounded_int(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise BridgeError("Invalid numeric argument.")
    return value


def guest_path(value):
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value or len(value) > 4096:
        raise BridgeError("Use an absolute path inside the sandbox.")
    return value


def local_engine(host):
    # The local Docker socket or named pipe Node inspected the desktop on, never a TCP or SSH endpoint.
    if (not isinstance(host, str) or "\x00" in host
            or not (re.fullmatch(r"unix:///[^\r\n]+", host) or re.fullmatch(r"npipe:////\./pipe/[a-zA-Z0-9_.-]+", host))):
        raise BridgeError("A local Docker engine is required.")
    return host


async def relay(docker_host, container_id, body, timeout):
    """Runs relay.py in the desktop through docker exec and returns computer-server's response body."""
    process = await asyncio.create_subprocess_exec(
        "docker", "--host", docker_host, "exec", "-i", "--user", GUEST_USER, container_id,
        GUEST_PYTHON, "-I", "-c", RELAY, str(GUEST_API_PORT), "POST", "/cmd", str(timeout),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        try:
            process.stdin.write(body)
            await process.stdin.drain()
        except OSError:
            pass  # A docker exec that ended early closed its input; its exit status says why.
        finally:
            process.stdin.close()
        chunks, size = [], 0
        while chunk := await process.stdout.read(65536):
            size += len(chunk)
            if size > RESPONSE_LIMIT:
                raise BridgeError("Cua response exceeded its limit; guest completion may be unknown.")
            chunks.append(chunk)
        code = await process.wait()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    # docker exec exits 126 or 127 when the guest cannot run the command it was given.
    if code in (126, 127):
        raise BridgeError(f"The sandbox image cannot run {GUEST_PYTHON}, which reaches its computer-server.")
    if code != 0:
        raise BridgeError("computer-server did not answer inside the desktop. Guest completion may be unknown; inspect it before retrying.")
    return b"".join(chunks)


def checked_transport(docker_host, container_id):
    from cua_sandbox.transport.http import HTTPTransport

    class CheckedExecTransport(HTTPTransport):
        """0.8.0 compatibility boundary: computer-server's /cmd protocol without a
        host port. One request per command, relayed through docker exec, strict
        file results, structured shell failures. Re-review when updating the
        pinned SDK.
        """

        _open = False

        async def connect(self):
            # No HTTP client: nothing on the host connects to computer-server.
            self._open = True

        async def disconnect(self):
            self._open = False

        async def _cmd(self, command, params=None):
            if not self._open:
                raise BridgeError("Cua transport is disconnected.")
            body = json.dumps({"command": command, "params": params or {}}).encode("utf-8")
            timeout = float((params or {}).get("timeout", 30)) + 10
            # Mutations are never automatically replayed, including when computer-server answers an error.
            output = await asyncio.wait_for(relay(docker_host, container_id, body, timeout), timeout + 10)
            payload = None
            for line in output.decode("utf-8").splitlines():
                if line.startswith("data: "):
                    payload = json.loads(line[6:])
                    break
            if not isinstance(payload, dict):
                raise BridgeError("Cua returned an invalid command response.")
            result = payload.get("result", payload)
            if command == "run_command":
                if not isinstance(result, dict):
                    raise BridgeError("Cua returned an invalid command result.")
                # computer-server answers a command it timed out or could not run with success false and a
                # placeholder code such as -1; the command's outcome in the guest is unknown.
                if payload.get("success") is False or result.get("success") is False:
                    raise BridgeError("The guest command did not finish, for example at its time limit; its outcome is unknown.")
                code = result.get("returncode", result.get("return_code"))
                if (type(code) is not int or not isinstance(result.get("stdout", ""), str)
                        or not isinstance(result.get("stderr", ""), str)):
                    raise BridgeError("Cua did not return a confirmed guest exit code.")
                # A nonzero exit is evidence for the caller, not an SDK fault.
                return {"result": {"returncode": code, "stdout": result.get("stdout", ""), "stderr": result.get("stderr", "")}}
            if (payload.get("success") is False or payload.get("error")
                    or (isinstance(result, dict) and (result.get("success") is False or result.get("error")))):
                raise BridgeError("The guest rejected the requested action.")
            if command in ("file_exists", "get_file_size", "read_bytes", "write_bytes"):
                if not isinstance(result, dict):
                    raise BridgeError("Cua returned an invalid file response.")
                if command == "file_exists" and type(result.get("exists")) is not bool:
                    raise BridgeError("Cua did not confirm whether the file exists.")
                if command == "get_file_size" and (type(result.get("size")) is not int or result["size"] < 0):
                    raise BridgeError("Cua did not return a file size.")
                if command == "read_bytes":
                    encoded = result.get("content_b64", result.get("content"))
                    if not isinstance(encoded, str):
                        raise BridgeError("Cua did not return file content.")
                    base64.b64decode(encoded, validate=True)
                if command == "write_bytes" and not (payload.get("success") is True or result.get("success") is True):
                    raise BridgeError("Cua did not confirm the file write.")
            return payload

    # computer-server's address inside the guest, where relay.py reaches it; the host never connects to it.
    return CheckedExecTransport(f"http://127.0.0.1:{GUEST_API_PORT}")


async def dispatch(request):
    if importlib.metadata.version("cua-sandbox") != SDK_VERSION:
        raise BridgeError("Expected cua-sandbox 0.8.0; sync integrations/cua first.")
    from cua_sandbox import Sandbox

    docker_host = local_engine(request.get("dockerHost"))
    container_id = request.get("containerId")
    if not isinstance(container_id, str) or not re.fullmatch(r"[a-f0-9]{64}", container_id):
        raise BridgeError("A sandbox container ID is required.")
    name = request.get("name", "")
    if not isinstance(name, str) or not name.startswith("perpetual-cua-"):
        raise BridgeError("A Perpetual sandbox name is required.")
    action = request.get("action", {})
    if not isinstance(action, dict):
        raise BridgeError("Invalid sandbox action.")

    # The explicit transport bypasses all Fleet/name/host discovery. Leaving
    # this context disconnects the client, not the persistent container.
    async with Sandbox(checked_transport(docker_host, container_id), name=name, _telemetry_enabled=False) as sandbox:
        kind = action.get("type")
        if kind == "exec":
            command = action.get("command")
            if not isinstance(command, str) or not command.strip() or len(command) > 32768 or "\x00" in command:
                raise BridgeError("A bounded guest command is required.")
            timeout = bounded_int(action.get("timeoutSeconds", 30), 1, 300)
            result = await sandbox.shell.run(command, timeout=timeout)
            return {"returncode": result.returncode, "stdout": result.stdout[:262144],
                    "stderr": result.stderr[:262144],
                    "truncated": len(result.stdout) > 262144 or len(result.stderr) > 262144}
        if kind == "screenshot":
            content = await sandbox.screenshot()
            if not content.startswith(b"\x89PNG\r\n\x1a\n") or len(content) > MAX_BYTES:
                raise BridgeError("Sandbox returned an invalid or oversized PNG.")
            return {"mimeType": "image/png", "contentBase64": base64.b64encode(content).decode("ascii")}
        if kind == "click":
            x = bounded_int(action.get("x"), 0, 32767)
            y = bounded_int(action.get("y"), 0, 32767)
            # Basic Sandbox mouse API: use only its unambiguous left-click.
            await sandbox.mouse.click(x, y)
            return {"dispatched": True, "verified": False}
        if kind == "type":
            text = action.get("text")
            if not isinstance(text, str) or len(text) > 16384:
                raise BridgeError("Text must be at most 16384 characters.")
            await sandbox.keyboard.type(text)
            return {"dispatched": True, "verified": False}
        if kind == "keypress":
            keys = action.get("keys")
            if (not isinstance(keys, list) or not 1 <= len(keys) <= 8
                    or any(not isinstance(key, str) or not 1 <= len(key) <= 32 for key in keys)):
                raise BridgeError("Provide one to eight key names.")
            await sandbox.keyboard.keypress(keys)
            return {"dispatched": True, "verified": False}
        if kind == "upload":
            content = base64.b64decode(action.get("contentBase64", ""), validate=True)
            if len(content) > MAX_BYTES:
                raise BridgeError("File exceeds the 8 MiB limit.")
            path = guest_path(action.get("path"))
            await sandbox.files.write_bytes(path, content)
            # File helpers in 0.8.0 do not propagate all guest failures. Read
            # back the exact bytes before claiming the upload succeeded.
            if not await sandbox.files.exists(path) or await sandbox.files.read_bytes(path, length=MAX_BYTES + 1) != content:
                raise BridgeError("Guest file upload could not be confirmed.")
            return {"bytes": len(content)}
        if kind == "download":
            path = guest_path(action.get("path"))
            if not await sandbox.files.exists(path):
                raise BridgeError("Guest file does not exist.")
            expected_size = await sandbox.files.size(path)
            if expected_size > MAX_BYTES:
                raise BridgeError("File exceeds the 8 MiB limit.")
            content = await sandbox.files.read_bytes(path, length=MAX_BYTES + 1)
            if len(content) > MAX_BYTES:
                raise BridgeError("File exceeds the 8 MiB limit.")
            if len(content) != expected_size:
                raise BridgeError("Guest file changed or was truncated during download.")
            return {"contentBase64": base64.b64encode(content).decode("ascii")}
        raise BridgeError("Unsupported sandbox action.")


def main():
    try:
        raw = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
        if len(raw) > 12 * 1024 * 1024:
            raise BridgeError("Request exceeds the bridge limit.")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise BridgeError("Expected an object.")
        timeout = bounded_int(request.get("timeoutSeconds", 45), 1, 330)
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(asyncio.wait_for(dispatch(request), timeout))
        response = {"ok": True, "result": result}
    except (ImportError, importlib.metadata.PackageNotFoundError):
        response = {"ok": False, "error": "Cua SDK is missing. Sync integrations/cua first."}
    except BridgeError as error:
        response = {"ok": False, "error": str(error)}
    except TimeoutError:
        response = {"ok": False, "error": "Cua request timed out. Guest completion is unknown; do not automatically retry mutations."}
    except Exception:
        # Do not return raw transport exceptions, URLs, commands or secrets.
        response = {"ok": False, "error": "Cua request failed. Verify the owned desktop and pinned SDK. Guest completion may be unknown."}
    print(json.dumps(response))
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
