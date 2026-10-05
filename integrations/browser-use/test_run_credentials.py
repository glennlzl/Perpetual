"""Ephemeral credentials against a disposable application and protocol model."""

import asyncio
import io
import json
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs
from unittest.mock import patch

import runner
from run_credentials import redact, validate_credentials

runner.configure_private_runtime()
ACCOUNT = {"username": "ephemeral-test@example.invalid", "password": "fixture-only-password-43"}


class Redaction(unittest.TestCase):
    def test_account_values_are_redacted_as_the_page_shows_them(self):
        account = {"username": "Owner@Example.invalid ", "password": "  Zq7-" + "long-fixture-password-" * 6}
        shown = account["password"].strip()
        for text, expected in [
            ("Signed in as Owner@Example.invalid.", "Signed in as [REDACTED]."),
            ("Signed in as owner@example.invalid", "Signed in as [REDACTED]"),
            # Browser Use strips a field's value and clips it to 100 characters.
            (f"<input type=text id=password value={shown[:100]}...>", "<input type=text id=password value=[REDACTED]...>"),
            (f"Rejected value: {account['password']}", "Rejected value: [REDACTED]"),
        ]:
            with self.subTest(text=text[:40]):
                self.assertEqual(redact(text, account), expected)

    def test_a_common_word_account_keeps_the_adapter_names_whole(self):
        account = {"username": "test", "password": "password"}
        instructions = redact(runner.CREDENTIAL_INSTRUCTIONS, account)
        for name in ["call sign_in_with_test_account", "<secret>perpetual_test_username</secret>", "<secret>perpetual_test_password</secret> only in a [REDACTED] field"]:
            self.assertIn(name, instructions)
        self.assertEqual(redact("<input type=password name=Password>", account), "<input type=[REDACTED] name=[REDACTED]>")
        # A value that merely contains or equals one of those names is redacted whole.
        for value in ["xperpetual_test_passwordx", "perpetual_test_password"]:
            with self.subTest(value=value):
                self.assertEqual(redact(f"Shown: {value}", {"username": "owner@example.invalid", "password": value}), "Shown: [REDACTED]")

    def test_proposals_and_their_summary_never_keep_an_account_value(self):
        class Proposal:
            name = "Reopen saved work"

            def model_dump(self):
                return {"name": self.name, "goal": f"Sign in as {ACCOUNT['username'].upper()} and reopen saved work", "steps": [{"id": "open", "title": "Open"}, {"id": "reopen", "title": "Reopen"}],
                        "preconditions": [], "expectedOutcomes": ["Saved work is visible"], "assertions": [], "evidence": []}
        payload = runner.validate_payload({"mode": "discover", "targetUrl": "http://127.0.0.1:3010/", "credentials": ACCOUNT})
        cases, summary = runner.accepted_proposals(payload, [Proposal()], f"Signed in as {ACCOUNT['username']}.")
        self.assertEqual(cases[0]["goal"], "Sign in as [REDACTED] and reopen saved work")
        self.assertEqual(summary, "Signed in as [REDACTED].")


class CredentialValidation(unittest.TestCase):
    def test_only_a_valid_discovery_account_is_accepted(self):
        self.assertEqual(validate_credentials(ACCOUNT, "discover"), ACCOUNT)
        self.assertIsNone(validate_credentials(None, "discover"))
        for value, mode in [(ACCOUNT, "preflight"), (ACCOUNT, "run"), ({**ACCOUNT, "url": "bad"}, "discover"), ({**ACCOUNT, "username": ""}, "discover"), ({**ACCOUNT, "password": "x" * 1025}, "discover")]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                validate_credentials(value, mode)


class CredentialGuards(unittest.IsolatedAsyncioTestCase):
    async def test_only_matching_top_frame_login_fields_can_receive_secrets(self):
        from pydantic import BaseModel
        from browser_use import Tools
        report = runner.discovery_schema()
        origin = "http://127.0.0.1:3010"
        tools = runner.safe_tools(report, [origin], ACCOUNT, origin)
        node = SimpleNamespace(target_id="target", frame_id="top", node_name="INPUT", attributes={"type": "password"})
        frame = {"id": "top", "url": origin + "/login"}

        async def frame_tree(**_):
            return {"frameTree": {"frame": frame}}

        async def session():
            return SimpleNamespace(session_id="session", cdp_client=SimpleNamespace(send=SimpleNamespace(Page=SimpleNamespace(getFrameTree=frame_tree))))

        async def element(_):
            return node

        browser = SimpleNamespace(agent_focus_target_id="target", get_or_create_cdp_session=session, get_element_by_index=element)

        class Action(BaseModel):
            input: dict | None = None
            navigate: dict | None = None
            done: dict | None = None

        allowed = Action(input={"index": 1, "text": "<secret>perpetual_test_password</secret>"})
        forwarded_actions = []

        async def accepted(_tools, action, *_, **kwargs):
            forwarded_actions.append((action.model_dump(exclude_none=True), kwargs.get("sensitive_data")))
            return SimpleNamespace(error=None)

        with patch.object(Tools, "act", accepted):
            self.assertIsNone((await tools.act(allowed, browser)).error)
            for change, expected_code in [("port", "credential_origin_mismatch"), ("field", "credential_field_type_mismatch"), ("frame", "credential_frame_mismatch"), ("target", "credential_target_mismatch")]:
                frame["url"] = origin + "/login"
                node.attributes = {"type": "password"}
                node.frame_id, node.target_id = "top", "target"
                if change == "port": frame["url"] = "http://127.0.0.1:3011/login"
                if change == "field": node.attributes = {"type": "text"}
                if change == "frame": node.frame_id = "embedded"
                if change == "target": node.target_id = "popup"
                result = await tools.act(allowed, browser)
                self.assertIsNotNone(result.error, change)
                self.assertEqual(result.metadata["perpetualErrorCode"], expected_code)
                self.assertEqual(runner.action_progress("input", result), {"type": "input", "status": "failed", "errorCode": expected_code})
            for action in [Action(navigate={"url": origin + "/?value=<secret>perpetual_test_password</secret>"}), Action(input={"index": 1, "text": "prefix <secret>perpetual_test_password</secret>"}), Action(input={"index": 1, "text": ACCOUNT["password"]}), Action(input={"index": 1, "text": "<secret>unknown</secret>"})]:
                self.assertIsNotNone((await tools.act(action, browser)).error)
            # A report that names the account passes unchanged; it is never rejected toward max_failures or substituted.
            forwarded_actions.clear()
            blocked = {"reached": False, "evidence": "Signed in as perpetual_test_username", "blockers": [{"stepId": "sign-in", "kind": "account", "evidence": "<secret>perpetual_test_username</secret> has no paid plan"}]}
            for action in [Action(done={"text": "perpetual_test_password"}), Action(done={"success": True, "data": blocked})]:
                self.assertIsNone((await tools.act(action, browser)).error)
                self.assertEqual(forwarded_actions[-1], (action.model_dump(exclude_none=True), None))


