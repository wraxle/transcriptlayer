from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from email.message import Message
from typing import Any, Callable, Generic, Iterator, TypeVar
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import models

DEFAULT_BASE_URL = "https://api.transcriptlayer.com"
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_WAIT_TIMEOUT_SECONDS = 300.0
DEFAULT_POLL_INTERVAL_SECONDS = 2.0
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024
TRANSCRIPT_STATES = {"queued", "processing", "completed", "failed", "cancelled"}
TERMINAL_TRANSCRIPT_STATES = {"completed", "failed", "cancelled"}
BATCH_STATES = {"queued", "processing", "cancelling", "completed", "cancelled"}
TERMINAL_BATCH_STATES = {"completed", "cancelled"}

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class RateLimitMetadata:
    limit: int | None
    remaining: int | None
    reset: int | None


@dataclass(frozen=True, slots=True)
class ApiResponse(Generic[T]):
    data: T
    status: int
    request_id: str | None
    credits_charged: int | None
    rate_limit: RateLimitMetadata
    location: str | None
    etag: str | None
    retry_after: str | None
    thumbnail_cache: str | None


@dataclass(frozen=True, slots=True)
class _ResponseDiagnostics:
    request_id: str | None
    credits_charged: int | None
    rate_limit: RateLimitMetadata
    location: str | None
    etag: str | None
    retry_after: str | None
    thumbnail_cache: str | None


class TranscriptLayerError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        problem: dict[str, Any] | None = None,
        diagnostics: _ResponseDiagnostics | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.problem = problem
        self.code = str(problem.get("code", "transport_error" if status == 0 else "api_error")) if problem else (
            "transport_error" if status == 0 else "api_error"
        )
        self.request_id = diagnostics.request_id if diagnostics and diagnostics.request_id is not None else (
            str(problem["request_id"]) if problem and problem.get("request_id") is not None else None
        )
        self.credits_charged = diagnostics.credits_charged if diagnostics else None
        self.rate_limit = diagnostics.rate_limit if diagnostics else RateLimitMetadata(None, None, None)
        self.location = diagnostics.location if diagnostics else None
        self.etag = diagnostics.etag if diagnostics else None
        self.retry_after = diagnostics.retry_after if diagnostics else None
        self.thumbnail_cache = diagnostics.thumbnail_cache if diagnostics else None
        self.retryable = problem is not None and problem.get("retryable") is True
        header_seconds = _safe_integer(self.retry_after) if self.retry_after is not None and re.fullmatch(r"\d+", self.retry_after) else None
        problem_seconds = problem.get("retry_after_seconds") if problem else None
        self.retry_after_seconds = header_seconds if header_seconds is not None else (
            problem_seconds if isinstance(problem_seconds, int) and not isinstance(problem_seconds, bool)
            and 0 <= problem_seconds <= 9_007_199_254_740_991 else None
        )


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request: Request, file_pointer: Any, code: int, message: str, headers: Message, new_url: str) -> None:
        return None


def _safe_value(value: str, label: str, maximum: int = 1_000) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or any(character in value for character in "\r\n\0"):
        raise TypeError(f"{label} must contain 1 to {maximum} safe characters")
    return value


def _request_id(value: str) -> str:
    safe = _safe_value(value, "request ID", 200)
    if re.fullmatch(r"req_[A-Za-z0-9]+", safe) is None:
        raise TypeError("request ID has an invalid format")
    return safe


def _validate_base_url(raw: str) -> str:
    parts = urlsplit(raw)
    local_http = parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}
    if parts.scheme != "https" and not local_http:
        raise TypeError("base_url must use HTTPS; HTTP is allowed only for localhost")
    if not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
        raise TypeError("base_url must be absolute and cannot contain credentials, a query, or a fragment")
    path = parts.path.rstrip("/") + "/"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _resource_id(value: str) -> str:
    from urllib.parse import quote

    return quote(_safe_value(value, "resource ID", 200), safe="")


