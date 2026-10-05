"""Real owned-browser contracts for discovery on disposable loopback fixtures; no model calls."""

import asyncio
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.configure_private_runtime()

REQUESTS = []
POST_REQUESTS = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        REQUESTS.append((self.server.server_port, self.path))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.other_port}/outside")
            self.end_headers()
            return
        if self.path in {"/post-read", "/post-read-redirect", "/post-read-bodyless", "/post-read-bodyless-redirect"}:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            html = b'''<!doctype html><h1>Loading</h1><button id=change>Change</button><script>
fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"read"}'})
.then(r=>r.json()).then(data=>document.querySelector('h1').textContent=data.title).catch(()=>document.querySelector('h1').textContent='Unavailable');
change.onclick=()=>Promise.all([fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"write"}'}),fetch('/private?secret=do-not-retain',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})]).catch(()=>document.querySelector('button').textContent='Blocked');
</script>'''
            if 'bodyless' in self.path:
                html = html.replace(b"headers:{'Content-Type':'application/json'},body:'{\"operation\":\"read\"}'", b'')
            if self.path.endswith('-redirect'):
                html = html.replace(b"'/rpc'", b"'/rpc-redirect'")
            self.wfile.write(html)
            return
        if self.path.startswith("/socket?port="):
            # Subscribes over a WebSocket on load and sends a change over it when the button is pressed.
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b'''<!doctype html><h1>Connecting</h1><button id=remove>Remove workspace</button><script>
const socket=new WebSocket('ws://127.0.0.1:'+new URLSearchParams(location.search).get('port')+'/live');
socket.onopen=()=>socket.send('subscribe');
socket.onmessage=event=>{document.querySelector('h1').textContent=event.data;};
remove.onclick=()=>{socket.send('remove');remove.textContent='Removal sent';};
</script>''')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b'<!doctype html><html><body><h1>Workspace</h1><p>Balance: $12.00</p><button onclick="document.querySelector(\'h1\').textContent=\'Saved workspace\'">Save</button></body></html>')

    def do_POST(self):
        POST_REQUESTS.append((self.path, self.rfile.read(int(self.headers.get("Content-Length", "0")))))
        if self.path == '/rpc-redirect':
            self.send_response(307)
            self.send_header('Location', '/rpc-write')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"title":"Workspace ready"}')


