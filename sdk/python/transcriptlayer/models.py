"""Generated OpenAPI models. Run ``npm run generate:sdks``."""



from __future__ import annotations



from typing import Any, Literal, NotRequired, TypeAlias, TypedDict



class ServiceLevelPeriod(TypedDict):
    object: Literal["service_level_period"]
    service_level: Literal["api_cached_delivery"]
    scope: dict[str, Any]
    target_percent: Literal[99.5]
    period_start: str
    period_end: str
    evaluated_at: str
    status: Literal["measuring", "met", "missed", "unknown"]
    availability_percent: float | None
    coverage: dict[str, Any]
    synthetic: dict[str, Any]
    operations: dict[str, Any]
    incidents: dict[str, Any]

class ServiceStatus(TypedDict):
    object: Literal["service_status"]
    status: Literal["operational", "degraded", "major_outage", "unknown"]
    components: list[dict[str, Any]]
    incidents: list[ServiceIncident]
    observed_at: str | None
    stale: bool

class ServiceIncident(TypedDict):
    id: str
    object: Literal["service_incident"]
    title: str
    impact: Literal["degraded", "partial_outage", "major_outage", "maintenance"]
    status: Literal["investigating", "identified", "monitoring", "resolved"]
    components: list[Literal["api", "transcript_processing", "webhook_delivery"]]
    created_at: str
    updated_at: str
    resolved_at: str | None
    updates: list[ServiceIncidentUpdate]

class ServiceIncidentUpdate(TypedDict):
    id: str
    object: Literal["service_incident_update"]
    status: Literal["investigating", "identified", "monitoring", "resolved"]
    message: str
    created_at: str

class CreditBalance(TypedDict):
    granted: int
    remaining: int
    reserved: int
    spendable: int
    used: int

class AccountFunding(TypedDict):
    status: Literal["active", "suspended"]
    debt_credits: int

class Account(TypedDict):
    id: str
    object: Literal["account"]
    status: Literal["active", "suspended", "closed"]
    credits: CreditBalance
    funding: AccountFunding
    created_at: str
    updated_at: str

class OwnerSession(TypedDict):
    object: Literal["owner_session"]
    account: dict[str, Any]
    user: dict[str, Any]

class AccountConfirmation(TypedDict):
    confirmation: str

class AccountClosure(TypedDict):
    id: str
    object: Literal["account_closure"]
    account_id: str
    status: Literal["pending", "processing", "completed"]
    accepted_at: str

class Money(TypedDict):
    total: int
    currency: str

class BillingReceiptAmount(TypedDict):
    total: int
    refunded: int
    disputed: int
    currency: str

class BillingCatalog(TypedDict):
    object: Literal["billing_catalog"]
    checkout_status: Literal["available", "reconciliation_delayed"]
    plans: list[dict[str, Any]]
    subscription: None | dict[str, Any]
    top_ups: list[dict[str, Any]]

