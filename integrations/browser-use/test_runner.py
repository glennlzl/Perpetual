import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).parent


class RuntimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("perpetual_browser_runner", HERE / "runner.py")
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def payload(self):
        return {"mode": "discover", "targetUrl": "http://127.0.0.1:3010/", "allowedOrigins": ["http://127.0.0.1:3010"]}

    def case(self):
        return {"id": "one", "name": "Open workspace", "goal": "Open the workspace", "preconditions": [],
                "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}]}

    def test_private_runtime_never_probes_the_desktop_display(self):
        import os
        import sys
        saved = {name: sys.modules.pop(name, "missing") for name in ("AppKit", "screeninfo")}
        try:
            with patch.dict(os.environ, {}, clear=False):
                self.runner.configure_private_runtime()
            for name in ("AppKit", "screeninfo"):
                with self.assertRaises(ImportError):
                    __import__(name)
        finally:
            for name, module in saved.items():
                if module == "missing":
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
            import logging
            logging.disable(logging.NOTSET)

    def test_navigation_origin_is_exact_not_a_prefix_or_another_port(self):
        allowed = {"http://127.0.0.1:3010", "https://example.com"}
        self.assertTrue(self.runner.navigation_allowed("https://example.com/other", allowed))
        for url in ["http://127.0.0.1:30100/", "http://localhost:3010/", "http://host.docker.internal:3010/", "http://[::1]:3010/", "https://example.com.evil.test/", "https://example.com:8443/", "file:///tmp/private", "data:text/html,hi"]:
            self.assertFalse(self.runner.navigation_allowed(url, allowed))

    def test_the_agent_never_runs_a_journey(self):
        # Runs execute approved Playwright code; the agent only discovers journeys.
        for mode in ["run", "execute", None]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.runner.validate_payload({**self.payload(), "mode": mode, "case": self.case()})
        for name in ["run_journey", "run_task", "milestone_task", "BrowserUseActor", "drive", "RUN_INSTRUCTIONS", "STRIPE_INSTRUCTIONS", "UNAVAILABLE_SERVICES", "failure_limit", "payment_live_url"]:
            self.assertFalse(hasattr(self.runner, name), name)
        self.assertNotIn("payment_live_mode_rejected", self.runner.ACTION_FAILURES)
        self.assertNotIn("reload_page", self.runner.SAFE_ACTIONS)
        self.assertEqual(self.runner.OwnedBrowser(self.payload()).case_id, "discovery")

    def test_discovery_input_is_bounded_and_copied(self):
        original = {**self.payload(), "scope": "Billing", "requirements": "Never email real customers", "maxSteps": 100}
        validated = self.runner.validate_payload(original)
        self.assertEqual((validated["maxSteps"], validated["timeoutSeconds"], validated["authEndpoints"]), (100, 300, []))
        original["allowedOrigins"].append("http://127.0.0.1:3011")
        self.assertEqual(validated["allowedOrigins"], ["http://127.0.0.1:3010"])
        for change in [{"maxSteps": 101}, {"maxSteps": 0}, {"timeoutSeconds": 1801}, {"scope": "x" * 8001}, {"allowedOrigins": ["http://127.0.0.1:3011"]}, {"allowedOrigins": ["http://127.0.0.1:3010/app"]}, {"targetUrl": None}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.runner.validate_payload({**self.payload(), **change})

    def test_proposed_journeys_are_validated_as_reviewable_cases(self):
        case = self.case()
        validated = self.runner.validate_case(case)
        case["assertions"][0]["value"] = "tampered"
        self.assertEqual(validated["assertions"][0]["value"], "Workspace")
        self.assertEqual(validated["isolation"], "shared")
        steps = [{"id": "start", "title": "Confirm starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}, {"id": "run", "title": "Run and see credits decrease", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}, {"type": "url-contains", "value": "/runs/"}]}]
        self.assertEqual(self.runner.validate_case({**self.case(), "steps": steps})["steps"], steps)
        for change in [{"goal": ""}, {"expectedOutcomes": []}, {"assertions": [{"type": "execute-js", "value": "1"}]}, {"steps": [{"type": "click", "selector": "#submit"}]},
                       {"steps": [steps[0], {**steps[1], "checks": [{**steps[1]["checks"][0], "than": "later"}]}]}, {"isolation": "private"}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.runner.validate_case({**self.case(), **change})

    def test_discovery_accepts_run_only_credentials_and_same_host_sign_in_endpoints(self):
        account = {"username": "ephemeral@example.invalid", "password": "fixture-only-password"}
        payload = {"mode": "discover", "targetUrl": "http://127.0.0.1:55887/login", "allowedOrigins": ["http://127.0.0.1:55887"], "credentials": account, "authEndpoints": ["http://127.0.0.1:55888/auth/v1/token", "HTTP://127.0.0.1:55887/login?next=/"]}
        validated = self.runner.validate_payload(payload)
        self.assertEqual(validated["credentials"], account)
        self.assertEqual(validated["authEndpoints"], ["http://127.0.0.1:55888/auth/v1/token", "http://127.0.0.1:55887/login?next=/"])
        allowed = self.runner.endpoint_allowed
        self.assertTrue(allowed("http://127.0.0.1:55888/auth/v1/token?grant_type=password", validated["authEndpoints"]))
        self.assertTrue(allowed("http://127.0.0.1:55887/login?next=/workflows", validated["authEndpoints"]))
        self.assertTrue(allowed("http://127.0.0.1:55888/auth/v1/token/refresh", validated["authEndpoints"]))
        # Endpoints match whole path segments, never a sibling path that shares a prefix.
        for url in ["http://127.0.0.1:558880/auth/v1/token", "http://127.0.0.1:55888/auth/v1/user", "http://127.0.0.1:55888/auth/v1/token-revoke", "http://127.0.0.1:55888/auth/v1/tokens?grant_type=password", "https://127.0.0.1:55888/auth/v1/token", "http://127.0.0.1:55887/login", "http://127.0.0.1:55887/login-admin?next=/", "not a url"]:
            self.assertFalse(allowed(url, validated["authEndpoints"]), url)
        # A bare origin would admit every POST on that port.
        for endpoints in ["http://127.0.0.1:55888/auth", ["http://127.0.0.1:55888"], ["http://127.0.0.1:55888/"], ["http://127.0.0.1:55888/?next=/"], ["http://127.0.0.1:55888/a"] * 4, ["http://example.com/auth"], ["http://user:pass@127.0.0.1:55888/auth"], ["/auth/v1/token"], ["ftp://127.0.0.1/auth"], ["http://127.0.0.1:55888/auth#token"], [1]]:
            with self.subTest(endpoints=endpoints), self.assertRaises(ValueError):
                self.runner.validate_payload({**payload, "authEndpoints": endpoints})

    def test_twin_sign_in_accepts_loopback_host_aliases_without_expanding_endpoint_access(self):
        account = {"username": "ephemeral@example.invalid", "password": "fixture-only-password"}
        for hostname in ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]:
            with self.subTest(hostname=hostname):
                endpoint = f"http://{hostname}:55888/auth/v1/token"
                payload = self.runner.validate_payload({**self.payload(), "credentials": account, "authEndpoints": [endpoint]})
                self.assertEqual(payload["authEndpoints"], [endpoint])
                self.assertEqual(payload["allowedOrigins"], ["http://127.0.0.1:3010"])
                browser = self.runner.OwnedBrowser(payload)
                self.assertFalse(browser.mutation_blocked("POST", endpoint + "?grant_type=password"))
                for request_host in ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]:
                    request = f"http://{request_host}:55888/auth/v1/token"
                    self.assertFalse(browser.mutation_blocked("POST", request + "?grant_type=password"), request)
                    self.assertTrue(self.runner.endpoint_allowed(request + "?grant_type=password&scope=read", [endpoint + "?grant_type=password"]))
                    self.assertFalse(self.runner.endpoint_allowed(request + "?grant_type=refresh_token", [endpoint + "?grant_type=password"]))
                    for refused in [f"https://{request_host}:55888/auth/v1/token", f"http://{request_host}:55889/auth/v1/token", f"http://{request_host}:55888/auth/v1/token-revoke"]:
                        self.assertTrue(browser.mutation_blocked("POST", refused), refused)
                for url in [f"http://{hostname}:55889/auth/v1/token", f"http://{hostname}:55888/auth/v1/users", "http://other.example:55888/auth/v1/token"]:
                    self.assertTrue(browser.mutation_blocked("POST", url), url)
                self.assertFalse(self.runner.navigation_allowed(endpoint, set(payload["allowedOrigins"])))
        for hostname in ["other.example", "host.docker.internal.other.example", "127.0.0.2"]:
            with self.subTest(hostname=hostname), self.assertRaises(ValueError):
                self.runner.validate_payload({**self.payload(), "credentials": account, "authEndpoints": [f"http://{hostname}:55888/auth/v1/token"]})

    def test_discovery_permits_only_the_configured_sign_in_post_with_an_account(self):
        import asyncio
        from types import SimpleNamespace

        account = {"username": "ephemeral@example.invalid", "password": "fixture-only-password"}
        base = {"mode": "discover", "targetUrl": "http://127.0.0.1:55887/", "allowedOrigins": ["http://127.0.0.1:55887"], "authEndpoints": ["http://127.0.0.1:55888/auth/v1/token"]}

        class Route:
            def __init__(self, method, url):
                self.request = SimpleNamespace(method=method, url=url, is_navigation_request=lambda: False)
                self.outcome = None

            async def abort(self, *_):
                self.outcome = "blocked"

            async def continue_(self):
                self.outcome = "sent"

        def outcome(payload, method, url):
            route = Route(method, url)
            asyncio.run(self.runner.OwnedBrowser(self.runner.validate_payload(payload)).route_initial_request(route))
            return route.outcome

        token = "http://127.0.0.1:55888/auth/v1/token?grant_type=password"
        self.assertEqual(outcome({**base, "credentials": account}, "POST", token), "sent")
        self.assertEqual(outcome({**base, "credentials": account}, "GET", "http://127.0.0.1:55887/workflows"), "sent")
        for payload, method, url in [(base, "POST", token), ({**base, "credentials": account}, "PUT", token), ({**base, "credentials": account}, "POST", "http://127.0.0.1:55888/rest/v1/workflows"), ({**base, "credentials": account}, "DELETE", "http://127.0.0.1:55887/api/workflows/1")]:
            self.assertEqual(outcome(payload, method, url), "blocked", (method, url))

    def test_discovery_instructions_ask_for_complete_checked_journeys(self):
        self.assertIn("observes the completed, successful result of that work before any credit or usage milestone; a credit decrease after a failed run is a failure, not a pass.", self.runner.DISCOVERY_INSTRUCTIONS)
        self.assertIn("a compare-number check only in a milestone after the one whose checks confirm the successful result", self.runner.DISCOVERY_INSTRUCTIONS)
        for phrase in ["read-number", "compare-number", "Discovery itself is read-only"]:
            self.assertIn(phrase, self.runner.DISCOVERY_INSTRUCTIONS)

    def test_owned_chromium_resolves_the_twin_host_to_loopback(self):
        import asyncio
        launched = {}

        class Chromium:
            async def launch_persistent_context(self, **options):
                launched.update(options)
                raise RuntimeError("fixture stops after launch")

        class Playwright:
            chromium = Chromium()

            async def stop(self):
                pass

        class Starter:
            async def start(self):
                return Playwright()

        with patch("playwright.async_api.async_playwright", Starter), self.assertRaises(RuntimeError):
            asyncio.run(self.runner.OwnedBrowser({"mode": "discover"}, emit_event=[].append).__aenter__())
        self.assertIn("--host-resolver-rules=MAP host.docker.internal 127.0.0.1", launched["args"])
        self.assertIn("--remote-debugging-address=127.0.0.1", launched["args"])

    def test_one_invalid_proposal_does_not_discard_a_paid_discovery(self):
        class Proposal:
            def __init__(self, **value):
                self.value, self.name = value, value["name"]

            def model_dump(self):
                return copy.deepcopy(self.value)
        base = {"goal": "Sign in and reopen saved work", "preconditions": [], "expectedOutcomes": ["Saved work is visible"], "assertions": [], "evidence": []}
        good = Proposal(name="Reopen saved work", steps=[{"id": "open", "title": "Open"}, {"id": "reopen", "title": "Reopen"}], **base)
        bad = Proposal(name="Out of order", steps=[{"id": "a", "title": "Compare", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]}, {"id": "b", "title": "Read", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}], **base)
        payload = {**self.payload(), "sourceContext": "{}"}
        cases, summary = self.runner.accepted_proposals(payload, [bad, good], "Observed the dashboard.")
        self.assertEqual([case["name"] for case in cases], ["Reopen saved work"])
        self.assertTrue(summary.startswith("Observed the dashboard.\nOmitted \"Out of order\": "))
        with self.assertRaises(self.runner.InputError):
            self.runner.accepted_proposals(payload, [bad], "Observed")
        self.assertEqual(self.runner.accepted_proposals(payload, [], "Nothing supported")[0], [])

    def test_discovery_proposes_milestone_checks(self):
        discovery = self.runner.discovery_schema()
        steps = [{"id": "start", "title": "Confirm starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}, {"id": "run", "title": "Run and see credits decrease", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}, {"type": "text-visible", "value": "Run complete"}]}]
        candidate = {"name": "Run a workflow", "goal": "Sign in, run a workflow and see credits decrease", "steps": steps, "preconditions": [], "expectedOutcomes": ["Credits decrease after the run"], "assertions": [], "evidence": []}
        parsed = discovery.model_validate({"cases": [candidate, {**candidate, "steps": [{"id": "a", "title": "Open"}, {"id": "b", "title": "Close"}]}], "summary": "Observed"})
        cases = [self.runner.discovered_case(item, {}) for item in parsed.cases]
        self.assertEqual(cases[0]["steps"], steps)
        self.assertEqual(cases[1]["steps"], [{"id": "a", "title": "Open"}, {"id": "b", "title": "Close"}])
        self.assertTrue(all(case["needsReview"] and not case["selected"] and case["isolation"] == "shared" for case in cases))
        for invalid in [[dict(steps[1]), dict(steps[0])], [{**steps[0], "checks": steps[0]["checks"] * 7}, steps[1]], [{**steps[0], "checks": [{"type": "read-number", "label": "Credits", "name": "before", "value": "1"}]}, steps[1]]]:
            with self.subTest(steps=invalid), self.assertRaises(ValueError):
                discovery.model_validate({"cases": [{**candidate, "steps": invalid}], "summary": "Observed"})
        # OpenAI strict structured output accepts anyOf unions, not oneOf discriminators.
        import json
        from browser_use.llm.schema import SchemaOptimizer
        encoded = json.dumps(SchemaOptimizer.create_optimized_json_schema(discovery))
        self.assertIn("compare-number", encoded)
        self.assertNotIn("oneOf", encoded)
        self.assertNotIn("discriminator", encoded)

    def test_exception_bodies_are_not_exposed(self):
        error = ValueError("Invalid request containing sk-fixture-secret")
        self.assertNotIn("sk-fixture-secret", self.runner.safe_error(error))
        error = type("AuthenticationError", (Exception,), {})("Bearer sk-fixture-secret")
        self.assertEqual(self.runner.safe_error(error), "Model authentication failed. Check the configured model API key and access.")

    def test_failed_browser_cleanup_emits_structured_ownership_uncertainty(self):
        import asyncio

        class BrokenBrowser:
            async def stop(self):
                raise RuntimeError("fixture cleanup failure")

        events = []
        owned = self.runner.OwnedBrowser({}, emit_event=events.append)
        owned.browser = BrokenBrowser()
        asyncio.run(owned.close())
        self.assertEqual(events, [{"type": "error", "error": "Cleanup incomplete: browser agent connection", "cleanupIncomplete": True}])

    def test_discovery_schema_rejects_invalid_evidence_and_oversized_candidates(self):
        schema = self.runner.discovery_schema()
        valid = {"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": [{"path": "frontend/page.tsx", "line": 2}]}], "summary": "Workspace observed"}
        self.assertEqual(schema.model_validate(valid).cases[0].evidence[0].line, 2)
        for line in [0, -1, 1000001, "2", 2.5, True]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0]["evidence"][0]["line"] = line
            with self.subTest(line=line), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        for field, value in [("name", "x" * 121), ("goal", "x" * 4001), ("steps", []), ("steps", [{"id": "same", "title": "Milestone"}] * 2), ("steps", [{"id": "../outside", "title": "Milestone"}, {"id": "valid", "title": "Outcome"}]), ("expectedOutcomes", []), ("expectedOutcomes", ["x"] * 21), ("preconditions", ["x" * 2001]), ("assertions", [{"type": "text-visible", "value": "x"}] * 21), ("evidence", [{"path": "frontend/page.tsx", "line": 2}] * 41)]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        for path in ["../outside.ts", "/root/private", "AGENTS.md", "secrets.json", "src/.env", "C:\\private"]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0]["evidence"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        invalid = copy.deepcopy(valid)
        invalid["cases"] *= 7
        with self.assertRaises(ValueError):
            schema.model_validate(invalid)

    def test_discovery_output_matches_backend_schema_without_invented_evidence(self):
        import json
        import subprocess

        schema = self.runner.discovery_schema()
        # Line 3, a blank line 4 and another file were never supplied; line 2 was.
        cited = [{"path": "frontend/page.tsx", "line": 2}, {"path": "frontend/page.tsx", "line": 3}, {"path": "frontend/page.tsx", "line": 4}, {"path": "frontend/other.tsx", "line": 2}]
        result = schema.model_validate({"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": cited}, {"name": "Page observation", "goal": "Inspect page title", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Title visible"], "assertions": [], "evidence": []}], "summary": "Two drafts"})
        script = "import { validateDiscoveredBrowserCases } from './src/business/browser-cases.ts'; let s=''; for await (const chunk of process.stdin) s+=chunk; const value=JSON.parse(s); const cases=validateDiscoveredBrowserCases(value.cases,value.context); process.stdout.write(JSON.stringify(cases));"
        context = json.dumps({"scope": "Workspace", "files": [{"path": "frontend/page.tsx", "source": "1: import React from 'react';\n2: export const title = 'Workspace';\n4:   "}]})
        self.assertEqual(self.runner.supplied_lines(context), {"frontend/page.tsx": {1, 2}})
        self.assertEqual([self.runner.supplied_lines(value) for value in ["", "[]", "{}", '{"files": [{"path": "a.ts", "source": 1}]}']], [{}, {}, {}, {}])
        drafts = [self.runner.discovered_case(item, self.runner.supplied_lines(context)) for item in result.cases]
        self.assertEqual(drafts[0]["evidence"], [{"path": "frontend/page.tsx", "line": 2}])

        completed = subprocess.run(["node", "--input-type=module", "-e", script], cwd=HERE.parent.parent, input=json.dumps({"cases": drafts, "context": context}), text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, "Generated Python cases did not pass the Node contract")
        cases = json.loads(completed.stdout)
        self.assertEqual(cases[0]["evidence"], [{"path": "frontend/page.tsx", "line": 2}])
        self.assertEqual(cases[1]["evidence"], [])
        self.assertTrue(all(case["needsReview"] and not case["selected"] for case in cases))


class LargeDiscoveryContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_source_is_preserved_as_untrusted_data_across_steps(self):
        import asyncio
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        spec = importlib.util.spec_from_file_location("browser_fixture", HERE / "test_browser.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        runner = fixture.runner
        source = json.dumps({"files": [{"path": "frontend/app/page.tsx", "source": "1: // reference " + "x" * 135000 + "\n2: export const title = 'Workspace';"}]})
        references = []
        token_limits = []

        class ModelHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                references.append(request["messages"])
                token_limits.append(request.get("max_completion_tokens"))
                if len(references) == 1:
                    action = {"wait": {"seconds": 3}}
                else:
                    action = {"done": {"data": {"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": [{"path": "frontend/app/page.tsx", "line": 2}, {"path": "frontend/app/page.tsx", "line": 3}]}], "summary": "Workspace observed"}}}
                content = {"evaluation_previous_goal": "Observed fixture", "memory": "Retain source reference", "next_goal": "Complete discovery", "action": [action]}
                response = {"id": "fixture-completion", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": json.dumps(content)}}]}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
                body = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        application = ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        for server in [application, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{application.server_port}"
        payload = runner.validate_payload({"mode": "discover", "targetUrl": url, "allowedOrigins": [url], "sourceContext": source, "maxSteps": 4, "timeoutSeconds": 30})
        events = []
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "openai/gpt-5.4-mini", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "emit", events.append):
                try:
                    result = await asyncio.wait_for(runner.discover(payload), 35)
                except Exception as error:
                    self.fail(f"Large discovery failed: {type(error).__name__}")
            # Line 3 was never supplied, so its citation is dropped rather than failing the batch.
            self.assertEqual(result["cases"][0]["evidence"], [{"path": "frontend/app/page.tsx", "line": 2}])
            self.assertFalse(result["cases"][0]["selected"])
            self.assertTrue(result["cases"][0]["needsReview"])
            self.assertEqual(len(references), 2)
            self.assertEqual(token_limits, [8192, 8192])
            for messages in references:
                reference = [message for message in messages if isinstance(message["content"], str) and source in message["content"]]
                self.assertEqual(len(reference), 1)
                self.assertEqual(reference[0]["role"], "user")
                self.assertIn("untrusted", reference[0]["content"].lower())
                self.assertIsNot(reference[0], messages[-1])
            self.assertGreaterEqual(sum(event["type"] == "frame" for event in events), 2)
            self.assertTrue(any(event.get("actions") and event["actions"][0] == {"type": "wait", "status": "passed"} for event in events))
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
