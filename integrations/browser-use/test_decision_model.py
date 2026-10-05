"""Exercise the model's public call over the actual OpenAI HTTP protocol."""

import copy
import json
import unittest

import httpx
from browser_use.llm.exceptions import ModelOutputTruncatedError, ModelProviderError
from browser_use.llm.messages import UserMessage
from pydantic import BaseModel, Field

from decision_model import DecisionChatOpenAI
from runner import model_failure_kind, safe_error


class Decision(BaseModel):
    action: list[str] = Field(min_length=1, max_length=1)


def response(arguments='{"action":["observe"]}'):
    return {"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "decision-1", "type": "function", "function": {"name": "browser_decision", "arguments": arguments}}]}}], "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}}


class DecisionProtocol(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, reply, output_format=Decision):
        requests = []

        def serve(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json=reply)

        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            model = DecisionChatOpenAI(model="fixture", api_key="fixture-only-key", base_url="https://model.example.test/v1", http_client=client, max_retries=0, max_completion_tokens=8192)
            result = await model.ainvoke([UserMessage(content="Observe the actual page")], output_format=output_format)
        return result, requests

    async def test_one_native_tool_decision_preserves_schema_usage_and_token_limit(self):
        result, requests = await self.invoke(response())
        self.assertEqual(result.completion.action, ["observe"])
        self.assertEqual((result.usage.prompt_tokens, result.usage.completion_tokens), (7, 3))
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertNotIn("response_format", request)
        self.assertEqual(request["tool_choice"], {"type": "function", "function": {"name": "browser_decision"}})
        self.assertFalse(request["parallel_tool_calls"])
        self.assertEqual(request["max_completion_tokens"], 8192)
        self.assertEqual(len(request["tools"]), 1)
        function = request["tools"][0]["function"]
        self.assertTrue(function["strict"])
        self.assertEqual(function["parameters"]["properties"]["action"]["maxItems"], 1)

    async def test_a_forced_decision_that_finishes_with_stop_is_one_complete_decision(self):
        # OpenAI's Chat Completions ends a forced named function call with "stop" rather than "tool_calls".
        reply = response()
        reply["choices"][0]["finish_reason"] = "stop"
        result, requests = await self.invoke(reply)
        self.assertEqual(result.completion.action, ["observe"])
        self.assertEqual((result.usage.prompt_tokens, result.usage.completion_tokens), (7, 3))
        self.assertEqual(len(requests), 1)
        for kind in ["mixed_content", "multiple_tools"]:
            reply = response()
            reply["choices"][0]["finish_reason"] = "stop"
            message = reply["choices"][0]["message"]
            if kind == "mixed_content":
                message["content"] = "Another decision"
            else:
                message["tool_calls"].append(copy.deepcopy(message["tool_calls"][0]))
            with self.subTest(kind=kind), self.assertRaises(ModelProviderError) as caught:
                await self.invoke(reply)
            self.assertEqual(model_failure_kind(caught.exception), "invalid_output")

    async def test_whole_argument_json_is_validated_without_slicing_or_truncating_actions(self):
        for arguments in ['{"action":["observe"]}\n{"action":["navigate"]}', '{"action":["observe","navigate"]}', '{"action": [']:
            with self.subTest(arguments=arguments), self.assertRaises(ModelProviderError):
                await self.invoke(response(arguments))

    async def test_ambiguous_missing_refused_and_plain_text_decisions_are_rejected(self):
        for kind in ["multiple_choices", "no_choices", "multiple_tools", "no_tools", "wrong_tool", "wrong_type", "mixed_content", "plain_json", "legacy_function", "refusal", "wrong_finish"]:
            reply = response()
            choice = reply["choices"][0]
            message = choice["message"]
            if kind == "multiple_choices":
                reply["choices"].append(copy.deepcopy(choice))
            elif kind == "no_choices":
                reply["choices"] = []
            elif kind == "multiple_tools":
                message["tool_calls"].append(copy.deepcopy(message["tool_calls"][0]))
            elif kind == "no_tools":
                message["tool_calls"] = []
            elif kind == "wrong_tool":
                message["tool_calls"][0]["function"]["name"] = "another_decision"
            elif kind == "wrong_type":
                message["tool_calls"][0]["type"] = "custom"
            elif kind == "mixed_content":
                message["content"] = "Another decision"
            elif kind == "plain_json":
                message["content"] = '{"action":["observe"]}'
                message["tool_calls"] = None
                choice["finish_reason"] = "stop"
            elif kind == "legacy_function":
                message["function_call"] = {"name": "another_decision", "arguments": '{"action":["navigate"]}'}
            elif kind == "refusal":
                message["refusal"] = "Refused"
            elif kind == "wrong_finish":
                choice["finish_reason"] = "content_filter"
            with self.subTest(kind=kind):
                with self.assertRaises(ModelProviderError) as caught:
                    await self.invoke(reply)
                self.assertEqual(model_failure_kind(caught.exception), "invalid_output")
                self.assertNotIn("Another decision", str(caught.exception))
                self.assertEqual(safe_error(caught.exception), "The model returned an invalid browser decision. Choose a model with reliable function calling.")

    async def test_unreachable_and_slow_providers_reach_the_ui_as_their_cause(self):
        for failure, message in [(httpx.ConnectError("connection refused"), "Could not connect to the model provider. Check the model endpoint and network."),
                                 (httpx.ReadTimeout("read timed out"), "The model provider timed out. Retry or choose a faster model.")]:
            def serve(request):
                raise failure

            async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
                model = DecisionChatOpenAI(model="fixture", api_key="fixture-only-key", base_url="https://model.example.test/v1", http_client=client, max_retries=0, max_completion_tokens=8192)
                with self.subTest(message=message), self.assertRaises(ModelProviderError) as caught:
                    await model.ainvoke([UserMessage(content="Observe the actual page")], output_format=Decision)
            self.assertEqual(safe_error(caught.exception), message)

    async def test_truncation_is_never_accepted_even_when_arguments_parse(self):
        reply = response()
        reply["choices"][0]["finish_reason"] = "length"
        with self.assertRaises(ModelOutputTruncatedError):
            await self.invoke(reply)

    async def test_unstructured_calls_keep_the_upstream_protocol(self):
        reply = response()
        reply["choices"][0].update(finish_reason="stop", message={"role": "assistant", "content": "Observed page"})
        result, requests = await self.invoke(reply, output_format=None)
        self.assertEqual(result.completion, "Observed page")
        self.assertNotIn("tools", requests[0])


if __name__ == "__main__":
    unittest.main()