class ProtocolModelHandler(BaseHTTPRequestHandler):
    """Deterministic OpenAI-compatible fixture, not an intelligence evaluation."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        latest = request["messages"][-1]["content"]
        text = latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)
        observation = text.split("<browser_state>")[-1]
        if not self.server.observations:
            # Keep discovery alive for a real frame before this immediate loopback model
            # can finish the agent loop and trigger cleanup of its independent frame stream.
            self.server.frame_wait_timed_out = not self.server.first_frame.wait(timeout=5)
        self.server.observations.append(observation)
        if "<button" in observation and len(self.server.observations) == 1:
            # One read-only action first, so the loop observes the page it acted on.
            action = {"scroll": {"down": True}}
        else:
            data = {"cases": [{"name": "Open workspace", "goal": "Inspect the workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": []}], "summary": "Fixture workspace observed"}
            action = {"done": {"data": data}}
        content = {"evaluation_previous_goal": "Read fixture page", "memory": "Use observed page state", "next_goal": "Complete fixture goal", "action": [action]}
        response = {"id": "fixture-completion", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": json.dumps(content)}}]}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SocketModelHandler(BaseHTTPRequestHandler):
    """Deterministic fixture: once the page's subscription answered, press its button, then report."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        latest = next(message["content"] for message in reversed(request["messages"]) if "<browser_state>" in json.dumps(message["content"]))
        observation = (latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)).split("<browser_state>")[-1]
        if "Removal sent" in observation:
            action = {"done": {"data": {"cases": [{"name": "Open workspace", "goal": "Inspect the workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "See the live workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [], "evidence": []}], "summary": "Fixture workspace observed"}}}
        elif "Subscribed" in observation:
            line = next(line for line in observation.splitlines() if "<button" in line)
            found = re.search(r"(?:\[(\d+)\]|(\d+)\[:\])", line)
            action = {"click": {"index": int(found.group(1) or found.group(2))}}
        else:
            action = {"wait": {"seconds": 1}}
        content = {"evaluation_previous_goal": "Read fixture page", "memory": "Use observed page state", "next_goal": "Complete fixture goal", "action": [action]}
        response = {"id": "fixture-completion", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": json.dumps(content)}}]}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SocketContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from websockets.asyncio.server import serve
        self.received = []

        async def live(connection):
            async for message in connection:
                self.received.append(message)
                if message == "subscribe":
                    await connection.send("Subscribed")
        self.sockets = await serve(live, "127.0.0.1", 0)
        self.application = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.application.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.application.server_port}"
        self.target = f"{self.url}/socket?port={self.sockets.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.sockets.close()
        await self.sockets.wait_closed()
        self.application.shutdown()
        self.application.server_close()

    async def test_a_page_socket_reaches_its_server_while_the_agent_has_not_acted(self):
        payload = {"mode": "discover", "targetUrl": self.target, "allowedOrigins": [self.url]}
        async with runner.OwnedBrowser(payload, [].append) as owned:
            page = await owned.active_page()
            await page.get_by_role("heading", name="Subscribed", exact=True).wait_for(timeout=10000)
            await page.get_by_role("button", name="Remove workspace", exact=True).click()
            for _ in range(200):
                if "remove" in self.received:
                    break
                await asyncio.sleep(0.05)
        self.assertEqual(self.received, ["subscribe", "remove"])

    async def test_what_a_page_sends_over_a_socket_after_the_agent_acts_never_reaches_its_server(self):
        model = ThreadingHTTPServer(("127.0.0.1", 0), SocketModelHandler)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        payload = runner.validate_payload({"mode": "discover", "targetUrl": self.target, "allowedOrigins": [self.url], "maxSteps": 6, "timeoutSeconds": 40})
        events = []
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "emit", events.append):
                discovered = await asyncio.wait_for(runner.discover(payload), 45)
        finally:
            model.shutdown()
            model.server_close()
        self.assertEqual(discovered["type"], "discovery")
        actions = [event["actions"] for event in events if event["type"] == "case" and event["actions"]][-1]
        self.assertIn({"type": "click", "status": "passed"}, actions)
        # The subscription sent on load reached the server; the change the agent's click sent did not.
        self.assertEqual(self.received, ["subscribe"])


