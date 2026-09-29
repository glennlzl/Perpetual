"""sign_in_with_test_account against disposable sign-in pages in the owned Chromium.

The only model is a local, deterministic protocol fixture; it checks the Agent integration, not model reasoning.
"""

import asyncio
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from pydantic import BaseModel

import runner
import sign_in

runner.configure_private_runtime()
ACCOUNT = {"username": "ephemeral-test@example.invalid", "password": "fixture-only-password-43"}


def html(body, script=""):
    return f'<!doctype html><html><body style="margin:0">{body}<script>{script}</script></body></html>'.encode()


# No <form>: the app signs in with fetch and replaces its form, or echoes the rejected account and keeps the fields filled.
SPA = """document.getElementById('go').addEventListener('click', async () => {
  const email = document.getElementById('email').value, password = document.getElementById('password').value;
  const response = await fetch('%s', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password})});
  if (response.ok) { history.pushState({}, '', '/workspace'); document.querySelector('main').innerHTML = '<h1>Workspace ready</h1>'; }
  else document.getElementById('status').textContent = 'No account for ' + email;
});"""
SPA_BODY = '<header><input id="search" placeholder="Search"></header><main><div><input type="email" id="email" style="display:block;width:400px;height:40px"><input type="password" id="password" style="display:block;width:400px;height:40px"><button id="go">Sign in</button><p id="status" role="alert" style="font-size:32px"></p></div></main>'
PAGES = {
    "/email": html('<h1>Sign in</h1><form method="POST" action="/login"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>'),
    # A plain text username. Pressing the show-password toggle would clear the password, so a login proves it was never pressed.
    "/username": html('<form method="POST" action="/login"><label>User <input name="user"></label><input type="password" name="password" id="password"><button type="button" onclick="document.getElementById(\'password\').value=\'\'">Show</button><label><input type="checkbox" name="remember">Remember me</label><button>Continue</button></form>'),
    # Enter cannot submit while the only button is disabled; it is enabled once both fields hold values.
    "/disabled": html('<form method="POST" action="/login"><input type="email" name="email"><input type="password" name="password"><button type="submit" disabled>Sign in</button></form>', "const form = document.querySelector('form'); form.addEventListener('input', () => { form.querySelector('button').disabled = !(form.email.value && form.password.value); });"),
    "/spa": html(SPA_BODY, SPA % "/api/login"),
    "/spa-reject": html(SPA_BODY, SPA % "/api/reject"),
    # A search form and a sign-up form come first; only the sign-in form may receive the account.
    "/two": html('<form action="/search"><input name="q" placeholder="Search"></form><form method="POST" action="/signup"><input type="email" name="email"><input type="password" name="password"><input type="password" name="confirm"><button>Create account</button></form><form method="POST" action="/login"><input name="login" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>'),
    "/none": html('<h1>Welcome</h1><form action="/search"><input type="search" name="q"><input name="topic"></form>'),
    "/password-only": html('<form method="POST" action="/login"><input type="password" name="password"><button>Continue</button></form>'),
}


