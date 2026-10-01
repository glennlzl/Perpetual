"""Real owned-browser contracts for discovery on disposable loopback fixtures; no model calls."""

import asyncio
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.configure_private_runtime()

REQUESTS = []


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
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b'<!doctype html><html><body><h1>Workspace</h1><p>Balance: $12.00</p><button onclick="document.querySelector(\'h1\').textContent=\'Saved workspace\'">Save</button></body></html>')


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