class Application(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b'<!doctype html><html><body><h1>Sign in</h1><form method="POST" action="/login"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form></body></html>'
        self.respond(body)

    def do_POST(self):
        values = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        self.server.login_ok = values == {"email": [ACCOUNT["username"]], "password": [ACCOUNT["password"]]}
        if self.server.login_ok:
            body = f'<!doctype html><html><body><h1>Workspace ready</h1><p>{ACCOUNT["username"]}</p><p>{ACCOUNT["username"].upper()}</p><p>{ACCOUNT["password"]}</p></body></html>'.encode()
        else:
            body = b"<h1>Login failed</h1>"
        self.respond(body)

    def respond(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProtocolModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(request)
        latest = next(message["content"] for message in reversed(request["messages"]) if "<browser_state>" in json.dumps(message["content"]))
        text = latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)
        observation = text.split("<browser_state>")[-1]
        step = len(self.server.requests)
        def index(kind):
            for line in observation.splitlines():
                if kind in line:
                    found = re.search(r'(?:\[(\d+)\]|(\d+)\[:\])', line)
                    if found:
                        return int(found.group(1) or found.group(2))
            raise AssertionError("Expected login control missing")
        if "Workspace ready" in observation:
            action = {"done": {"data": {"cases": [{"name": "Use the authenticated workspace", "goal": "Sign in and use the workspace", "steps": [{"id": "sign-in", "title": "Sign in with the test account"}, {"id": "workspace", "title": "Reach the ready workspace"}], "preconditions": ["A run-only test account"], "expectedOutcomes": ["Workspace ready is visible"], "assertions": [{"type": "text-visible", "value": "Workspace ready"}], "evidence": []}], "summary": "Signed in and observed the ready workspace"}}}
        elif step == 1:
            action = {"input": {"index": index('type=email'), "text": "<secret>perpetual_test_username</secret>"}}
        elif step == 2:
            action = {"input": {"index": index('type=password'), "text": "<secret>perpetual_test_password</secret>"}}
        else:
            action = {"click": {"index": index('<button')}}
        content = {"evaluation_previous_goal": "Observe login fixture", "memory": "Test login", "next_goal": "Reach workspace", "action": [action]}
        response = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": json.dumps(content)}}]}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class AuthenticatedDiscovery(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_signs_in_only_through_the_configured_endpoint(self):
        application = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        application.login_ok = False
        model = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolModel)
        model.requests = []
        for server in [application, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{application.server_port}"
        requirements = "Never send external messages or alter production services."
        payload = runner.validate_payload({"mode": "discover", "targetUrl": origin, "credentials": ACCOUNT, "authEndpoints": [origin + "/login"], "requirements": requirements, "maxSteps": 6, "timeoutSeconds": 50})
        output = io.StringIO()
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "STDOUT", output):
                result = await asyncio.wait_for(runner.discover(payload), 55)
            self.assertTrue(application.login_ok, "The configured sign-in request did not reach the application")
            self.assertIs(result["authenticated"], True)
            self.assertTrue(result["cases"][0]["needsReview"])
            self.assertFalse(result["cases"][0]["selected"])
            # The page shows the account after signing in, the username also in capitals; the model never receives its
            # values or a screenshot.
            self.assertNotIn('"image_url"', json.dumps(model.requests))
            for value in [*ACCOUNT.values(), ACCOUNT["username"].upper()]:
                self.assertNotIn(value, json.dumps(model.requests))
            for request in model.requests:
                self.assertIn(requirements, json.dumps(request["messages"]))
            self.assertTrue(any(json.loads(line)["type"] == "frame" for line in output.getvalue().splitlines()))
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