def _query(path: str, **values: object) -> str:
    included = {name: str(value) for name, value in values.items() if value is not None}
    return f"{path}?{urlencode(included)}" if included else path


def _page_values(cursor: str | None, limit: int | None) -> dict[str, object | None]:
    if cursor is not None:
        _safe_value(cursor, "cursor")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200):
        raise TypeError("limit must be an integer from 1 to 200")
    return {"cursor": cursor, "limit": limit}


def _page_iterator_values(cursor: str | None, limit: int, max_pages: int) -> tuple[str | None, int, int]:
    _page_values(cursor, limit)
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or not 1 <= max_pages <= 10_000:
        raise TypeError("max_pages must be an integer from 1 to 10000")
    return cursor, limit, max_pages


def _idempotency_key(value: str | None) -> str:
    return str(uuid.uuid4()) if value is None else _safe_value(value, "idempotency key", 200)


def _wait_values(timeout_seconds: float, poll_interval_seconds: float) -> tuple[float, float]:
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0 < timeout_seconds <= 3_600:
        raise TypeError("timeout_seconds must be greater than 0 and at most 3600")
    if (
        isinstance(poll_interval_seconds, bool)
        or not isinstance(poll_interval_seconds, (int, float))
        or not 0.1 <= poll_interval_seconds <= 60
    ):
        raise TypeError("poll_interval_seconds must be from 0.1 to 60")
    return float(timeout_seconds), float(poll_interval_seconds)


def _wait_error(kind: str, timeout_seconds: float) -> TranscriptLayerError:
    return TranscriptLayerError(
        f"{kind} wait timed out after {timeout_seconds:g} seconds",
        problem={"code": "wait_timeout", "retryable": True},
    )


def _invalid_resource(kind: str) -> TranscriptLayerError:
    return TranscriptLayerError(
        f"API returned an invalid {kind}",
        status=502,
        problem={"code": "invalid_api_response", "retryable": False},
    )


def _read_bounded(response: Any, maximum: int) -> bytes:
    declared = response.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > maximum:
                raise TranscriptLayerError(
                    f"response exceeded {maximum} bytes",
                    status=502,
                    problem={"code": "invalid_api_response", "upstream_status": response.status, "retryable": False},
                    diagnostics=_response_diagnostics(response),
                )
        except ValueError:
            pass
    body = response.read(maximum + 1)
    if len(body) > maximum:
        raise TranscriptLayerError(
            f"response exceeded {maximum} bytes",
            status=502,
            problem={"code": "invalid_api_response", "upstream_status": response.status, "retryable": False},
            diagnostics=_response_diagnostics(response),
        )
    return body


def _parse_json(body: bytes, response: Any) -> Any:
    try:
        return {} if not body else json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TranscriptLayerError(
            "API returned invalid JSON",
            status=502,
            problem={"code": "invalid_api_response", "upstream_status": response.status, "retryable": False},
            diagnostics=_response_diagnostics(response),
        ) from error


def _safe_integer(raw: str) -> int | None:
    if re.fullmatch(r"-?\d+", raw) is None:
        return None
    parsed = int(raw)
    return parsed if -9_007_199_254_740_991 <= parsed <= 9_007_199_254_740_991 else None


def _integer_header(headers: Message, name: str) -> int | None:
    raw = headers.get(name)
    return _safe_integer(raw) if raw is not None else None


def _response_diagnostics(response: Any) -> _ResponseDiagnostics:
    thumbnail_cache = response.headers.get("x-transcriptlayer-thumbnail-cache")
    return _ResponseDiagnostics(
        request_id=response.headers.get("x-request-id"),
        credits_charged=_integer_header(response.headers, "x-credits-charged"),
        rate_limit=RateLimitMetadata(
            limit=_integer_header(response.headers, "x-ratelimit-limit"),
            remaining=_integer_header(response.headers, "x-ratelimit-remaining"),
            reset=_integer_header(response.headers, "x-ratelimit-reset"),
        ),
        location=response.headers.get("location"),
        etag=response.headers.get("etag"),
        retry_after=response.headers.get("retry-after"),
        thumbnail_cache=thumbnail_cache if thumbnail_cache in {"miss", "hit", "coalesced"} else None,
    )


