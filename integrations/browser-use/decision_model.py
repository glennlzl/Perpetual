"""One provider decision for one actual browser observation."""

from browser_use import ChatOpenAI


class DecisionProtocolError(ValueError):
    """A provider reply cannot identify exactly one complete browser decision."""


class DecisionChatOpenAI(ChatOpenAI):
    """Keep Browser Use's parser and accounting, transport decisions as one tool call.

    A response_format JSON schema alone has returned concatenated decisions from
    a live provider, including imagined future observations. Do not recover a
    first object from that output. Require a single native function invocation
    and validate its entire arguments with the existing single-action schema.
    """

    def get_client(self):
        client = super().get_client()
        create = client.chat.completions.create

        async def decision_completion(**kwargs):
            response_format = kwargs.get("response_format")
            if not isinstance(response_format, dict) or response_format.get("type") != "json_schema":
                return await create(**kwargs)
            kwargs.pop("response_format")
            kwargs["tools"] = [{"type": "function", "function": {
                "name": "browser_decision",
                "description": "Choose exactly one next action from the actual current browser observation, or finish with the final report.",
                "strict": True,
                "parameters": response_format["json_schema"]["schema"],
            }}]
            kwargs["tool_choice"] = {"type": "function", "function": {"name": "browser_decision"}}
            kwargs["parallel_tool_calls"] = False
            response = await create(**kwargs)
            if len(response.choices) != 1:
                raise DecisionProtocolError("The model must return exactly one browser decision.")
            choice = response.choices[0]
            # Preserve the upstream truncation error even if partial arguments
            # happen to be parseable. No truncated decision may execute.
            if choice.finish_reason == "length":
                return response
            message = choice.message
            calls = message.tool_calls or []
            # A forced named function finishes with "stop" on OpenAI's Chat Completions and "tool_calls" elsewhere.
            if choice.finish_reason not in {"tool_calls", "stop"} or message.refusal or message.function_call is not None or (message.content and message.content.strip()) or len(calls) != 1:
                raise DecisionProtocolError("The model must return one complete browser tool decision without additional text.")
            call = calls[0]
            function = getattr(call, "function", None)
            if call.type != "function" or function is None or function.name != "browser_decision" or not isinstance(function.arguments, str):
                raise DecisionProtocolError("The model returned an invalid browser decision tool.")
            # The upstream parser consumes the whole string and rejects multiple
            # JSON objects, malformed arguments and multiple browser actions.
            message.content = function.arguments
            return response

        client.chat.completions.create = decision_completion
        return client