class BillingSubscription(TypedDict):
    object: Literal["billing_subscription"]
    plan: Literal["monthly", "annual"]
    status: Literal["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]
    cancel_at_period_end: Literal[true]
    current_period_end: str

class CreateBillingCheckoutRequest(TypedDict):
    price_version: str

class BillingCheckout(TypedDict):
    id: str
    object: Literal["checkout_session"]
    status: Literal["open", "complete", "expired"]
    payment_status: Literal["paid", "unpaid", "no_payment_required"]
    url: str | None
    expires_at: str
    created: bool

class BillingReceipt(TypedDict):
    id: str
    object: Literal["billing_receipt"]
    checkout_session_id: str | None
    type: Literal["one_time", "subscription", "top_up"]
    plan: Literal["monthly", "annual", null]
    status: Literal["pending", "paid", "refunded", "disputed", "failed", "reconciliation_delayed"]
    credits: dict[str, Any]
    amount: BillingReceiptAmount
    paid_at: str | None
    created_at: str
    updated_at: str

class BillingReceiptPage(TypedDict):
    items: list[BillingReceipt]
    next_cursor: str | None

class CreateApiKeyRequest(TypedDict):
    name: str
    scopes: list[ApiKeyScope]
    expires_at: NotRequired[str | None]

class ApiKey(TypedDict):
    id: str
    object: Literal["api_key"]
    name: str
    scopes: list[ApiKeyScope]
    status: Literal["active", "expired", "revoked"]
    current: bool
    created_at: str
    expires_at: str | None
    last_used_at: str | None
    revoked_at: str | None

class ApiKeyWithSecret(TypedDict):
    id: str
    object: Literal["api_key"]
    name: str
    scopes: list[ApiKeyScope]
    status: Literal["active", "expired", "revoked"]
    current: bool
    created_at: str
    expires_at: str | None
    last_used_at: str | None
    revoked_at: str | None
    secret: str

class ApiKeyList(TypedDict):
    items: list[ApiKey]
    limit: Literal[20]

class ApiKeyRevocation(TypedDict):
    object: Literal["api_key_revocation"]
    account_id: str
    status: Literal["completed"]
    revoked_at: str

class SourceReference(TypedDict):
    url: NotRequired[str]
    platform: NotRequired[str]
    id: NotRequired[str]

class CreateTranscriptCore(TypedDict):
    source: SourceReference
    track_id: NotRequired[str]
    language_preferences: NotRequired[list[str]]
    caption_kinds: NotRequired[list[Literal["manual", "automatic", "unknown"]]]
    language_fallback: NotRequired[Literal["none", "any"]]
    content_format: NotRequired[Literal["segments", "text", "both"]]
    max_age_seconds: NotRequired[int]
    allow_stale_on_error: NotRequired[bool]
    include: NotRequired[list[Literal["metadata", "available_tracks"]]]
    reference: NotRequired[str]
    webhook_endpoint_id: NotRequired[str]

class CreateTranscriptRequest(CreateTranscriptCore):
    pass

class Source(TypedDict):
    platform: str
    id: str
    url: str

class Track(TypedDict):
    id: str
    language: str
    name: str
    kind: Literal["manual", "automatic", "unknown"]
    fallback_applied: NotRequired[bool]

class Segment(TypedDict):
    start_ms: int
    duration_ms: int
    text: str

class TranscriptContent(TypedDict):
    url: str
    available_formats: list[Literal["text", "json", "srt", "vtt"]]
    included: Literal["none", "segments", "text", "both"]
    text: NotRequired[str]
    segments: NotRequired[list[Segment]]

class Retrieval(TypedDict):
    cache_status: Literal["hit", "miss", "refresh"]
    observed_at: str
    access_validated_at: str
    access_validation_age_seconds: int
    cache_age_seconds: int
    stale: bool
    source_market: str
    content_sha256: str
    refresh_error: NotRequired[OutcomeError | None]

class Usage(TypedDict):
    credits_charged: Literal[0, 1]

class Transcript(TypedDict):
    id: str
    request_id: str
    object: Literal["transcript"]
    status: Literal["queued", "processing", "completed", "failed", "cancelled"]
    source: Source
    requested: CreateTranscriptCore
    track: NotRequired[Track]
    available_tracks: NotRequired[list[Track]]
    metadata: NotRequired[dict[str, Any]]
    content: NotRequired[TranscriptContent]
    retrieval: NotRequired[Retrieval]
    usage: Usage
    poll_url: NotRequired[str]
    error: NotRequired[OutcomeError]
    created_at: str
    updated_at: str
    completed_at: NotRequired[str]
    access_expires_at: NotRequired[str]

class TerminalTranscript(Transcript):
    status: NotRequired[Literal["completed", "failed"]]

class PendingTranscript(Transcript):
    status: NotRequired[Literal["queued", "processing"]]

class TranscriptReferenceOnly(Transcript):
    pass

class TranscriptPage(TypedDict):
    items: list[TranscriptReferenceOnly]
    next_cursor: str | None

class CreateBatchItem(CreateTranscriptCore):
    reference: str

class CreateBatchRequest(TypedDict):
    items: list[CreateBatchItem]
    webhook_endpoint_id: NotRequired[str]

class BatchCounts(TypedDict):
    total: int
    queued: int
    processing: int
    completed: int
    failed: int
    cancelled: int

class Batch(TypedDict):
    id: str
    object: Literal["batch"]
    status: Literal["queued", "processing", "cancelling", "completed", "cancelled"]
    counts: BatchCounts
    created_at: str
    updated_at: str
    completed_at: NotRequired[str]

class BatchPage(TypedDict):
    items: list[Batch]
    next_cursor: str | None

class VisibleBatchItem(TypedDict):
    position: int
    reference: str
    transcript: TranscriptReferenceOnly

class DeletedBatchItem(TypedDict):
    position: int
    deleted: Literal[true]

class BatchItemPage(TypedDict):
    items: list[BatchItem]
    next_cursor: str | None

class UsageEntry(TypedDict):
    id: str
    transcript_id: str
    credits: Literal[1]
    reason: Literal["selected_track_completed"]
    created_at: str

class UsagePage(TypedDict):
    items: list[UsageEntry]
    next_cursor: str | None

class AccountAnalyticsMetrics(TypedDict):
    admitted: int
    completed: int
    failed: int
    cancelled: int
    credits: int
    cache_hits: int
    cache_misses: int
    cache_refreshes: int
    stale_deliveries: int
    latency_samples: int
    total_latency_ms: int
    segments: int
    content_bytes: int
    completion_rate: float
    failure_rate: float
    cancellation_rate: float
    average_latency_ms: int | None
    p50_latency_upper_bound_ms: int | None
    p95_latency_upper_bound_ms: int | None
    p99_latency_upper_bound_ms: int | None
    latency_overflow_samples: int

class AccountAnalyticsHour(TypedDict):
    bucket_start: str
    admitted: int
    completed: int
    failed: int
    cancelled: int
    credits: int
    cache_hits: int
    cache_misses: int
    cache_refreshes: int
    stale_deliveries: int
    latency_samples: int
    total_latency_ms: int
    segments: int
    content_bytes: int

class ExecutionAnalyticsMetrics(TypedDict):
    processing_samples: int
    source_samples: int
    diagnostic_samples: int
    source_attempts: int
    capacity_waits: int
    average_queue_latency_ms: int | None
    average_processing_latency_ms: int | None
    average_source_wait_ms: int | None
    average_source_execution_ms: int | None

class AccountAnalyticsOutcome(TypedDict):
    outcome: str
    count: int

class AccountAnalyticsRequest(TypedDict):
    transcript_id: str
    request_id: str
    status: Literal["queued", "processing", "completed", "failed", "cancelled"]
    cache_status: Literal["hit", "miss", "refresh", null]
    stale: bool
    error_code: str | None
    retryable: bool | None
    credits_charged: Literal[0, 1]
    track_language: str | None
    track_kind: Literal["manual", "automatic", null]
    segment_count: int | None
    content_bytes: int | None
    total_latency_ms: int | None
    queue_latency_ms: int | None
    processing_latency_ms: int | None
    source_attempts: int | None
    capacity_waits: int | None
    source_last_attempt_at: str | None
    created_at: str
    processing_at: str | None
    completed_at: str | None
    updated_at: str

class AccountAnalyticsOverview(TypedDict):
    window_hours: Literal[24, 168, 720]
    observed_at: str
    totals: AccountAnalyticsMetrics
    execution: ExecutionAnalyticsMetrics
    series: list[AccountAnalyticsHour]
    outcomes: list[AccountAnalyticsOutcome]
    recent_requests: list[AccountAnalyticsRequest]

class CreateWebhookEndpointRequest(TypedDict):
    name: str
    url: str

class WebhookEndpoint(TypedDict):
    id: str
    object: Literal["webhook_endpoint"]
    name: str
    url: str
    status: Literal["pending_verification", "enabled"]
    signing_key_id: str
    signing_secret: NotRequired[str]
    previous_signing_key_id: NotRequired[str]
    previous_secret_expires_at: NotRequired[str]
    verified_at: NotRequired[str]
    last_verification_attempt_at: NotRequired[str]
    last_verification_error: NotRequired[str]
    created_at: str
    updated_at: str

class WebhookEndpointWithSecret(WebhookEndpoint):
    signing_secret: str

class WebhookEndpointList(TypedDict):
    items: list[WebhookEndpoint]

class WebhookDeliveryAttempt(TypedDict):
    id: str
    number: int
    attempted_at: str
    duration_ms: int
    http_status: NotRequired[int]
    error: NotRequired[Literal["dns_rejected", "tls_error", "timeout", "network_error", "transport_error", "response_too_large", "protocol_error"]]

class WebhookDelivery(TypedDict):
    id: str
    object: Literal["webhook_delivery"]
    endpoint_id: str
    event: WebhookEvent
    replay_of: NotRequired[str]
    status: Literal["pending", "retry_scheduled", "delivered", "exhausted"]
    attempt_count: int
    attempts: list[WebhookDeliveryAttempt]
    next_attempt_at: NotRequired[str]
    delivered_at: NotRequired[str]
    exhausted_at: NotRequired[str]
    last_error: NotRequired[str]
    retention_expires_at: NotRequired[str]
    created_at: str
    updated_at: str

class WebhookDeliveryPage(TypedDict):
    items: list[WebhookDelivery]
    next_cursor: str | None

class WebhookEvent(TypedDict):
    id: str
    object: Literal["event"]
    api_version: Literal["2026-08-21"]
    type: Literal["transcript.completed", "transcript.failed", "transcript.cancelled", "batch.completed", "batch.cancelled"]
    created_at: str
    resource: dict[str, Any]

class OutcomeError(TypedDict):
    code: Literal["source_not_found", "source_removed", "source_private", "source_restricted", "source_live_not_ready", "transcript_unavailable", "track_not_available", "source_too_large", "upstream_enforcement", "proxy_unavailable", "temporarily_unavailable", "internal_error"]
    detail: str
    request_id: str
    retryable: bool
    retry_after_seconds: NotRequired[int]
    observed_at: NotRequired[str]
    cache_status: NotRequired[Literal["hit", "miss", "refresh"]]

class Problem(TypedDict):
    type: str
    title: str
    status: int
    code: Literal["invalid_request", "invalid_api_key", "insufficient_credits", "funding_suspended", "forbidden", "resource_not_found", "resource_not_ready", "caption_access_expired", "idempotency_conflict", "idempotency_resource_deleted", "idempotency_secret_unavailable", "request_not_cancellable", "endpoint_limit_exceeded", "api_key_limit_exceeded", "last_management_key", "webhook_verification_failed", "webhook_delivery_not_replayable", "webhook_secret_rotation_blocked", "payload_too_large", "invalid_source", "temporarily_unavailable", "account_recovery_capacity", "rate_limited", "checkout_rate_limited", "control_plane_rate_limited", "internal_error"]
    detail: str
    request_id: str
    retryable: bool
    retry_after_seconds: NotRequired[int]
    resource_id: NotRequired[str]
    access_expires_at: NotRequired[str]

ApiKeyScope: TypeAlias = Literal["account:read", "api_keys:read", "api_keys:write", "analytics:read", "batches:read", "batches:write", "transcripts:read", "transcripts:write", "webhooks:read", "webhooks:write"]

BatchItem: TypeAlias = VisibleBatchItem | DeletedBatchItem

