"""One bounded SDK request against a verified, Perpetual-owned Cua desktop.

Node verifies Docker ownership before calling this bridge. No cloud/Localhost
fallback and no typed sandbox.driver: that accessor is Fleet-only in 0.8.0.
"""

import asyncio
import base64
import contextlib
import importlib.metadata
import json
import sys
from urllib.parse import urlsplit

SDK_VERSION = "0.8.0"
MAX_BYTES = 8 * 1024 * 1024


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


def checked_transport(api_url):
    import httpx
    from cua_sandbox.transport.http import HTTPTransport

    class CheckedHTTPTransport(HTTPTransport):
        """0.8.0 compatibility boundary: one request, strict file results,
        structured shell failures. Re-review when updating the pinned SDK.
        """

        async def _cmd(self, command, params=None):
            if self._client is None:
                raise BridgeError("Cua transport is disconnected.")
            body = {"command": command, "params": params or {}}
            timeout = httpx.Timeout(30, read=float((params or {}).get("timeout", 30)) + 10)
            # Mutations are never automatically replayed, including on HTTP 5xx.
            async with self._client.stream("POST", "/cmd", json=body, timeout=timeout) as response:
                response.raise_for_status()
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 12 * 1024 * 1024:
                        raise BridgeError("Cua response exceeded its limit; guest completion may be unknown.")
                    chunks.append(chunk)
            payload = None
            for line in b"".join(chunks).decode("utf-8").splitlines():
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

    return CheckedHTTPTransport(api_url)


async def dispatch(request):
    if importlib.metadata.version("cua-sandbox") != SDK_VERSION:
        raise BridgeError("Expected cua-sandbox 0.8.0; sync integrations/cua first.")
    from cua_sandbox import Sandbox

    url = urlsplit(request.get("apiUrl", ""))
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.path or url.query or url.fragment):
        raise BridgeError("A loopback Cua API URL is required.")
    name = request.get("name", "")
    if not isinstance(name, str) or not name.startswith("perpetual-cua-"):
        raise BridgeError("A Perpetual sandbox name is required.")
    action = request.get("action", {})
    if not isinstance(action, dict):
        raise BridgeError("Invalid sandbox action.")

    # Explicit HTTP transport bypasses all Fleet/name/host discovery. Leaving
    # this context disconnects the client, not the persistent container.
    async with Sandbox(checked_transport(request["apiUrl"]), name=name, _telemetry_enabled=False) as sandbox:
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
