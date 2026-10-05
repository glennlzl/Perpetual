"""Ephemeral test-account values, never part of a persisted business case."""

import copy
import re

ALIASES = {"username": "perpetual_test_username", "password": "perpetual_test_password"}
# Each value fills only its own kind of login field.
FIELD_TYPES = {"username": {"text", "email"}, "password": {"password"}}
# Redaction hides every copy of a value in any letter case, so a shorter value, or a word the agent's own instructions
# use, would also hide ordinary page text, proposals and those instructions.
MINIMUM_LENGTH = 6


def credential_field_error(name, same_origin, agent_tab, top_frame, tag, input_type):
    """One rule for every credential fill: the application's exact origin, the agent's tab, its top frame and a matching input."""
    if not same_origin:
        return "credential_origin_mismatch"
    if not agent_tab:
        return "credential_target_mismatch"
    if not top_frame:
        return "credential_frame_mismatch"
    if str(tag).lower() != "input" or str(input_type or "text").lower() not in FIELD_TYPES[name]:
        return "credential_field_type_mismatch"
    return None


def shown_forms(value):
    """A value as a page may show it: as given or stripped, each also clipped to the 100 characters Browser Use shows of
    a field's value."""
    return {form for shown in (value, value.strip()) for form in (shown, shown[:100])} - {""}


def validate_credentials(raw, mode, own_text=""):
    """A run-only account for discovery; own_text is what the adapter itself tells the agent."""
    if raw is None:
        return None
    if mode != "discover" or not isinstance(raw, dict) or set(raw) != set(ALIASES):
        raise ValueError("Test credentials are available only for discovery.")
    for name, maximum in [("username", 320), ("password", 1024)]:
        value = raw[name]
        if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
            raise ValueError("Enter a valid test username and password.")
        if len(value.strip()) < MINIMUM_LENGTH or any(form.lower() in own_text.lower() for form in shown_forms(value)):
            raise ValueError(f"Use a test username and password of at least {MINIMUM_LENGTH} characters that are not common words, such as password or test.")
    return dict(raw)


def redact(text, credentials):
    """Account values in text the model receives, longest first, become [REDACTED].

    Matching ignores letter case and covers a value as Browser Use shows a field's value too: stripped, and clipped to
    its first 100 characters.
    """
    if not credentials:
        return text
    secrets = {form for value in credentials.values() for form in shown_forms(value)}
    return re.sub("|".join(re.escape(item) for item in sorted(secrets, key=len, reverse=True)), "[REDACTED]", text, flags=re.IGNORECASE)


def contains_account(value, credentials):
    """Whether a string in JSON-like data holds an account value as redact() finds one."""
    if isinstance(value, str):
        return redact(value, credentials) != value
    if isinstance(value, dict):
        return any(contains_account(child, credentials) for child in value.values())
    if isinstance(value, (tuple, list)):
        return any(contains_account(child, credentials) for child in value)
    return False


def credential_alias(text):
    for name, alias in ALIASES.items():
        if text in (alias, f"<secret>{alias}</secret>"):
            return name
    return None


def contains_reference(value):
    if isinstance(value, str):
        return "<secret" in value.lower() or "</secret" in value.lower() or any(alias in value for alias in ALIASES.values())
    if isinstance(value, dict):
        return any(contains_reference(child) for child in value.values())
    if isinstance(value, (tuple, list)):
        return any(contains_reference(child) for child in value)
    return False


def redact_messages(messages, credentials):
    if not credentials:
        return messages
    messages = copy.deepcopy(messages)
    for message in messages:
        if isinstance(message.content, str):
            message.content = redact(message.content, credentials)
        elif isinstance(message.content, list):
            for part in message.content:
                if getattr(part, "type", None) != "text":
                    raise ValueError("Test-account runs cannot send browser images to the model.")
                part.text = redact(part.text, credentials)
    return messages