class Application(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.gets.append(urlsplit(self.path).path)
        self.respond(PAGES.get(urlsplit(self.path).path, html("<h1>Not found</h1>")))

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        values = json.loads(body) if path.startswith("/api/") else {key: value[0] for key, value in parse_qs(body).items()}
        self.server.posts.append((path, values))
        accepted = sorted(values.values()) == sorted(ACCOUNT.values())
        if path.startswith("/api/"):
            self.respond(b"{}", "application/json", 200 if path == "/api/login" and accepted else 401)
        else:
            self.respond(html("<h1>Workspace ready</h1>" if path == "/login" and accepted else "<h1>Sign-in failed</h1>"))

    def respond(self, body, kind="text/html", status=200):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.gets, server.posts = [], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


class SignInForms(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        (cls.app, cls.url), (cls.other, cls.other_url) = serve(Application), serve(Application)

    @classmethod
    def tearDownClass(cls):
        for server in [cls.app, cls.other]:
            server.shutdown()
            server.server_close()

    def setUp(self):
        # Another test module re-enables logging; keep Browser Use quiet here in any order.
        runner.configure_private_runtime()
        for server in [self.app, self.other]:
            server.gets.clear()
            server.posts.clear()

    def browser(self, path, endpoints=("/login", "/api/login", "/api/reject"), **extra):
        # Discovery lets the account's POST reach only a configured sign-in endpoint.
        payload = {"mode": "discover", "targetUrl": self.url + path, "allowedOrigins": [self.url], "credentials": ACCOUNT, "authEndpoints": [self.url + endpoint for endpoint in endpoints], **extra}
        return runner.OwnedBrowser(payload, [].append)

    async def test_fills_and_submits_the_sign_in_form_of_each_page(self):
        async with self.browser("/email") as owned:
            page = await owned.active_page()
            for path, endpoint, fields in [("/email", "/login", {"email", "password"}), ("/username", "/login", {"user", "password"}), ("/disabled", "/login", {"email", "password"}), ("/two", "/login", {"login", "password"}), ("/spa", "/api/login", {"email", "password"})]:
                with self.subTest(path=path):
                    self.app.posts.clear()
                    await page.goto(self.url + path)
                    self.assertEqual(await owned.sign_in(), {"result": "signed_in"})
                    self.assertEqual(len(self.app.posts), 1, self.app.posts)
                    posted, values = self.app.posts[0]
                    self.assertEqual((posted, set(values)), (endpoint, fields))
                    self.assertEqual(sorted(values.values()), sorted(ACCOUNT.values()))
                    self.assertTrue(await page.get_by_text("Workspace ready").is_visible())
            # Neither the other forms nor the search fields received the account.
            self.assertEqual(await page.input_value("#search"), "")
            self.assertNotIn("/search", self.app.gets)

    async def test_pages_without_a_sign_in_form_are_left_untouched(self):
        async with self.browser("/none") as owned:
            page = await owned.active_page()
            for path in ["/none", "/password-only"]:
                with self.subTest(path=path):
                    await page.goto(self.url + path)
                    self.assertEqual(await owned.sign_in(), {"result": "no_sign_in_form", "code": "credential_field_unavailable"})
                    self.assertEqual([await field.input_value() for field in await page.locator("input").all()], [""] * await page.locator("input").count())
            self.assertEqual(self.app.posts, [])

    async def test_a_rejected_account_reports_page_text_the_model_receives_redacted(self):
        async with self.browser("/spa-reject") as owned:
            page = await owned.active_page()
            with patch.object(sign_in, "SIGN_IN_SECONDS", 2):
                result = await owned.sign_in()
            self.assertEqual(result, {"result": "still_on_sign_in", "code": "browser_action_failed", "message": "No account for [REDACTED]"})
            self.assertEqual([path for path, _ in self.app.posts], ["/api/reject"])
            # The fields keep the account, and the page echoes it.
            self.assertEqual(await page.input_value("#email"), ACCOUNT["username"])
        reply = runner.sign_in_reply(result)
        self.assertLessEqual(len(reply), 200)
        for value in ACCOUNT.values():
            self.assertNotIn(value, json.dumps(result) + reply)

    async def test_account_values_stay_on_the_application_origin(self):
        async with self.browser("/email", allowedOrigins=[self.url, self.other_url]) as owned:
            page = await owned.active_page()
            await page.goto(self.other_url + "/email")
            self.assertEqual(await owned.sign_in(), {"result": "error", "code": "credential_origin_mismatch"})
            self.assertEqual([await page.input_value(selector) for selector in ["input[type=email]", "input[type=password]"]], ["", ""])
        self.assertEqual(self.other.posts, [])

    async def test_a_sign_in_reports_the_path_of_the_page_its_form_was_on(self):
        events = []
        payload = {"mode": "discover", "targetUrl": self.url + "/none", "allowedOrigins": [self.url], "credentials": ACCOUNT, "authEndpoints": [self.url + endpoint for endpoint in ("/login", "/api/login", "/api/reject")]}
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            # The SPA replaces its form and its address after it signs in; the page the form was on is reported, unless
            # it has a hash, whose path alone may not show the form.
            for path in ["/email?next=%2Fworkspace&token=abc", "/email#top", "/spa"]:
                with self.subTest(path=path):
                    await page.goto(self.url + path)
                    self.assertEqual(await owned.sign_in(), {"result": "signed_in"})
            # A sign-in that did not happen reports nothing.
            with patch.object(sign_in, "SIGN_IN_SECONDS", 1):
                for path in ["/none", "/spa-reject"]:
                    await page.goto(self.url + path)
                    self.assertNotEqual((await owned.sign_in())["result"], "signed_in")
        reported = [event for event in events if event["type"] != "frame"]
        self.assertEqual(reported, [{"type": "sign-in-page", "caseId": "discovery", "url": self.url + path} for path in ["/email", "/spa"]])
        for value in ACCOUNT.values():
            self.assertNotIn(value, json.dumps(reported))

    def test_only_the_path_of_a_sign_in_page_on_the_application_origin_is_kept(self):
        application = runner.origin(self.url)
        for url, kept in [(self.url + "/account/sign-in?next=%2F&token=abc", self.url + "/account/sign-in"), (self.url, self.url + "/"), (self.url + "/login#", self.url + "/login"),
                          (self.url + "/account/sign-in?next=%2F#form", None), (self.url + "/#/login", None),
                          # Path parameters, such as a servlet session id, can carry tokens too.
                          (self.url + "/login;jsessionid=0123ABCD?next=/x", self.url + "/login"), (self.url + "/app;v=2/login;jsessionid=0123ABCD", self.url + "/app/login"),
                          # Dropping them from the first segment leaves one leading slash, never a // path another host could be read from.
                          (self.url + "/;jsessionid=0123ABCD/login", self.url + "/login"), (self.url + "//login", self.url + "/login"),
                          (self.url.replace("http://", "http://user:secret@") + "/login", None), (self.other_url + "/login", None), ("https://127.0.0.1/login", None),
                          ("not a url", None), ("javascript:alert(1)", None), (None, None), (42, None), (self.url + "/" + "x" * 2048, None)]:
            with self.subTest(url=url):
                self.assertEqual(runner.sign_in_page(url, application), kept)

    async def test_discovery_submits_only_to_a_configured_sign_in_endpoint(self):
        async with self.browser("/email", endpoints=("/login",)) as owned:
            self.assertEqual(await owned.sign_in(), {"result": "signed_in"})
            self.assertEqual(owned.auth_exchanges, 1)
        self.assertEqual([path for path, _ in self.app.posts], ["/login"])
        self.app.posts.clear()
        # Without that endpoint the POST is blocked, leaving the browser's own error page.
        async with self.browser("/email", endpoints=()) as owned:
            self.assertEqual(await owned.sign_in(), {"result": "error", "code": "navigation_not_allowed"})
            self.assertEqual(owned.auth_exchanges, 0)
        self.assertEqual(self.app.posts, [])


class SignInTool(unittest.IsolatedAsyncioTestCase):
    async def test_only_an_account_offers_the_action_and_its_replies_are_value_free(self):
        from browser_use import Tools
        report = runner.discovery_schema()
        origin = "http://127.0.0.1:3010"
        outcomes = []

        async def fake_sign_in():
            return outcomes[-1]

        self.assertNotIn("sign_in_with_test_account", runner.safe_tools(report, [origin], None, origin, sign_in=fake_sign_in).registry.registry.actions)
        self.assertNotIn("sign_in_with_test_account", runner.safe_tools(report, [origin], ACCOUNT, origin).registry.registry.actions)
        tools = runner.safe_tools(report, [origin], ACCOUNT, origin, sign_in=fake_sign_in)
        self.assertLessEqual(set(tools.registry.registry.actions), runner.SAFE_ACTIONS)

        class Action(BaseModel):
            sign_in_with_test_account: dict | None = None

        forwarded = {}

        async def execute(self_tools, action, _browser, *_, **kwargs):
            # The scoped allowlist and credential guards ran; Browser Use would now execute the registered action.
            forwarded.update(kwargs)
            return await self_tools.registry.execute_action("sign_in_with_test_account", action.model_dump(exclude_none=True)["sign_in_with_test_account"])

        page_text = "x" * sign_in.MESSAGE_LIMIT
        for outcome, status, code in [({"result": "signed_in"}, "passed", None), ({"result": "still_on_sign_in", "code": "browser_action_failed", "message": page_text}, "failed", "browser_action_failed"), ({"result": "no_sign_in_form", "code": "credential_field_unavailable"}, "failed", "credential_field_unavailable"), ({"result": "error", "code": "credential_origin_mismatch"}, "failed", "credential_origin_mismatch"), ({"result": "error", "code": "navigation_not_allowed"}, "failed", "navigation_not_allowed")]:
            with self.subTest(outcome=outcome["result"], code=code):
                outcomes.append(outcome)
                with patch.object(Tools, "act", execute):
                    result = await tools.act(Action(sign_in_with_test_account={}), SimpleNamespace())
                # Browser Use never substitutes placeholders for this action; values come only from the run-only account.
                self.assertIsNone(forwarded["sensitive_data"])
                reply = result.extracted_content if status == "passed" else result.error
                self.assertTrue(reply.startswith(f"Sign-in result: {outcome['result']}. "), reply)
                # Browser Use shows the model only 200 characters of an error.
                self.assertLessEqual(len(reply), 200)
                self.assertEqual(runner.action_progress("sign_in_with_test_account", result), {"type": "sign_in_with_test_account", "status": status, **({"errorCode": code} if code else {})})
        self.assertTrue(result.error.endswith(runner.ACTION_FAILURES["navigation_not_allowed"]))


class ProtocolModel(BaseHTTPRequestHandler):
    """Signs in with the action, then reports what the page shows."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(request)
        latest = next(message["content"] for message in reversed(request["messages"]) if "<browser_state>" in json.dumps(message["content"]))
        observation = (latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)).split("<browser_state>")[-1]
        if "Workspace ready" in observation:
            action = {"done": {"data": {"cases": [{"name": "Use the authenticated workspace", "goal": "Sign in and use the workspace", "steps": [{"id": "sign-in", "title": "Sign in with the test account"}, {"id": "workspace", "title": "Reach the ready workspace"}], "preconditions": ["A run-only test account"], "expectedOutcomes": ["Workspace ready is visible"], "assertions": [{"type": "text-visible", "value": "Workspace ready"}], "evidence": []}], "summary": "Signed in and observed the ready workspace"}}}
        else:
            action = {"sign_in_with_test_account": {}}
        content = {"evaluation_previous_goal": "Observe the page", "memory": "Sign in", "next_goal": "Reach the workspace", "action": [action]}
        body = json.dumps({"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": json.dumps(content)}}]}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class AgentSignIn(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runner.configure_private_runtime()

    async def discovery(self):
        (application, url), (model, model_url) = serve(Application), serve(ProtocolModel)
        model.requests = []
        payload = runner.validate_payload({"mode": "discover", "targetUrl": url + "/disabled", "credentials": ACCOUNT, "authEndpoints": [url + "/login"], "maxSteps": 4, "timeoutSeconds": 40})
        output = io.StringIO()
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": model_url + "/v1"}), patch.object(runner, "STDOUT", output):
                result = await asyncio.wait_for(runner.discover(payload), 45)
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()
        requests = json.dumps(model.requests)
        # The agent is told to use the action, keeps the placeholder fallback, and sees a value-free result without images.
        self.assertIn("call sign_in_with_test_account", requests)
        self.assertIn("<secret>perpetual_test_password</secret> only in a password field", requests)
        self.assertIn("Sign-in result: signed_in.", requests)
        self.assertNotIn('"image_url"', requests)
        for value in ACCOUNT.values():
            self.assertNotIn(value, requests)
        self.assertEqual([path for path, _ in application.posts], ["/login"])
        return result, [json.loads(line) for line in output.getvalue().splitlines()], url

    async def test_discovery_signs_in_with_the_action_through_its_configured_endpoint(self):
        result, events, url = await self.discovery()
        self.assertIs(result["authenticated"], True)
        self.assertEqual((result["cases"][0]["selected"], result["cases"][0]["needsReview"]), (False, True))
        actions = [event["actions"] for event in events if event["type"] == "case" and event["actions"]][-1]
        self.assertEqual(actions[0], {"type": "sign_in_with_test_account", "status": "passed"})
        self.assertTrue(any(event["type"] == "frame" for event in events))
        # The worker reports the page the form was on, which the controller can keep as the stage's sign-in page.
        self.assertEqual([event for event in events if event["type"] == "sign-in-page"], [{"type": "sign-in-page", "caseId": "discovery", "url": url + "/disabled"}])


if __name__ == "__main__":
    unittest.main()
