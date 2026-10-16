"""Provider-response parsing and redacted diagnostics, with no network calls."""
from types import SimpleNamespace
import unittest

from app.llm.semantic_reasoner import SemanticReasoner, _safe_json_extract, is_plain_text_answer


class FakeClient:
    def __init__(self, content=None, error=None):
        self.content = content
        self.error = error
        self.calls = 0

    def invoke(self, prompt):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return SimpleNamespace(content=self.content)


def reasoner_with(client):
    # Bypass constructor configuration; fake clients are the only clients used.
    reasoner = object.__new__(SemanticReasoner)
    reasoner._client = client
    reasoner.last_error = None
    return reasoner


class SemanticReasonerTests(unittest.TestCase):
    def test_plain_text_guard_rejects_nonobject_json_and_broken_envelopes(self):
        for raw in (
            None, 42, "", "   ", "null", "true", "false", "42", "0.25", '"hello"',
            "[]", '["steady", "gusty"]', '{"answer": "valid object"}',
            '{"answer":', '[{"answer":', '```json\n{"answer":',
            'Here is the JSON: {"answer":', 'Result: [1, 2',
            'Here is the JSON\n[1, 2', 'Here is the JSON: {answer: broken}',
            '```\nplain text\n```', '"unterminated string',
        ):
            with self.subTest(raw=raw):
                self.assertFalse(is_plain_text_answer(raw))

    def test_plain_text_guard_allows_normal_prose_and_numbers(self):
        for raw in (
            "A smaller d means a closer match to the current window.",
            "Window 12 is closest, with d = 0.25. These are historical examples.",
            "The forecast has 3 candidates, and the leading score is 0.8.",
            "The stored token sequence [1, 2, 3] describes the previous windows.",
            "1. A smaller score means a closer match.\n2. A larger score means a weaker match.",
        ):
            with self.subTest(raw=raw):
                self.assertTrue(is_plain_text_answer(raw))

    def test_json_success_and_wrappers(self):
        for text in (
            '{"answer": "A smaller d is a closer match."}',
            '```json\n{"answer": "A smaller d is a closer match."}\n```',
            'Here is the answer:\n{"answer": "A smaller d is a closer match."}\nDone.',
        ):
            with self.subTest(text=text):
                client = FakeClient(text)
                reasoner = reasoner_with(client)
                reasoner.last_error = {"category": "old_error"}
                self.assertEqual(reasoner.invoke_json("test"),
                                 {"answer": "A smaller d is a closer match."})
                self.assertIsNone(reasoner.last_error)
                self.assertEqual(client.calls, 1)

    def test_parser_returns_only_objects(self):
        for text in ('[]', '[{"answer": "nested"}]', 'null', 'true', '42', '"text"', '', None):
            with self.subTest(text=text):
                self.assertIsNone(_safe_json_extract(text))

    def test_text_content_blocks_are_not_stringified_dicts(self):
        reasoner = reasoner_with(FakeClient([
            {"type": "reasoning", "text": "Do not expose reasoning."},
            {"type": "text", "text": '{"answer": "A smaller '},
            {"type": "image_url", "image_url": {"url": "not text"}},
            {"type": "output_text", "text": 'd is closer."}'},
        ]))
        result, raw = reasoner.invoke_json_with_raw("test")
        self.assertEqual(result, {"answer": "A smaller d is closer."})
        self.assertEqual(raw, '{"answer": "A smaller d is closer."}')
        self.assertIsNone(reasoner.last_error)

    def test_string_and_text_blocks_can_be_combined(self):
        reasoner = reasoner_with(FakeClient(["A smaller ", {"type": "text", "text": "d is closer."}]))
        self.assertEqual(reasoner.invoke_text("test"), "A smaller d is closer.")

    def test_empty_response_is_distinguished_from_invalid_json(self):
        for content in (None, "", " \n ", [], [{"type": "reasoning", "text": "private"}]):
            with self.subTest(content=content):
                reasoner = reasoner_with(FakeClient(content))
                self.assertEqual(reasoner.invoke_json_with_raw("test"), (None, None))
                self.assertEqual(reasoner.last_error,
                                 {"category": "empty_response", "retryable": True})
        reasoner = reasoner_with(FakeClient("An ordinary sentence."))
        self.assertEqual(reasoner.invoke_json_with_raw("test"), (None, "An ordinary sentence."))
        self.assertEqual(reasoner.last_error, {"category": "invalid_json", "retryable": False})

    def test_unavailable_client(self):
        reasoner = reasoner_with(None)
        self.assertIsNone(reasoner.invoke_text("test"))
        self.assertEqual(reasoner.last_error, {"category": "client_unavailable", "retryable": False})

    def test_provider_failures_are_redacted_and_not_retried(self):
        cases = (
            (429, "rate_limit", True), (401, "authentication", False),
            (403, "permission_denied", False), (404, "model_or_endpoint_not_found", False),
            (400, "invalid_request", False), (422, "invalid_request", False),
            (503, "provider_error", True), (408, "timeout", True),
        )
        for status, category, retryable in cases:
            with self.subTest(status=status):
                error = RuntimeError("secret-key Authorization prompt and provider body")
                error.status_code = status
                client = FakeClient(error=error)
                reasoner = reasoner_with(client)
                self.assertEqual(reasoner.invoke_json_with_raw("private prompt"), (None, None))
                self.assertEqual(reasoner.last_error,
                                 {"category": category, "retryable": retryable, "status_code": status})
                self.assertEqual(client.calls, 1)
                self.assertNotIn("secret", str(reasoner.last_error))
                self.assertNotIn("prompt", str(reasoner.last_error))

    def test_timeout_connection_and_unknown_exceptions(self):
        for error, category, retryable in (
            (TimeoutError("sensitive timeout details"), "timeout", True),
            (ConnectionError("sensitive endpoint"), "connection_error", True),
            (RuntimeError("sensitive request"), "request_error", False),
        ):
            with self.subTest(category=category):
                reasoner = reasoner_with(FakeClient(error=error))
                self.assertIsNone(reasoner.invoke_text("private prompt"))
                self.assertEqual(reasoner.last_error, {"category": category, "retryable": retryable})

    def test_diagnostics_reset_after_a_failure(self):
        client = FakeClient(error=TimeoutError("private"))
        reasoner = reasoner_with(client)
        self.assertIsNone(reasoner.invoke_text("test"))
        client.error = None
        client.content = "Success."
        self.assertEqual(reasoner.invoke_text("test"), "Success.")
        self.assertIsNone(reasoner.last_error)


if __name__ == "__main__":
    unittest.main()