def _metadata(response: Any, data: T) -> ApiResponse[T]:
    diagnostics = _response_diagnostics(response)
    return ApiResponse(
        data=data,
        status=response.status,
        request_id=diagnostics.request_id,
        credits_charged=diagnostics.credits_charged,
        rate_limit=diagnostics.rate_limit,
        location=diagnostics.location,
        etag=diagnostics.etag,
        retry_after=diagnostics.retry_after,
        thumbnail_cache=diagnostics.thumbnail_cache,
    )


class TranscriptLayerClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        opener: Any = None,
    ) -> None:
        self._api_key = _safe_value(api_key, "api_key", 512)
        self._base_url = _validate_base_url(base_url)
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0 < timeout_seconds <= 60:
            raise TypeError("timeout_seconds must be greater than 0 and at most 60")
        self._timeout_seconds = float(timeout_seconds)
        self._opener = opener if opener is not None else build_opener(_NoRedirect())

    def request(
        self,
        method: str,
        path: str,
        *,
        body: object = None,
        has_body: bool = False,
        idempotency_key: str | None = None,
        prefer: str | None = None,
        accept: str = "application/json",
        if_none_match: str | None = None,
        binary: bool = False,
        maximum_bytes: int = MAX_JSON_BYTES,
        _timeout_seconds: float | None = None,
    ) -> ApiResponse[Any]:
        if not (path == "/v1" or path.startswith("/v1/")):
            raise TypeError("path must stay under /v1")
        headers = {"Accept": accept, "Authorization": f"Bearer {self._api_key}", "User-Agent": "transcriptlayer-python/0.1.0b1"}
        data = None
        if has_body:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = _safe_value(idempotency_key, "idempotency key", 200)
        if prefer is not None:
            headers["Prefer"] = _safe_value(prefer, "Prefer", 100)
        if if_none_match is not None:
            headers["If-None-Match"] = _safe_value(if_none_match, "ETag", 500)
        url = urljoin(self._base_url, path.lstrip("/"))
        base_parts = urlsplit(self._base_url)
        target_parts = urlsplit(url)
        expected_path = f"{base_parts.path}v1"
        if (
            target_parts.scheme != base_parts.scheme
            or target_parts.netloc != base_parts.netloc
            or not (target_parts.path == expected_path or target_parts.path.startswith(f"{expected_path}/"))
        ):
            raise TypeError("path must stay under /v1")
        request = Request(url, data=data, headers=headers, method=method)
        request_timeout = self._timeout_seconds if _timeout_seconds is None else _timeout_seconds
        if isinstance(request_timeout, bool) or not isinstance(request_timeout, (int, float)) or not 0 < request_timeout <= 60:
            raise TypeError("request timeout must be greater than 0 and at most 60 seconds")
        try:
            response = self._opener.open(request, timeout=float(request_timeout))
        except HTTPError as error:
            if error.code == 304:
                try:
                    return _metadata(error, None)
                finally:
                    error.close()
            body_bytes = _read_bounded(error, MAX_JSON_BYTES)
            media_type = (error.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            problem = _parse_json(body_bytes, error) if "json" in media_type or body_bytes.lstrip().startswith(b"{") else None
            fallback = body_bytes.decode("utf-8", "replace")[:500] or f"request failed with HTTP {error.code}"
            message = str(problem.get("detail") or problem.get("title") or fallback) if isinstance(problem, dict) else fallback
            raise TranscriptLayerError(
                message,
                status=error.code,
                problem=problem if isinstance(problem, dict) else None,
                diagnostics=_response_diagnostics(error),
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            timed_out = isinstance(error, TimeoutError) or "timed out" in str(error).lower()
            raise TranscriptLayerError(
                f"request timed out after {request_timeout:g} seconds" if timed_out else "API transport failed",
                problem={"code": "request_timeout" if timed_out else "transport_error", "retryable": True},
            ) from error
        with response:
            if response.status == 204 or (binary and response.status == 202):
                return _metadata(response, None)
            body_bytes = _read_bounded(response, maximum_bytes)
            return _metadata(response, body_bytes if binary else _parse_json(body_bytes, response))

    def get_account(self) -> ApiResponse[models.Account]:
        return self.request("GET", "/v1/account")

    def list_api_keys(self) -> ApiResponse[models.ApiKeyList]:
        return self.request("GET", "/v1/api-keys")

    def create_api_key(
        self, body: models.CreateApiKeyRequest, *, idempotency_key: str | None = None,
    ) -> ApiResponse[models.ApiKeyWithSecret]:
        return self.request(
            "POST", "/v1/api-keys", body=body, has_body=True,
            idempotency_key=_idempotency_key(idempotency_key),
        )

    def revoke_api_key(self, api_key_id: str) -> ApiResponse[None]:
        return self.request("DELETE", f"/v1/api-keys/{_resource_id(api_key_id)}")

    def create_transcript(
        self,
        body: models.CreateTranscriptRequest,
        *,
        idempotency_key: str | None = None,
        wait_seconds: int | None = None,
        respond_async: bool = False,
    ) -> ApiResponse[models.TerminalTranscript | models.PendingTranscript]:
        if respond_async and wait_seconds is not None:
            raise TypeError("respond_async and wait_seconds cannot be combined")
        if wait_seconds is not None and (isinstance(wait_seconds, bool) or not isinstance(wait_seconds, int) or not 0 <= wait_seconds <= 10):
            raise TypeError("wait_seconds must be an integer from 0 to 10")
        prefer = "respond-async" if respond_async else f"wait={wait_seconds}" if wait_seconds is not None else None
        return self.request(
            "POST", "/v1/transcripts", body=body, has_body=True,
            idempotency_key=_idempotency_key(idempotency_key), prefer=prefer,
        )

    def list_transcripts(self, *, cursor: str | None = None, limit: int | None = None) -> ApiResponse[models.TranscriptPage]:
        return self.request("GET", _query("/v1/transcripts", **_page_values(cursor, limit)))

    def iterate_transcript_pages(
        self, *, cursor: str | None = None, limit: int = 100, max_pages: int = 100,
    ) -> Iterator[ApiResponse[models.TranscriptPage]]:
        values = _page_iterator_values(cursor, limit, max_pages)
        return self._iterate_pages(lambda next_cursor, page_limit: self.list_transcripts(cursor=next_cursor, limit=page_limit), values)

    def get_transcript(self, transcript_id: str, *, etag: str | None = None) -> ApiResponse[models.Transcript | None]:
        return self.request("GET", f"/v1/transcripts/{_resource_id(transcript_id)}", if_none_match=etag)

    def wait_for_transcript(
        self,
        transcript_id: str,
        *,
        timeout_seconds: float = DEFAULT_WAIT_TIMEOUT_SECONDS,
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> ApiResponse[models.Transcript]:
        return self._wait_for_resource(
            "transcript", transcript_id, TRANSCRIPT_STATES, TERMINAL_TRANSCRIPT_STATES,
            timeout_seconds, poll_interval_seconds,
        )

    def delete_transcript(self, transcript_id: str) -> ApiResponse[None]:
        return self.request("DELETE", f"/v1/transcripts/{_resource_id(transcript_id)}")

    def cancel_transcript(self, transcript_id: str) -> ApiResponse[models.Transcript]:
        return self.request("POST", f"/v1/transcripts/{_resource_id(transcript_id)}/cancel")

    def download_transcript_content(
        self, transcript_id: str, *, format: str = "json", etag: str | None = None,
    ) -> ApiResponse[models.TranscriptContent | bytes | None]:
        media_types = {"json": "application/json", "text": "text/plain", "srt": "application/x-subrip", "vtt": "text/vtt"}
        if format not in media_types:
            raise TypeError("format must be json, text, srt, or vtt")
        return self.request(
            "GET", _query(f"/v1/transcripts/{_resource_id(transcript_id)}/content", format=format),
            accept=media_types[format], if_none_match=etag, binary=format != "json",
        )

    def download_transcript_thumbnail(self, transcript_id: str, *, etag: str | None = None) -> ApiResponse[bytes | None]:
        return self.request(
            "GET", f"/v1/transcripts/{_resource_id(transcript_id)}/thumbnail",
            accept="image/jpeg, image/png, image/webp", if_none_match=etag,
            binary=True, maximum_bytes=MAX_THUMBNAIL_BYTES,
        )

    def create_batch(self, body: models.CreateBatchRequest, *, idempotency_key: str | None = None) -> ApiResponse[models.Batch]:
        return self.request("POST", "/v1/batches", body=body, has_body=True, idempotency_key=_idempotency_key(idempotency_key))

    def list_batches(self, *, cursor: str | None = None, limit: int | None = None) -> ApiResponse[models.BatchPage]:
        return self.request("GET", _query("/v1/batches", **_page_values(cursor, limit)))

    def iterate_batch_pages(
        self, *, cursor: str | None = None, limit: int = 100, max_pages: int = 100,
    ) -> Iterator[ApiResponse[models.BatchPage]]:
        values = _page_iterator_values(cursor, limit, max_pages)
        return self._iterate_pages(lambda next_cursor, page_limit: self.list_batches(cursor=next_cursor, limit=page_limit), values)

    def get_batch(self, batch_id: str, *, etag: str | None = None) -> ApiResponse[models.Batch | None]:
        return self.request("GET", f"/v1/batches/{_resource_id(batch_id)}", if_none_match=etag)

    def wait_for_batch(
        self,
        batch_id: str,
        *,
        timeout_seconds: float = DEFAULT_WAIT_TIMEOUT_SECONDS,
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> ApiResponse[models.Batch]:
        return self._wait_for_resource(
            "batch", batch_id, BATCH_STATES, TERMINAL_BATCH_STATES,
            timeout_seconds, poll_interval_seconds,
        )

    def delete_batch(self, batch_id: str) -> ApiResponse[None]:
        return self.request("DELETE", f"/v1/batches/{_resource_id(batch_id)}")

    def list_batch_items(self, batch_id: str, *, cursor: str | None = None, limit: int | None = None) -> ApiResponse[models.BatchItemPage]:
        return self.request("GET", _query(f"/v1/batches/{_resource_id(batch_id)}/items", **_page_values(cursor, limit)))

    def iterate_batch_item_pages(
        self, batch_id: str, *, cursor: str | None = None, limit: int = 100, max_pages: int = 100,
    ) -> Iterator[ApiResponse[models.BatchItemPage]]:
        _resource_id(batch_id)
        values = _page_iterator_values(cursor, limit, max_pages)
        return self._iterate_pages(
            lambda next_cursor, page_limit: self.list_batch_items(batch_id, cursor=next_cursor, limit=page_limit), values,
        )

    def cancel_batch(self, batch_id: str) -> ApiResponse[models.Batch]:
        return self.request("POST", f"/v1/batches/{_resource_id(batch_id)}/cancel")

    def retry_failed_batch(
        self, batch_id: str, *, idempotency_key: str, now: float | None = None,
    ) -> ApiResponse[models.Batch]:
        retry_key = _safe_value(idempotency_key, "idempotency key", 200)
        source = self.get_batch(batch_id).data
        if not isinstance(source, dict) or source.get("status") not in TERMINAL_BATCH_STATES:
            raise TranscriptLayerError("source batch is not terminal", status=409, problem={"code": "batch_not_terminal", "retryable": False})
        items: list[dict[str, Any]] = []
        for response in self.iterate_batch_item_pages(batch_id, limit=200, max_pages=100):
            items.extend(response.data["items"])
            if len(items) > 1_000:
                raise TranscriptLayerError("API returned more than 1,000 batch items", status=502, problem={"code": "invalid_api_response", "retryable": False})
        current = time.time() if now is None else now
        eligible: list[dict[str, Any]] = []
        for item in items:
            transcript = item.get("transcript") if isinstance(item, dict) else None
            error = transcript.get("error") if isinstance(transcript, dict) else None
            if not isinstance(error, dict) or transcript.get("status") != "failed" or error.get("retryable") is not True:
                continue
            seconds = error.get("retry_after_seconds", 0)
            timestamp = transcript.get("updated_at") or transcript.get("completed_at")
            try:
                anchor = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
            except (AttributeError, TypeError, ValueError):
                continue
            if isinstance(seconds, int) and not isinstance(seconds, bool) and seconds >= 0 and anchor + seconds <= current:
                requested = transcript.get("requested")
                if isinstance(requested, dict):
                    eligible.append({**requested, "reference": item.get("reference")})
        if not eligible:
            raise TranscriptLayerError(
                "source batch has no retryable failures whose delay has elapsed",
                status=409, problem={"code": "no_retryable_items", "retryable": False},
            )
        return self.create_batch({"items": eligible}, idempotency_key=retry_key)

    def create_webhook_endpoint(self, body: models.CreateWebhookEndpointRequest, *, idempotency_key: str | None = None) -> ApiResponse[models.WebhookEndpointWithSecret]:
        return self.request("POST", "/v1/webhook-endpoints", body=body, has_body=True, idempotency_key=_idempotency_key(idempotency_key))

    def list_webhook_endpoints(self) -> ApiResponse[models.WebhookEndpointList]:
        return self.request("GET", "/v1/webhook-endpoints")

    def get_webhook_endpoint(self, endpoint_id: str) -> ApiResponse[models.WebhookEndpoint]:
        return self.request("GET", f"/v1/webhook-endpoints/{_resource_id(endpoint_id)}")

    def delete_webhook_endpoint(self, endpoint_id: str) -> ApiResponse[None]:
        return self.request("DELETE", f"/v1/webhook-endpoints/{_resource_id(endpoint_id)}")

    def verify_webhook_endpoint(self, endpoint_id: str) -> ApiResponse[models.WebhookEndpoint]:
        return self.request("POST", f"/v1/webhook-endpoints/{_resource_id(endpoint_id)}/verify")

    def rotate_webhook_endpoint_secret(self, endpoint_id: str, *, idempotency_key: str | None = None) -> ApiResponse[models.WebhookEndpointWithSecret]:
        return self.request("POST", f"/v1/webhook-endpoints/{_resource_id(endpoint_id)}/rotate-secret", idempotency_key=_idempotency_key(idempotency_key))

    def list_webhook_deliveries(self, *, cursor: str | None = None, limit: int | None = None) -> ApiResponse[models.WebhookDeliveryPage]:
        return self.request("GET", _query("/v1/webhook-deliveries", **_page_values(cursor, limit)))

    def iterate_webhook_delivery_pages(
        self, *, cursor: str | None = None, limit: int = 100, max_pages: int = 100,
    ) -> Iterator[ApiResponse[models.WebhookDeliveryPage]]:
        values = _page_iterator_values(cursor, limit, max_pages)
        return self._iterate_pages(
            lambda next_cursor, page_limit: self.list_webhook_deliveries(cursor=next_cursor, limit=page_limit), values,
        )

    def get_webhook_delivery(self, delivery_id: str) -> ApiResponse[models.WebhookDelivery]:
        return self.request("GET", f"/v1/webhook-deliveries/{_resource_id(delivery_id)}")

    def replay_webhook_delivery(self, delivery_id: str, *, idempotency_key: str | None = None) -> ApiResponse[models.WebhookDelivery]:
        return self.request("POST", f"/v1/webhook-deliveries/{_resource_id(delivery_id)}/replay", idempotency_key=_idempotency_key(idempotency_key))

    def get_account_analytics_overview(self, *, window: str = "24h") -> ApiResponse[models.AccountAnalyticsOverview]:
        if window not in {"24h", "7d", "30d"}:
            raise TypeError("window must be 24h, 7d, or 30d")
        return self.request("GET", _query("/v1/analytics/overview", window=window))

    def get_account_request_diagnostic(self, request_id: str) -> ApiResponse[models.AccountAnalyticsRequest]:
        return self.request("GET", f"/v1/analytics/requests/{_request_id(request_id)}")

    def list_usage(self, *, cursor: str | None = None, limit: int | None = None) -> ApiResponse[models.UsagePage]:
        return self.request("GET", _query("/v1/usage", **_page_values(cursor, limit)))

    def iterate_usage_pages(
        self, *, cursor: str | None = None, limit: int = 100, max_pages: int = 100,
    ) -> Iterator[ApiResponse[models.UsagePage]]:
        values = _page_iterator_values(cursor, limit, max_pages)
        return self._iterate_pages(lambda next_cursor, page_limit: self.list_usage(cursor=next_cursor, limit=page_limit), values)

    def _iterate_pages(
        self,
        load_page: Callable[[str | None, int], ApiResponse[Any]],
        values: tuple[str | None, int, int],
    ) -> Iterator[ApiResponse[Any]]:
        cursor, limit, max_pages = values
        cursors = set() if cursor is None else {cursor}
        next_cursor = cursor
        for _ in range(max_pages):
            response = load_page(next_cursor, limit)
            page = response.data
            if (
                not isinstance(page, dict)
                or not isinstance(page.get("items"), list)
                or len(page["items"]) > 200
                or (page.get("next_cursor") is not None and not isinstance(page.get("next_cursor"), str))
            ):
                raise TranscriptLayerError(
                    "API returned an invalid page", status=502,
                    problem={"code": "invalid_api_response", "retryable": False},
                )
            next_cursor = page["next_cursor"]
            if next_cursor is not None:
                _safe_value(next_cursor, "cursor")
                if next_cursor in cursors:
                    raise TranscriptLayerError(
                        "API repeated a page cursor", status=502,
                        problem={"code": "invalid_api_response", "retryable": False},
                    )
                cursors.add(next_cursor)
            yield response
            if next_cursor is None:
                return
        raise TranscriptLayerError(
            f"pagination exceeded {max_pages} pages",
            problem={"code": "pagination_limit_reached", "retryable": False},
        )

    def _wait_for_resource(
        self,
        kind: str,
        resource_id: str,
        states: set[str],
        terminal_states: set[str],
        timeout_seconds: float,
        poll_interval_seconds: float,
    ) -> ApiResponse[Any]:
        encoded_id = _resource_id(resource_id)
        collection = "transcripts" if kind == "transcript" else "batches"
        timeout, interval = _wait_values(timeout_seconds, poll_interval_seconds)
        deadline = time.monotonic() + timeout
        etag: str | None = None
        latest: ApiResponse[Any] | None = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _wait_error(kind, timeout)
            try:
                response = self.request(
                    "GET", f"/v1/{collection}/{encoded_id}", if_none_match=etag,
                    _timeout_seconds=min(self._timeout_seconds, remaining),
                )
            except TranscriptLayerError as error:
                if time.monotonic() >= deadline:
                    raise _wait_error(kind, timeout) from error
                raise
            if response.status == 304:
                if latest is None:
                    raise _invalid_resource(kind)
            else:
                resource = response.data
                if (
                    not isinstance(resource, dict)
                    or resource.get("id") != resource_id
                    or resource.get("status") not in states
                ):
                    raise _invalid_resource(kind)
                latest = response
                etag = response.etag
                if resource["status"] in terminal_states:
                    return response
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _wait_error(kind, timeout)
            time.sleep(min(interval, remaining))
