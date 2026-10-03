"""Discovery's action feed and model failure counts carry fixed codes and categories, never page or provider text."""

import json
import unittest
from types import SimpleNamespace

import runner


class AgentDiagnostics(unittest.TestCase):
    def test_action_progress_only_exposes_fixed_failure_codes(self):
        private = "private-browser-error-with-page-content"
        for metadata in [{"perpetualErrorCode": private}, {"perpetualErrorCode": [private]}, None]:
            result = runner.action_progress("input", SimpleNamespace(error=private, metadata=metadata))
            self.assertEqual(result, {"type": "input", "status": "failed", "errorCode": "browser_action_failed"})
            self.assertNotIn(private, json.dumps(result))
        self.assertEqual(runner.action_progress("click", None), {"type": "click", "status": "failed", "errorCode": "action_result_missing"})
        self.assertEqual(runner.action_progress("input", SimpleNamespace(error=None, metadata={"perpetualErrorCode": private})), {"type": "input", "status": "passed"})

    def test_classification_uses_types_without_retaining_error_payloads(self):
        from pydantic import BaseModel, ValidationError
        class Value(BaseModel):
            number: int
        try:
            Value(number="private-provider-payload")
        except ValidationError as cause:
            wrapper = RuntimeError("private-provider-payload")
            wrapper.__cause__ = cause
            self.assertEqual(runner.model_failure_kind(wrapper), "invalid_output")
        self.assertEqual(runner.model_failure_kind(TimeoutError("private")), "timeout")
        self.assertEqual(runner.model_failure_kind(ValueError("private")), "other")

class WrappedProviderErrors(unittest.TestCase):
    def test_structured_provider_status_survives_a_wrapper_without_provider_text(self):
        for status, message in [(402,'credits are exhausted'),(429,'rate limit'),(401,'authentication failed')]:
            cause=RuntimeError('private request body and credential')
            cause.status_code=status
            wrapper=type('ModelProviderError',(Exception,),{})('private provider response')
            wrapper.__cause__=cause
            result=runner.safe_error(wrapper)
            self.assertIn(message,result)
            self.assertNotIn('private',result)


if __name__ == "__main__":
    unittest.main()
