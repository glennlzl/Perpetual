"""Offline diagnostics through the public sign-in operation; no browser, server or model is started."""

import json
import subprocess
import unittest
from types import SimpleNamespace

import sign_in


class Element:
    def __init__(self, frame, name):
        self.frame, self.name, self.value = frame, name, None

    def as_element(self):
        return self

    async def evaluate(self, _expression):
        return ["INPUT", "password" if self.name == "password" else "email"]

    async def owner_frame(self):
        return self.frame

    async def fill(self, value, **_options):
        self.value = value

    async def click(self, **_options):
        pass

    async def dispose(self):
        pass


class Frame:
    def __init__(self, alerts=(), validation=()):
        self.alerts, self.validation = alerts, validation
        self.elements = {name: Element(self, name) for name in ("username", "password", "submit")}

    async def evaluate_handle(self, _expression):
        return self

    async def get_property(self, name):
        return self.elements[name]

    async def dispose(self):
        pass

    def locator(self, _selector):
        return self

    def filter(self, **_options):
        return self

    async def count(self):
        return 1

    async def evaluate(self, expression):
        # Run the production collector against diagnostic nodes. innerText models the browser's rendered
        # whitespace; textContent retains the text the application put in the node.
        script = r"""
          const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
          global.Node = {ELEMENT_NODE: 1, TEXT_NODE: 3};
          global.getComputedStyle = () => ({display: 'block', visibility: 'visible', contentVisibility: 'visible'});
          const element = (value, parentElement = null) => {
            if (typeof value === 'string') return {nodeType: Node.TEXT_NODE, textContent: value, parentElement};
            const node = {nodeType: Node.ELEMENT_NODE, tagName: (value.tag || 'span').toUpperCase(), parentElement,
              checkVisibility: () => value.visible !== false};
            node.childNodes = (value.children || []).map(child => element(child, node));
            Object.defineProperty(node, 'textContent', {get: () => node.childNodes.map(child => child.textContent).join('')});
            Object.defineProperty(node, 'innerText', {get: () => node.childNodes.filter(child => child.nodeType === Node.TEXT_NODE || child.checkVisibility())
              .map(child => child.nodeType === Node.TEXT_NODE ? child.textContent : child.innerText).join('').replace(/\s+/g, ' ').trim()});
            return node;
          };
          const alerts = input.alerts.map(value => element(typeof value === 'string' ? {children: [value]} : value));
          const invalid = input.validation.map(validationMessage => ({validationMessage}));
          global.document = {querySelectorAll: selector => selector === 'input:user-invalid' ? invalid : alerts};
          process.stdout.write(JSON.stringify(eval('(' + input.expression + ')')()));
        """
        reply = subprocess.run(["node", "-e", script], input=json.dumps({"expression": expression, "alerts": self.alerts, "validation": self.validation}),
                               text=True, capture_output=True, check=True, timeout=5)
        return json.loads(reply.stdout)


class SignInDiagnostics(unittest.IsolatedAsyncioTestCase):
    async def attempt(self, account, *, alerts=(), validation=()):
        frame = Frame(alerts, validation)

        async def loaded(*_args, **_options):
            pass

        page = SimpleNamespace(main_frame=frame, url="http://127.0.0.1:3010/sign-in", is_closed=lambda: False, wait_for_load_state=loaded)
        result = await sign_in.sign_in_on_page(page, account, lambda _url: True, lambda _url: True, seconds=0)
        self.assertEqual({name: frame.elements[name].value for name in account}, account, "The account itself is never normalized.")
        return result

    async def test_alerts_redact_the_raw_account_before_browser_or_python_whitespace_normalization(self):
        account = {"username": "owner@example.test", "password": "fixture  spaced-password"}
        result = await self.attempt(account, alerts=[f"  Rejected\n{account['username']}: {account['password']}  "])
        self.assertEqual(result, {"result": "still_on_sign_in", "code": "browser_action_failed", "message": "Rejected [REDACTED]: [REDACTED]"})

    async def test_native_validation_text_redacts_before_normalization_and_clipping(self):
        account = {"username": "owner@example.test", "password": "  fixture  " + "p" * 130}
        result = await self.attempt(account, validation=[f"Rejected value: {account['password']}\n Try again."])
        self.assertEqual(result["message"], "Rejected value: [REDACTED] Try again.")
        self.assertLessEqual(len(result["message"]), sign_in.MESSAGE_LIMIT)

    async def test_safe_diagnostics_stay_concise_and_blank_diagnostics_are_omitted(self):
        account = {"username": "owner@example.test", "password": "fixture-password"}
        result = await self.attempt(account, alerts=["  Sign-in\nwas refused.  "], validation=["Please try again."])
        self.assertEqual(result["message"], "Sign-in was refused. | Please try again.")
        blank = await self.attempt(account, alerts=[" \n\t "])
        self.assertNotIn("message", blank)

    async def test_visible_alerts_exclude_hidden_descendant_and_script_style_text(self):
        account = {"username": "owner@example.test", "password": "fixture  spaced-password"}
        alert = {"children": ["Rejected: ", {"children": [account["password"]]},
                              {"visible": False, "children": ["hidden diagnostic data"]},
                              {"tag": "script", "children": ["privateScriptData()"]},
                              {"tag": "style", "children": [".private-style {}"]}, "\nTry again."]}
        result = await self.attempt(account, alerts=[alert])
        self.assertEqual(result["message"], "Rejected: [REDACTED] Try again.")