class BrowserContracts(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.outside = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.other_port = cls.outside.server_port
        for server in [cls.server, cls.outside]:
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in [cls.server, cls.outside]:
            server.shutdown()
            server.server_close()

    async def test_reviewed_post_read_loads_the_ui_but_other_operations_stay_blocked(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode":"discover", "targetUrl":url+"/post-read", "allowedOrigins":[url],
                   "readOnlyRequests":[{"url":url+"/rpc","body":'{"operation":"read"}'}]}
        events, before = [], len(POST_REQUESTS)
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            await page.get_by_role("heading",name="Workspace ready",exact=True).wait_for(timeout=3000)
            await page.get_by_role("button",name="Change",exact=True).click()
            await page.get_by_role("button",name="Blocked",exact=True).wait_for(timeout=3000)
        self.assertEqual(POST_REQUESTS[before:], [("/rpc", b'{"operation":"read"}')])
        blocked = [event for event in events if event["type"] == "blocked-request"]
        self.assertTrue(blocked)
        self.assertTrue(all(event["method"] == "POST" and event["url"] in {url+"/rpc",url+"/private"} for event in blocked))
        self.assertNotIn("do-not-retain",json.dumps(blocked))

    async def test_reviewed_read_redirect_cannot_forward_a_post_to_an_unreviewed_endpoint(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode":"discover", "targetUrl":url+"/post-read-redirect", "allowedOrigins":[url],
                   "readOnlyRequests":[{"url":url+"/rpc-redirect","body":'{"operation":"read"}'}]}
        events, before = [], len(POST_REQUESTS)
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            await page.get_by_role("heading",name="Unavailable",exact=True).wait_for(timeout=3000)
        self.assertEqual(POST_REQUESTS[before:], [("/rpc-redirect", b'{"operation":"read"}')])
        self.assertTrue(any(event['type']=='blocked-request' and event['url']==url+'/rpc-write' for event in events))

    async def test_reviewed_bodyless_bootstrap_loads_but_json_changes_stay_blocked(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode":"discover", "targetUrl":url+"/post-read-bodyless", "allowedOrigins":[url],
                   "readOnlyRequests":[{"url":url+"/rpc","body":None}]}
        events, before = [], len(POST_REQUESTS)
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            await page.get_by_role('heading',name='Workspace ready',exact=True).wait_for(timeout=3000)
            await page.get_by_role('button',name='Change',exact=True).click()
            await page.get_by_role('button',name='Blocked',exact=True).wait_for(timeout=3000)
        self.assertEqual(POST_REQUESTS[before:], [('/rpc',b'')])
        self.assertTrue(any(event['type']=='blocked-request' and event['url']==url+'/rpc' for event in events))

    async def test_reviewed_bodyless_redirect_never_reaches_a_write(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode":"discover", "targetUrl":url+"/post-read-bodyless-redirect", "allowedOrigins":[url],
                   "readOnlyRequests":[{"url":url+"/rpc-redirect","body":None}]}
        events, before = [], len(POST_REQUESTS)
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            await page.get_by_role('heading',name='Unavailable',exact=True).wait_for(timeout=3000)
        self.assertEqual(POST_REQUESTS[before:], [('/rpc-redirect',b'')])
        self.assertTrue(any(event['type']=='blocked-request' and event['url']==url+'/rpc-write' for event in events))

    async def test_reviewed_popup_read_never_follows_a_redirect(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode":"discover", "targetUrl":url, "allowedOrigins":[url],
                   "readOnlyRequests":[{"url":url+"/rpc-redirect","body":'{"operation":"read"}'}]}
        events, before = [], len(POST_REQUESTS)
        async with runner.OwnedBrowser(payload, events.append) as owned:
            page = await owned.active_page()
            async with page.expect_popup() as opened:
                await page.evaluate("() => window.open('/post-read-redirect')")
            popup = await opened.value
            await popup.get_by_role("heading",name="Unavailable",exact=True).wait_for(timeout=3000)
        self.assertEqual(POST_REQUESTS[before:], [("/rpc-redirect", b'{"operation":"read"}')])
        self.assertTrue(any(event['type']=='blocked-request' and event['url']==url+'/rpc-write' for event in events))

    async def test_real_browser_stream_and_scope(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode": "discover", "targetUrl": url, "allowedOrigins": [url]}
        events = []
        async with runner.OwnedBrowser(payload, events.append) as owned:
            profile = owned.profile.name
            self.assertIn("cases", runner.discovery_schema().model_json_schema()["properties"])
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": url}):
                agent, _ = runner.create_agent({**payload, "timeoutSeconds": 30}, owned, "Inspect the fixture", runner.discovery_schema(), "discovery", [])
            self.assertLessEqual(set(agent.tools.registry.registry.actions), runner.SAFE_ACTIONS)
            # Discovery forces a final report after two consecutive failures and keeps the agent's reasoning fields.
            self.assertEqual((agent.settings.flash_mode, agent.settings.max_failures), (False, 2))
            page = await owned.active_page()
            await page.get_by_role("button", name="Save").click()
            agent_page = await owned.browser.get_current_page()
            self.assertEqual(await agent_page.get_url(), url + "/")
            await asyncio.sleep(0.5)
            frames = [event for event in events if event["type"] == "frame"]
            self.assertTrue(any(len(event["data"]) > 1000 for event in frames))
            self.assertTrue(frames and all(event["caseId"] == "discovery" for event in frames))
            await page.evaluate("url => window.open(url)", f"http://127.0.0.1:{self.outside.server_port}/popup")
            await asyncio.sleep(0.3)
            self.assertFalse(any(port == self.outside.server_port for port, _ in REQUESTS))
            try:
                await page.goto(url + "/redirect")
            except Exception:
                pass
            self.assertFalse(any(port == self.outside.server_port for port, _ in REQUESTS))
            self.assertGreaterEqual(owned.blocked_navigations, 1)
        self.assertFalse(Path(profile).exists())

    async def test_twin_urls_reach_loopback_apps_in_the_owned_browser(self):
        # The host has no host.docker.internal entry; only the owned Chromium's resolver rule reaches the app.
        url = f"http://{runner.TWIN_HOST}:{self.server.server_port}"
        payload = {"mode": "discover", "targetUrl": url + "/credits", "allowedOrigins": [url]}
        async with runner.OwnedBrowser(payload, [].append) as owned:
            page = await owned.active_page()
            self.assertEqual(page.url, url + "/credits")
            self.assertEqual(await page.get_by_text("Balance").count(), 1)
        self.assertIn((self.server.server_port, "/credits"), REQUESTS)

    async def test_an_unreachable_application_and_a_missing_report_are_named(self):
        import socket
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        unreachable = f"http://127.0.0.1:{closed.getsockname()[1]}"
        closed.close()
        with self.assertRaises(runner.InputError) as caught:
            async with runner.OwnedBrowser({"mode": "discover", "targetUrl": unreachable + "/", "allowedOrigins": [unreachable]}, [].append):
                pass
        self.assertEqual(runner.safe_error(caught.exception), "The application could not be opened: net::ERR_CONNECTION_REFUSED.")

        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = runner.validate_payload({"mode": "discover", "targetUrl": url, "allowedOrigins": [url], "maxSteps": 2, "timeoutSeconds": 30})

        async def ended_without_report(agent, **_):
            # As when Browser Use cancels every model call at its own timeout: no report and no model error.
            return agent.history
        with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": url}), patch.object(runner, "emit", [].append), patch("browser_use.Agent.run", ended_without_report):
            with self.assertRaises(runner.InputError) as caught:
                await runner.discover(payload)
        self.assertEqual(runner.safe_error(caught.exception), "The agent did not produce a valid discovery result.")

    async def test_tools_have_no_files_shell_or_evaluate(self):
        tools = runner.safe_tools(runner.discovery_schema())
        names = set(tools.registry.registry.actions)
        self.assertLessEqual(names, runner.SAFE_ACTIONS)
        self.assertIn("click", names)
        self.assertIn("done", names)
        self.assertFalse(names & {"evaluate", "read_file", "write_file", "upload_file", "save_as_pdf", "search", "extract"})

    async def test_cancellation_closes_owned_browser_and_next_case_is_fresh(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode": "discover", "targetUrl": url, "allowedOrigins": [url]}
        started = asyncio.Event()
        captured = {}

        async def activity():
            async with runner.OwnedBrowser(payload, lambda _: None) as owned:
                captured["profile"] = owned.profile.name
                captured["page"] = await owned.active_page()
                await captured["page"].evaluate("() => localStorage.setItem('fixture', 'previous-case')")
                started.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(activity())
        await asyncio.wait_for(started.wait(), 20)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 15)
        self.assertTrue(captured["page"].is_closed())
        self.assertFalse(Path(captured["profile"]).exists())
        async with runner.OwnedBrowser(payload, lambda _: None) as owned:
            page = await owned.active_page()
            self.assertIsNone(await page.evaluate("() => localStorage.getItem('fixture')"))

    async def test_real_agent_loop_with_protocol_fixture_and_reviewable_discovery(self):
        model_server = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolModelHandler)
        model_server.observations = []
        model_server.first_frame = threading.Event()
        model_server.frame_wait_timed_out = False
        threading.Thread(target=model_server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = runner.validate_payload({"mode": "discover", "targetUrl": url, "allowedOrigins": [url], "maxSteps": 4, "timeoutSeconds": 30})
        events = []

        def emitted(event):
            events.append(event)
            if event["type"] == "frame":
                model_server.first_frame.set()

        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model_server.server_port}/v1"}), patch.object(runner, "emit", emitted):
                discovered = await asyncio.wait_for(runner.discover(payload), 35)
                self.assertFalse(model_server.frame_wait_timed_out, "Discovery did not emit a real browser frame within 5 seconds.")
                self.assertGreaterEqual(len(model_server.observations), 2)
                self.assertTrue(any(event.get("actions") and event["actions"][0] == {"type": "scroll", "status": "passed"} for event in events))
                self.assertTrue(any(event["type"] == "frame" for event in events))
                self.assertEqual(discovered["type"], "discovery")
                self.assertFalse(discovered["cases"][0]["selected"])
                self.assertTrue(discovered["cases"][0]["needsReview"])
                self.assertEqual(len(discovered["cases"][0]["steps"]), 2)
                self.assertEqual(discovered["cases"][0]["isolation"], "shared")
                self.assertIs(discovered["authenticated"], False)
        finally:
            model_server.shutdown()
            model_server.server_close()


if __name__ == "__main__":
    unittest.main()
