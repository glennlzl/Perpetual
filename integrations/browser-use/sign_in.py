"""Sign in with the run-only test account on the agent's current page.

The agent decides when to sign in; this finds the page's sign-in form, fills both fields
from the run-only account, submits it and reports what followed. Values enter only fields
that pass the shared credential rule, and the result the model receives is a fixed status
with redacted page text, never a value.
"""

import asyncio
import contextlib

from run_credentials import credential_field_error, redact

SIGN_IN_SECONDS = 15
MESSAGE_LIMIT = 100
# A sign-in form has one password field; a sign-up or password-change form has a new-password
# field or several. Its username is the type=email or autocomplete username/email field in the
# same form, else the nearest text field before the password. Without a <form>, the group is the
# password's nearest ancestor holding such a field. Open shadow roots are included.
FIND_FORM = r"""() => {
  const nodes = [];
  const walk = root => root.querySelectorAll('*').forEach(node => {
    if (node.tagName === 'INPUT' || node.tagName === 'BUTTON') nodes.push(node);
    if (node.shadowRoot) walk(node.shadowRoot);
  });
  walk(document);
  const up = node => node.parentElement || node.getRootNode().host || null;
  const inside = (node, box) => { for (let at = node; at; at = up(at)) if (at === box) return true; return false; };
  const kind = node => (node.getAttribute('type') || 'text').toLowerCase();
  const shown = node => node.getClientRects().length > 0 && node.checkVisibility({visibilityProperty: true, opacityProperty: true});
  const before = (node, other) => nodes.indexOf(node) < nodes.indexOf(other);
  const inputs = nodes.filter(node => node.tagName === 'INPUT' && !node.disabled && !node.readOnly && shown(node));
  const passwords = inputs.filter(node => kind(node) === 'password');
  const names = inputs.filter(node => kind(node) === 'text' || kind(node) === 'email');
  const hinted = node => kind(node) === 'email' || /\b(username|email)\b/i.test(node.getAttribute('autocomplete') || '');
  for (const password of passwords) {
    let member = node => node.form === password.form;
    if (!password.form) {
      let box = up(password);
      while (box && !names.some(node => inside(node, box))) box = up(box);
      member = node => !!box && inside(node, box);
    }
    if (/new-password/i.test(password.getAttribute('autocomplete') || '') || passwords.filter(member).length !== 1) continue;
    const fields = names.filter(member), preferred = fields.filter(hinted);
    const username = preferred.filter(node => before(node, password)).pop() || preferred[0] || fields.filter(node => before(node, password)).pop();
    if (!username) continue;
    // A type=button control, such as a show-password toggle, never submits.
    const submits = nodes.filter(node => member(node) && (node.tagName === 'BUTTON' ? node.type === 'submit' : ['submit', 'image'].includes(kind(node))) && shown(node));
    return {username, password, submit: submits.find(node => before(password, node)) || submits[0] || null};
  }
  return {};
}"""
# Visible alerts and live regions, plus the browser's own messages for fields it rejected.
# Keep their raw text: rendered innerText or whitespace folding can change an echoed account value before redaction.
MESSAGES = r"""() => {
  const selector = '[role=alert], [role=status], [aria-live=assertive], [aria-live=polite]';
  const texts = [];
  const add = text => { if (text && text.trim() && !texts.includes(text)) texts.push(text); };
  const visibleText = node => {
    if (node.nodeType === Node.TEXT_NODE) return getComputedStyle(node.parentElement).visibility === 'visible' ? node.textContent || '' : '';
    if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE'].includes(node.tagName)) return '';
    // A boxless wrapper can contain rendered text; visibility can also be restored by a descendant.
    // Check the rendered ancestor for hidden layout/opacity, and each text node for its own visibility.
    let box = node;
    while (box && getComputedStyle(box).display === 'contents') box = box.parentElement;
    if (!box || getComputedStyle(box).contentVisibility === 'hidden' || !box.checkVisibility({opacityProperty: true})) return '';
    return Array.from(node.childNodes, visibleText).join('');
  };
  document.querySelectorAll(selector).forEach(node => { if (!node.parentElement?.closest(selector)) add(visibleText(node)); });
  document.querySelectorAll('input:user-invalid').forEach(node => add(node.validationMessage));
  return texts.join(' | ');
}"""


