from __future__ import annotations

from copy import deepcopy
import io
import json
import re
import unittest
from unittest.mock import patch
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from transcriptlayer import TranscriptLayerClient, TranscriptLayerError


CONTRACT_PATH = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "openapi-v1.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
SDK_FIXTURES_PATH = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "sdk-response-fixtures.json"
SDK_FIXTURES = json.loads(SDK_FIXTURES_PATH.read_text(encoding="utf-8"))


def contract_example(name: str, **overrides: object) -> dict[str, Any]:
    value = deepcopy(CONTRACT["components"]["examples"][name]["value"])
    value.update(overrides)
    return value


class FakeResponse:
    def __init__(self, status: int, body: object = None, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.headers = Message()
        for name, value in (headers or {}).items():
            self.headers[name] = value
        data = b"" if body is None else json.dumps(body).encode()
        self._body = io.BytesIO(data)

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def sdk_fixture(name: str, **overrides: object) -> dict[str, Any]:
    value = deepcopy(SDK_FIXTURES[name]["value"])
    value.update(overrides)
    if value.get("secret") == "<generated-test-api-key>":
        value["secret"] = "_".join(("tl", "test", "a" * 43))
    return value


def sdk_response(name: str, **overrides: object) -> FakeResponse:
    fixture = SDK_FIXTURES[name]
    return FakeResponse(
        fixture["status"],
        sdk_fixture(name, **overrides),
        {"content-type": "application/json"},
    )


def unchecked_control_flow_response(status: int, body: object, headers: dict[str, str] | None = None) -> FakeResponse:
    return FakeResponse(status, body, headers)


class FakeOpener:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[Any] = []
        self.timeouts: list[float] = []

    def open(self, request: Any, timeout: float) -> FakeResponse:
        self.requests.append(request)
        self.timeouts.append(timeout)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class ClientTests(unittest.TestCase):
    def test_decodes_contract_valid_account_key_page_webhook_usage_and_analytics_responses(self) -> None:
        cases = [
            ("account", lambda client: client.get_account()),
            ("api_key_with_secret", lambda client: client.create_api_key({
                "name": "Deploy", "scopes": ["transcripts:read"],
            })),
            ("transcript_page", lambda client: client.list_transcripts()),
            ("batch_page", lambda client: client.list_batches()),
            ("batch_item_page", lambda client: client.list_batch_items("bat_sdk")),
            ("webhook_endpoint_with_secret", lambda client: client.create_webhook_endpoint({
                "name": "Production", "url": "https://hooks.example.com/transcriptlayer",
            })),
            ("webhook_endpoint_list", lambda client: client.list_webhook_endpoints()),
            ("webhook_delivery_page", lambda client: client.list_webhook_deliveries()),
            ("usage_page", lambda client: client.list_usage()),
            ("analytics_overview", lambda client: client.get_account_analytics_overview()),
            ("account_request_diagnostic", lambda client: client.get_account_request_diagnostic("req_sdk")),
        ]

        for name, invoke in cases:
            with self.subTest(fixture=name):
                client = TranscriptLayerClient(api_key="key", opener=FakeOpener([sdk_response(name)]))
                response = invoke(client)
                self.assertEqual(response.data, sdk_fixture(name))

    def test_dispatches_every_bearer_operation_in_openapi(self) -> None:
        contract = CONTRACT
        operations: list[tuple[str, str, dict[str, Any]]] = []
        for path, path_item in contract["paths"].items():
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                security = operation.get("security", contract.get("security", []))
                if any("bearerKey" in requirement for requirement in security):
                    operations.append((path, method.upper(), operation))
        self.assertTrue(operations, "OpenAPI must expose bearer operations")

        def snake_case(value: str) -> str:
            return re.sub(r"[A-Z]", lambda match: f"_{match.group(0).lower()}", value)

        def sample(name: str) -> str:
            return "req_contract" if name == "request_id" else f"{re.sub(r'_id$', '', name)}_contract"

        for path, expected_method, operation in operations:
            with self.subTest(operation=operation["operationId"]):
                calls: list[tuple[str, str, dict[str, Any]]] = []
                client = TranscriptLayerClient(api_key="contract_key", opener=FakeOpener([]))

                def request(method: str, request_path: str, **options: Any) -> Any:
                    calls.append((method, request_path, options))
                    return object()

                client.request = request  # type: ignore[method-assign]
                method_name = snake_case(operation["operationId"])
                client_method = getattr(client, method_name, None)
                self.assertTrue(callable(client_method), f"Python SDK lacks {method_name}")
                placeholders = re.findall(r"\{([^}]+)\}", path)
                arguments: list[Any] = [sample(name) for name in placeholders]
                if not arguments and "requestBody" in operation:
                    arguments.append({})
                client_method(*arguments)

                self.assertEqual(len(calls), 1, f"{method_name} must dispatch exactly one request")
                actual_method, actual_path, options = calls[0]
                expected_path = re.sub(r"\{([^}]+)\}", lambda match: sample(match.group(1)), path)
                self.assertEqual(actual_method, expected_method)
                self.assertEqual(urlsplit(actual_path).path, expected_path)
                self.assertEqual(options.get("has_body", False), "requestBody" in operation)

    def test_credentials_metadata_and_unknown_fields(self) -> None:
        pending = contract_example("PendingTranscript", id="tr_1")
        pending["future_field"] = {"kept": True}
        opener = FakeOpener([FakeResponse(202, pending, {
            "content-type": "application/json",
            "x-request-id": "req_1",
            "x-credits-charged": "0",
            "x-ratelimit-limit": "20",
            "x-ratelimit-remaining": "19",
            "x-ratelimit-reset": "123",
            "x-transcriptlayer-thumbnail-cache": "coalesced",
            "location": "/v1/transcripts/tr_1",
        })])
        client = TranscriptLayerClient(api_key="tl_test_secret", opener=opener)
        self.assertNotIn("tl_test_secret", repr(client))
        response = client.create_transcript({"source": {"platform": "youtube", "id": "abcdefghijk"}}, respond_async=True)
        request = opener.requests[0]
        self.assertNotIn("tl_test_secret", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "Bearer tl_test_secret")
        self.assertEqual(request.get_header("User-agent"), "transcriptlayer-python/0.1.0b1")
        self.assertEqual(request.get_header("Prefer"), "respond-async")
        self.assertRegex(request.get_header("Idempotency-key"), r"^[0-9a-f-]{36}$")
        self.assertEqual(response.data["future_field"], {"kept": True})
        self.assertEqual(response.request_id, "req_1")
        self.assertEqual(response.rate_limit.remaining, 19)
        self.assertEqual(response.location, "/v1/transcripts/tr_1")
        self.assertEqual(response.thumbnail_cache, "coalesced")

    def test_problem_is_structured_and_not_retried(self) -> None:
        problem = contract_example("RateLimitedProblem")
        headers = Message()
        headers["content-type"] = "application/problem+json"
        headers["x-request-id"] = "req_header"
        headers["x-credits-charged"] = "0"
        headers["x-ratelimit-limit"] = "20"
        headers["x-ratelimit-remaining"] = "0"
        headers["x-ratelimit-reset"] = "123"
        headers["location"] = "/v1/transcripts/tr_limited"
        headers["retry-after"] = "9"
        headers["etag"] = '"problem-v1"'
        error = HTTPError("https://api.transcriptlayer.com/v1/account", 429, "limited", headers, io.BytesIO(json.dumps(problem).encode()))
        opener = FakeOpener([error])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        with self.assertRaises(TranscriptLayerError) as raised:
            client.get_account()
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.code, "rate_limited")
        self.assertEqual(raised.exception.request_id, "req_header")
        self.assertEqual(raised.exception.credits_charged, 0)
        self.assertEqual(raised.exception.rate_limit.remaining, 0)
        self.assertEqual(raised.exception.location, "/v1/transcripts/tr_limited")
        self.assertEqual(raised.exception.etag, '"problem-v1"')
        self.assertEqual(raised.exception.retry_after, "9")
        self.assertEqual(raised.exception.retry_after_seconds, 9)
        self.assertEqual(len(opener.requests), 1)

    def test_invalid_problem_keeps_response_diagnostics(self) -> None:
        headers = Message()
        headers["content-type"] = "application/problem+json"
        headers["x-request-id"] = "req_invalid"
        headers["x-ratelimit-limit"] = "not-an-integer"
        headers["retry-after"] = "Wed, 26 Aug 2026 12:00:00 GMT"
        error = HTTPError("https://api.transcriptlayer.com/v1/account", 503, "failed", headers, io.BytesIO(b"{broken"))
        client = TranscriptLayerClient(api_key="key", opener=FakeOpener([error]))
        with self.assertRaises(TranscriptLayerError) as raised:
            client.get_account()
        self.assertEqual(raised.exception.status, 502)
        self.assertEqual(raised.exception.problem["upstream_status"], 503)
        self.assertEqual(raised.exception.request_id, "req_invalid")
        self.assertIsNone(raised.exception.rate_limit.limit)
        self.assertEqual(raised.exception.retry_after, "Wed, 26 Aug 2026 12:00:00 GMT")
        self.assertIsNone(raised.exception.retry_after_seconds)

    def test_api_key_creation_accepts_a_caller_retry_key(self) -> None:
        opener = FakeOpener([sdk_response("api_key_with_secret", id="key_new")])
        client = TranscriptLayerClient(api_key="tl_test_secret", opener=opener)
        client.create_api_key(
            {"name": "Deploy", "scopes": ["transcripts:read"]},
            idempotency_key="deploy-key",
        )
        self.assertEqual(opener.requests[0].get_header("Idempotency-key"), "deploy-key")

    def test_rejects_unsafe_origins_and_paths(self) -> None:
        with self.assertRaisesRegex(TypeError, "HTTPS"):
            TranscriptLayerClient(api_key="key", base_url="http://api.example.com")
        with self.assertRaisesRegex(TypeError, "safe characters"):
            TranscriptLayerClient(api_key="key\nleak")
        client = TranscriptLayerClient(api_key="key", opener=FakeOpener([]))
        with self.assertRaisesRegex(TypeError, "path must stay"):
            client.request("GET", "/v1/../outside")
        with self.assertRaisesRegex(TypeError, "1 to 200"):
            client.list_usage(limit=201)

    def test_lists_batches_with_pagination(self) -> None:
        opener = FakeOpener([sdk_response("batch_page")])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        client.list_batches(cursor="signed", limit=25)
        self.assertEqual(opener.requests[0].full_url, "https://api.transcriptlayer.com/v1/batches?cursor=signed&limit=25")

    def test_iterates_bounded_pages_without_hiding_response_diagnostics(self) -> None:
        opener = FakeOpener([
            unchecked_control_flow_response(200, {"items": [{"id": "tr_1"}], "next_cursor": "signed-next"}, {
                "content-type": "application/json", "x-request-id": "req_page_1",
            }),
            unchecked_control_flow_response(200, {"items": [{"id": "tr_2"}], "next_cursor": None}, {
                "content-type": "application/json", "x-request-id": "req_page_2",
            }),
        ])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        pages = list(client.iterate_transcript_pages(limit=25, max_pages=2))
        self.assertEqual([page.request_id for page in pages], ["req_page_1", "req_page_2"])
        self.assertEqual([request.full_url for request in opener.requests], [
            "https://api.transcriptlayer.com/v1/transcripts?limit=25",
            "https://api.transcriptlayer.com/v1/transcripts?cursor=signed-next&limit=25",
        ])

        repeated = TranscriptLayerClient(api_key="key", opener=FakeOpener([
            sdk_response("usage_page", items=[], next_cursor="same"),
        ]))
        with self.assertRaises(TranscriptLayerError) as repeated_raised:
            list(repeated.iterate_usage_pages(cursor="same"))
        self.assertEqual(repeated_raised.exception.code, "invalid_api_response")

        bounded = TranscriptLayerClient(api_key="key", opener=FakeOpener([
            sdk_response("batch_page", next_cursor="more"),
        ]))
        iterator = bounded.iterate_batch_pages(max_pages=1)
        self.assertEqual(next(iterator).data["next_cursor"], "more")
        with self.assertRaises(TranscriptLayerError) as bounded_raised:
            next(iterator)
        self.assertEqual(bounded_raised.exception.code, "pagination_limit_reached")
        with self.assertRaisesRegex(TypeError, "1 to 10000"):
            bounded.iterate_webhook_delivery_pages(max_pages=0)

    def test_addresses_exact_request_diagnostics_safely(self) -> None:
        opener = FakeOpener([sdk_response("account_request_diagnostic", request_id="req_123")])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        client.get_account_request_diagnostic("req_123")
        self.assertEqual(opener.requests[0].full_url, "https://api.transcriptlayer.com/v1/analytics/requests/req_123")
        with self.assertRaisesRegex(TypeError, "request ID"):
            client.get_account_request_diagnostic("req_bad/path")

    def test_waits_for_transcript_with_etags_and_returns_terminal_response(self) -> None:
        not_modified_headers = Message()
        not_modified_headers["etag"] = '"tr-v1"'
        not_modified = HTTPError(
            "https://api.transcriptlayer.com/v1/transcripts/tr_wait",
            304,
            "not modified",
            not_modified_headers,
            io.BytesIO(),
        )
        opener = FakeOpener([
            FakeResponse(200, contract_example("PendingTranscript", id="tr_wait"), {
                "content-type": "application/json", "etag": '"tr-v1"',
            }),
            not_modified,
            FakeResponse(200, contract_example("CompletedTranscript", id="tr_wait"), {
                "content-type": "application/json", "etag": '"tr-v2"', "x-request-id": "req_done",
            }),
        ])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        clock = [0.0]
        with patch("transcriptlayer.client.time.monotonic", side_effect=lambda: clock[0]), patch(
            "transcriptlayer.client.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        ):
            response = client.wait_for_transcript("tr_wait", timeout_seconds=10, poll_interval_seconds=1)
        self.assertEqual(response.data["status"], "completed")
        self.assertEqual(response.request_id, "req_done")
        self.assertIsNone(opener.requests[0].get_header("If-none-match"))
        self.assertEqual(opener.requests[1].get_header("If-none-match"), '"tr-v1"')
        self.assertEqual(opener.requests[2].get_header("If-none-match"), '"tr-v1"')

    def test_waits_are_bounded_and_reject_invalid_resources(self) -> None:
        opener = FakeOpener([
            unchecked_control_flow_response(200, {"id": "tr_wait", "status": "processing"}, {
                "content-type": "application/json",
            }),
        ])
        client = TranscriptLayerClient(api_key="key", timeout_seconds=30, opener=opener)
        clock = [0.0]
        with patch("transcriptlayer.client.time.monotonic", side_effect=lambda: clock[0]), patch(
            "transcriptlayer.client.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        ):
            with self.assertRaises(TranscriptLayerError) as raised:
                client.wait_for_transcript("tr_wait", timeout_seconds=1, poll_interval_seconds=1)
        self.assertEqual(raised.exception.code, "wait_timeout")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.timeouts, [1.0])

        timed_out_opener = FakeOpener([TimeoutError("timed out")])
        timed_out = TranscriptLayerClient(api_key="key", timeout_seconds=30, opener=timed_out_opener)
        with patch("transcriptlayer.client.time.monotonic", side_effect=[0.0, 0.0, 1.0]):
            with self.assertRaises(TranscriptLayerError) as timeout_raised:
                timed_out.wait_for_transcript("tr_wait", timeout_seconds=1, poll_interval_seconds=1)
        self.assertEqual(timeout_raised.exception.code, "wait_timeout")
        self.assertEqual(timed_out_opener.timeouts, [1.0])

        problem_headers = Message()
        problem_headers["content-type"] = "application/problem+json"
        rate_limited = HTTPError(
            "https://api.transcriptlayer.com/v1/transcripts/tr_wait", 429, "limited", problem_headers,
            io.BytesIO(b'{"code":"rate_limited","retryable":true}'),
        )
        failed_opener = FakeOpener([rate_limited])
        failed = TranscriptLayerClient(api_key="key", opener=failed_opener)
        with self.assertRaises(TranscriptLayerError) as failure_raised:
            failed.wait_for_transcript("tr_wait")
        self.assertEqual(failure_raised.exception.code, "rate_limited")
        self.assertEqual(len(failed_opener.requests), 1, "wait helpers must not retry failed requests")

        invalid = TranscriptLayerClient(api_key="key", opener=FakeOpener([
            unchecked_control_flow_response(200, {"id": "tr_other", "status": "completed"}, {
                "content-type": "application/json",
            }),
        ]))
        with self.assertRaises(TranscriptLayerError) as invalid_raised:
            invalid.wait_for_transcript("tr_wait")
        self.assertEqual(invalid_raised.exception.code, "invalid_api_response")
        with self.assertRaisesRegex(TypeError, "0.1 to 60"):
            invalid.wait_for_transcript("tr_wait", poll_interval_seconds=0.09)

    def test_waits_for_batch_through_cancelling_state(self) -> None:
        opener = FakeOpener([
            FakeResponse(200, contract_example("QueuedBatch", id="bat_wait", status="cancelling"), {
                "content-type": "application/json",
            }),
            FakeResponse(200, contract_example("CancelledBatch", id="bat_wait"), {"content-type": "application/json"}),
        ])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        clock = [0.0]
        with patch("transcriptlayer.client.time.monotonic", side_effect=lambda: clock[0]), patch(
            "transcriptlayer.client.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        ):
            response = client.wait_for_batch("bat_wait", timeout_seconds=10, poll_interval_seconds=1)
        self.assertEqual(response.data["status"], "cancelled")
        self.assertEqual(urlsplit(opener.requests[0].full_url).path, "/v1/batches/bat_wait")

    def test_failed_batch_retry_filters_cooldown_and_permanent_failures(self) -> None:
        source_batch = contract_example(
            "CancelledBatch",
            id="bat_source",
            status="completed",
            counts={"total": 2, "queued": 0, "processing": 0, "completed": 2, "failed": 0, "cancelled": 0},
        )
        opener = FakeOpener([
            FakeResponse(200, source_batch, {"content-type": "application/json"}),
            unchecked_control_flow_response(200, {"items": [{
                "reference": "elapsed",
                "transcript": {
                    "status": "failed", "error": {"retryable": True, "retry_after_seconds": 60},
                    "updated_at": "2026-08-22T11:58:00Z",
                    "requested": {"source": {"platform": "youtube", "id": "aaaaaaaaaaa"}},
                },
            }, {
                "reference": "permanent",
                "transcript": {
                    "status": "failed", "error": {"retryable": False},
                    "updated_at": "2026-08-22T11:00:00Z",
                    "requested": {"source": {"platform": "youtube", "id": "bbbbbbbbbbb"}},
                },
            }], "next_cursor": None}, {"content-type": "application/json"}),
            FakeResponse(202, contract_example("QueuedBatch", id="bat_retry"), {"content-type": "application/json"}),
        ])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        response = client.retry_failed_batch("bat_source", idempotency_key="retry-key", now=1787400000.0)
        self.assertEqual(response.data["id"], "bat_retry")
        create = opener.requests[-1]
        self.assertEqual(create.get_header("Idempotency-key"), "retry-key")
        self.assertEqual(json.loads(create.data), {
            "items": [{"source": {"platform": "youtube", "id": "aaaaaaaaaaa"}, "reference": "elapsed"}],
        })

    def test_failed_batch_retry_requires_a_caller_owned_key_before_reading_the_source(self) -> None:
        opener = FakeOpener([])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        with self.assertRaisesRegex(TypeError, "idempotency_key"):
            client.retry_failed_batch("bat_source")  # type: ignore[call-arg]
        self.assertEqual(opener.requests, [])

    def test_failed_batch_retry_replays_the_exact_key_and_body_only_after_a_caller_retry(self) -> None:
        source = {"id": "bat_source", "status": "completed"}
        items = {"items": [{
            "reference": "elapsed",
            "transcript": {
                "status": "failed",
                "error": {"retryable": True, "retry_after_seconds": 60},
                "updated_at": "2026-08-22T11:58:00Z",
                "requested": {"source": {"platform": "youtube", "id": "aaaaaaaaaaa"}},
            },
        }], "next_cursor": None}
        opener = FakeOpener([
            unchecked_control_flow_response(200, source, {"content-type": "application/json"}),
            unchecked_control_flow_response(200, items, {"content-type": "application/json"}),
            URLError("connection reset after request write"),
            unchecked_control_flow_response(200, source, {"content-type": "application/json"}),
            unchecked_control_flow_response(200, items, {"content-type": "application/json"}),
            unchecked_control_flow_response(202, {"id": "bat_retry", "status": "queued"}, {"content-type": "application/json"}),
        ])
        client = TranscriptLayerClient(api_key="key", opener=opener)
        options = {"idempotency_key": "retry-ambiguous", "now": 1787400000.0}
        with self.assertRaises(TranscriptLayerError) as raised:
            client.retry_failed_batch("bat_source", **options)
        self.assertEqual(raised.exception.code, "transport_error")
        posts = [request for request in opener.requests if request.get_method() == "POST"]
        self.assertEqual(len(posts), 1, "the helper must not retry an ambiguous POST automatically")
        replay = client.retry_failed_batch("bat_source", **options)
        self.assertEqual(replay.data["id"], "bat_retry")
        posts = [request for request in opener.requests if request.get_method() == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0].get_header("Idempotency-key"), "retry-ambiguous")
        self.assertEqual(posts[1].get_header("Idempotency-key"), "retry-ambiguous")
        self.assertEqual(posts[1].data, posts[0].data)


if __name__ == "__main__":
    unittest.main()