async def sign_in_on_page(page, credentials, on_application, allowed, seconds=None):
    """Fill and submit the page's sign-in form: signed_in, still_on_sign_in, no_sign_in_form or error.

    on_application(url): the page is on the application's exact origin, where the account may be entered.
    allowed(url): the page is within the approved origins, so reaching it can count as signed in.
    A signed_in result also carries the URL of the page the form was on before it was submitted.
    """
    handles = []
    try:
        found = await asyncio.wait_for(page.main_frame.evaluate_handle(FIND_FORM), 5)
        handles.append(found)
        fields = {}
        for name in ("username", "password", "submit"):
            handles.append(await found.get_property(name))
            fields[name] = handles[-1].as_element()
        if not fields["username"] or not fields["password"]:
            return {"result": "no_sign_in_form", "code": "credential_field_unavailable"}
        for name in ("username", "password"):
            tag, kind = await fields[name].evaluate("node => [node.tagName, node.getAttribute('type')]")
            code = credential_field_error(name, on_application(page.url), True, await fields[name].owner_frame() == page.main_frame, tag, kind)
            if code:
                return {"result": "error", "code": code}
            await fields[name].fill(credentials[name], timeout=5000)
        form_url = page.url
        await submit(fields)
    except asyncio.CancelledError:
        raise
    except Exception:
        # Browser errors can contain page text or typed values; keep only a fixed code.
        return {"result": "error", "code": "browser_action_failed"}
    finally:
        for handle in handles:
            with contextlib.suppress(Exception):
                await handle.dispose()
    outcome = await settled(page, credentials, allowed, SIGN_IN_SECONDS if seconds is None else seconds)
    return {**outcome, "url": form_url} if outcome["result"] == "signed_in" else outcome


async def submit(fields):
    # Click waits until a control disabled before both fields held values is enabled.
    if fields["submit"]:
        try:
            await fields["submit"].click(timeout=3000)
            return
        except Exception:
            pass
    # A navigation the click started can detach the field; the wait below observes the result.
    with contextlib.suppress(Exception):
        await fields["password"].press("Enter", timeout=3000)


async def settled(page, credentials, allowed, seconds):
    """Signed in once the approved page stays without a visible password field, so a brief transition does not count."""
    loop = asyncio.get_running_loop()
    deadline, state, streak = loop.time() + seconds, None, 0
    while True:
        current = await form_state(page, allowed)
        state, streak = current, streak + 1 if current == state else 1
        if state == "closed" or state in {"gone", "outside"} and streak >= 3 or loop.time() >= deadline:
            break
        await asyncio.sleep(0.25)
    if state == "gone":
        return {"result": "signed_in"}
    if state == "outside":
        # For example a blocked sign-in request, which leaves the browser's own error page.
        return {"result": "error", "code": "navigation_not_allowed"}
    if state == "closed":
        return {"result": "error", "code": "browser_action_failed"}
    message = ""
    with contextlib.suppress(Exception):
        message = await asyncio.wait_for(page.main_frame.evaluate(MESSAGES), 3)
    # Redact before whitespace folding or truncation, so neither can leave a changed or partial account value.
    message = " ".join(redact(str(message), credentials).split())[:MESSAGE_LIMIT].strip()
    return {"result": "still_on_sign_in", "code": "browser_action_failed", **({"message": message} if message else {})}


async def form_state(page, allowed):
    if page.is_closed():
        return "closed"
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=2000)
        if not allowed(page.url):
            return "outside"
        return "form" if await page.main_frame.locator("input[type=password]").filter(visible=True).count() else "gone"
    except Exception:
        # A navigation replaced the document; observe it again.
        return None
