// Generated from docs/contracts/openapi-v1.json. Run npm run generate:sdks.

// Unknown response fields remain compatible because these are structural types, not strict decoders.



export type ServiceLevelPeriod = {
  "object": "service_level_period";
  "service_level": "api_cached_delivery";
  "scope": {
  "api_and_cached_delivery": true;
  "uncached_extraction": false;
};
  "target_percent": 99.5;
  "period_start": string;
  "period_end": string;
  "evaluated_at": string;
  "status": "measuring" | "met" | "missed" | "unknown";
  "availability_percent": number | null;
  "coverage": {
  "expected_minutes": number;
  "observed_minutes": number;
  "missing_minutes": number;
  "excluded_maintenance_minutes": number;
};
  "synthetic": {
  "available_minutes": number;
  "unavailable_minutes": number;
  "missing_minutes": number;
  "availability_percent": number | null;
};
  "operations": {
  "eligible": number;
  "successful": number;
  "internal_failures": number;
  "pending": number;
  "excluded_source": number;
  "excluded_customer": number;
  "availability_percent": number | null;
  "latency": {
  "objective_ms": 30000;
  "target_percent": 95;
  "samples": number;
  "within_objective": number;
  "attainment_percent": number | null;
  "status": "met" | "missed" | "unknown";
};
  "objective_percent": 99.5;
  "status": "measuring" | "met" | "missed" | "unknown";
};
  "incidents": {
  "count": number;
  "minutes": number;
};
};

export type ServiceStatus = {
  "object": "service_status";
  "status": "operational" | "degraded" | "major_outage" | "unknown";
  "components": Array<{
  "id": "api" | "transcript_processing" | "webhook_delivery";
  "name": "API" | "Transcript processing" | "Webhook delivery";
  "status": "operational" | "degraded" | "major_outage" | "unknown";
}>;
  "incidents": Array<ServiceIncident>;
  "observed_at": string | null;
  "stale": boolean;
};

export type ServiceIncident = {
  "id": string;
  "object": "service_incident";
  "title": string;
  "impact": "degraded" | "partial_outage" | "major_outage" | "maintenance";
  "status": "investigating" | "identified" | "monitoring" | "resolved";
  "components": Array<"api" | "transcript_processing" | "webhook_delivery">;
  "created_at": string;
  "updated_at": string;
  "resolved_at": string | null;
  "updates": Array<ServiceIncidentUpdate>;
};

export type ServiceIncidentUpdate = {
  "id": string;
  "object": "service_incident_update";
  "status": "investigating" | "identified" | "monitoring" | "resolved";
  "message": string;
  "created_at": string;
};

export type CreditBalance = {
  "granted": number;
  "remaining": number;
  "reserved": number;
  "spendable": number;
  "used": number;
};

export type CreditLot = {
  "grant_class": "test" | "plan" | "top_up" | "adjustment" | "legacy";
  "remaining": number;
  "reserved": number;
  "expires_at": string | null;
};

export type AccountFunding = {
  "status": "active" | "suspended";
  "debt_credits": number;
};

export type Account = {
  "id": string;
  "object": "account";
  "status": "active" | "suspended" | "closed";
  "credits": CreditBalance;
  "credit_lots": Array<CreditLot>;
  "funding": AccountFunding;
  "created_at": string;
  "updated_at": string;
};

export type OwnerSession = {
  "object": "owner_session";
  "account": {
  "id": string;
  "status": "active";
  "role": "owner" | "admin" | "member";
};
  "user": {
  "email": string;
  "first_name": string | null;
  "last_name": string | null;
};
};

export type AccountConfirmation = {
  "confirmation": string;
};

export type AccountClosure = {
  "id": string;
  "object": "account_closure";
  "account_id": string;
  "status": "pending" | "processing" | "completed";
  "accepted_at": string;
};

export type Money = {
  "total": number;
  "currency": string;
};

export type BillingReceiptAmount = {
  "total": number;
  "refunded": number;
  "disputed": number;
  "currency": string;
};

export type BillingCatalog = {
  "object": "billing_catalog";
  "checkout_status": "available" | "reconciliation_delayed";
  "plans": Array<{
  "plan": "monthly" | "annual";
  "price_version": string;
  "credits_per_period": 1000;
  "credit_interval": "month";
  "billing_interval": "month" | "year";
  "periods_per_billing_cycle": 1 | 12;
  "amount": Money;
}>;
  "subscription": null | {
  "plan": "monthly" | "annual";
  "status": "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
  "cancel_at_period_end": boolean;
  "current_period_end": string;
};
  "top_ups": Array<{
  "plan": "monthly" | "annual";
  "price_version": string;
  "credits": 1000;
  "amount": Money;
}>;
};

export type BillingSubscription = {
  "object": "billing_subscription";
  "plan": "monthly" | "annual";
  "status": "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
  "cancel_at_period_end": true;
  "current_period_end": string;
};

export type CreateBillingCheckoutRequest = {
  "price_version": string;
};

export type BillingCheckout = {
  "id": string;
  "object": "checkout_session";
  "status": "open" | "complete" | "expired";
  "payment_status": "paid" | "unpaid" | "no_payment_required";
  "url": string | null;
  "expires_at": string;
  "created": boolean;
};

export type BillingReceipt = {
  "id": string;
  "object": "billing_receipt";
  "checkout_session_id": string | null;
  "type": "one_time" | "subscription" | "top_up";
  "plan": "monthly" | "annual" | null;
  "status": "pending" | "paid" | "refunded" | "disputed" | "failed" | "reconciliation_delayed";
  "credits": {
  "purchased": number;
  "refunded": number;
  "disputed": number;
};
  "amount": BillingReceiptAmount;
  "paid_at": string | null;
  "created_at": string;
  "updated_at": string;
};

export type BillingReceiptPage = {
  "items": Array<BillingReceipt>;
  "next_cursor": string | null;
};

export type ApiKeyScope = "account:read" | "api_keys:read" | "api_keys:write" | "analytics:read" | "batches:read" | "batches:write" | "transcripts:read" | "transcripts:write" | "webhooks:read" | "webhooks:write";

export type CreateApiKeyRequest = {
  "name": string;
  "scopes": Array<ApiKeyScope>;
  "expires_at"?: string | null;
};

export type ApiKey = {
  "id": string;
  "object": "api_key";
  "name": string;
  "scopes": Array<ApiKeyScope>;
  "status": "active" | "expired" | "revoked";
  "current": boolean;
  "created_at": string;
  "expires_at": string | null;
  "last_used_at": string | null;
  "revoked_at": string | null;
};

export type ApiKeyWithSecret = {
  "id": string;
  "object": "api_key";
  "name": string;
  "scopes": Array<ApiKeyScope>;
  "status": "active" | "expired" | "revoked";
  "current": boolean;
  "created_at": string;
  "expires_at": string | null;
  "last_used_at": string | null;
  "revoked_at": string | null;
  "secret": string;
};

export type ApiKeyList = {
  "items": Array<ApiKey>;
  "limit": 20;
};

export type ApiKeyRevocation = {
  "object": "api_key_revocation";
  "account_id": string;
  "status": "completed";
  "revoked_at": string;
};

export type SourceReference = {
  "url"?: string;
  "platform"?: string;
  "id"?: string;
};

export type CreateTranscriptCore = {
  "source": SourceReference;
  "track_id"?: string;
  "language_preferences"?: Array<string>;
  "caption_kinds"?: Array<"manual" | "automatic" | "unknown">;
  "language_fallback"?: "none" | "any";
  "content_format"?: "segments" | "text" | "both";
  "max_age_seconds"?: number;
  "allow_stale_on_error"?: boolean;
  "include"?: Array<"metadata" | "available_tracks">;
  "reference"?: string;
  "webhook_endpoint_id"?: string;
};

export type CreateTranscriptRequest = CreateTranscriptCore;

export type Source = {
  "platform": string;
  "id": string;
  "url": string;
};

export type Track = {
  "id": string;
  "language": string;
  "name": string;
  "kind": "manual" | "automatic" | "unknown";
  "fallback_applied"?: boolean;
};

export type Segment = {
  "start_ms": number;
  "duration_ms": number;
  "text": string;
};

export type TranscriptContent = {
  "url": string;
  "available_formats": Array<"text" | "json" | "srt" | "vtt">;
  "included": "none" | "segments" | "text" | "both";
  "text"?: string;
  "segments"?: Array<Segment>;
};

export type Retrieval = {
  "cache_status": "hit" | "miss" | "refresh";
  "observed_at": string;
  "access_validated_at": string;
  "access_validation_age_seconds": number;
  "cache_age_seconds": number;
  "stale": boolean;
  "source_market": string;
  "content_sha256": string;
  "refresh_error"?: OutcomeError | null;
};

export type Usage = {
  "credits_charged": 0 | 1;
};

export type Transcript = {
  "id": string;
  "request_id": string;
  "object": "transcript";
  "status": "queued" | "processing" | "completed" | "failed" | "cancelled";
  "source": Source;
  "requested": CreateTranscriptCore;
  "track"?: Track;
  "available_tracks"?: Array<Track>;
  "metadata"?: {
  "title"?: string | null;
  "creator_id"?: string | null;
  "creator_name"?: string | null;
  "duration_ms"?: number | null;
  "thumbnail_url"?: string | null;
};
  "content"?: TranscriptContent;
  "retrieval"?: Retrieval;
  "usage": Usage;
  "poll_url"?: string;
  "error"?: OutcomeError;
  "created_at": string;
  "updated_at": string;
  "completed_at"?: string;
  "access_expires_at"?: string;
};

export type TerminalTranscript = Transcript & {
  "status"?: "completed" | "failed";
};

export type PendingTranscript = Transcript & {
  "status"?: "queued" | "processing";
};

export type TranscriptReferenceOnly = Transcript;

export type TranscriptPage = {
  "items": Array<TranscriptReferenceOnly>;
  "next_cursor": string | null;
};

export type CreateBatchItem = CreateTranscriptCore & { "reference": NonNullable<CreateTranscriptCore["reference"]> };

export type CreateBatchRequest = {
  "items": Array<CreateBatchItem>;
  "webhook_endpoint_id"?: string;
};

export type BatchCounts = {
  "total": number;
  "queued": number;
  "processing": number;
  "completed": number;
  "failed": number;
  "cancelled": number;
};

export type Batch = {
  "id": string;
  "object": "batch";
  "status": "queued" | "processing" | "cancelling" | "completed" | "cancelled";
  "counts": BatchCounts;
  "created_at": string;
  "updated_at": string;
  "completed_at"?: string;
};

export type BatchPage = {
  "items": Array<Batch>;
  "next_cursor": string | null;
};

export type VisibleBatchItem = {
  "position": number;
  "reference": string;
  "transcript": TranscriptReferenceOnly;
};

export type DeletedBatchItem = {
  "position": number;
  "deleted": true;
};

export type BatchItem = VisibleBatchItem | DeletedBatchItem;

export type BatchItemPage = {
  "items": Array<BatchItem>;
  "next_cursor": string | null;
};

export type UsageEntry = {
  "id": string;
  "transcript_id": string;
  "credits": 1;
  "reason": "selected_track_completed";
  "created_at": string;
};

export type UsagePage = {
  "items": Array<UsageEntry>;
  "next_cursor": string | null;
};

export type AccountAnalyticsMetrics = {
  "admitted": number;
  "completed": number;
  "failed": number;
  "cancelled": number;
  "credits": number;
  "cache_hits": number;
  "cache_misses": number;
  "cache_refreshes": number;
  "stale_deliveries": number;
  "latency_samples": number;
  "total_latency_ms": number;
  "segments": number;
  "content_bytes": number;
  "completion_rate": number;
  "failure_rate": number;
  "cancellation_rate": number;
  "average_latency_ms": number | null;
  "p50_latency_upper_bound_ms": number | null;
  "p95_latency_upper_bound_ms": number | null;
  "p99_latency_upper_bound_ms": number | null;
  "latency_overflow_samples": number;
};

export type AccountAnalyticsHour = {
  "bucket_start": string;
  "admitted": number;
  "completed": number;
  "failed": number;
  "cancelled": number;
  "credits": number;
  "cache_hits": number;
  "cache_misses": number;
  "cache_refreshes": number;
  "stale_deliveries": number;
  "latency_samples": number;
  "total_latency_ms": number;
  "segments": number;
  "content_bytes": number;
};

export type ExecutionAnalyticsMetrics = {
  "processing_samples": number;
  "source_samples": number;
  "diagnostic_samples": number;
  "source_attempts": number;
  "capacity_waits": number;
  "average_queue_latency_ms": number | null;
  "average_processing_latency_ms": number | null;
  "average_source_wait_ms": number | null;
  "average_source_execution_ms": number | null;
};

export type AccountAnalyticsOutcome = {
  "outcome": string;
  "count": number;
};

export type AccountAnalyticsRequest = {
  "transcript_id": string;
  "request_id": string;
  "status": "queued" | "processing" | "completed" | "failed" | "cancelled";
  "cache_status": "hit" | "miss" | "refresh" | null;
  "stale": boolean;
  "error_code": string | null;
  "retryable": boolean | null;
  "credits_charged": 0 | 1;
  "track_language": string | null;
  "track_kind": "manual" | "automatic" | null;
  "segment_count": number | null;
  "content_bytes": number | null;
  "total_latency_ms": number | null;
  "queue_latency_ms": number | null;
  "processing_latency_ms": number | null;
  "source_attempts": number | null;
  "capacity_waits": number | null;
  "source_last_attempt_at": string | null;
  "created_at": string;
  "processing_at": string | null;
  "completed_at": string | null;
  "updated_at": string;
};

export type AccountAnalyticsOverview = {
  "window_hours": 24 | 168 | 720;
  "observed_at": string;
  "totals": AccountAnalyticsMetrics;
  "execution": ExecutionAnalyticsMetrics;
  "series": Array<AccountAnalyticsHour>;
  "outcomes": Array<AccountAnalyticsOutcome>;
  "recent_requests": Array<AccountAnalyticsRequest>;
};

export type CreateWebhookEndpointRequest = {
  "name": string;
  "url": string;
};

export type WebhookEndpoint = {
  "id": string;
  "object": "webhook_endpoint";
  "name": string;
  "url": string;
  "status": "pending_verification" | "enabled";
  "signing_key_id": string;
  "signing_secret"?: string;
  "previous_signing_key_id"?: string;
  "previous_secret_expires_at"?: string;
  "verified_at"?: string;
  "last_verification_attempt_at"?: string;
  "last_verification_error"?: string;
  "created_at": string;
  "updated_at": string;
};

export type WebhookEndpointWithSecret = WebhookEndpoint & { "signing_secret": NonNullable<WebhookEndpoint["signing_secret"]> };

export type WebhookEndpointList = {
  "items": Array<WebhookEndpoint>;
};

export type WebhookDeliveryAttempt = {
  "id": string;
  "number": number;
  "attempted_at": string;
  "duration_ms": number;
  "http_status"?: number;
  "error"?: "dns_rejected" | "tls_error" | "timeout" | "network_error" | "transport_error" | "response_too_large" | "protocol_error";
};

export type WebhookDelivery = {
  "id": string;
  "object": "webhook_delivery";
  "endpoint_id": string;
  "event": WebhookEvent;
  "replay_of"?: string;
  "status": "pending" | "retry_scheduled" | "delivered" | "exhausted";
  "attempt_count": number;
  "attempts": Array<WebhookDeliveryAttempt>;
  "next_attempt_at"?: string;
  "delivered_at"?: string;
  "exhausted_at"?: string;
  "last_error"?: string;
  "retention_expires_at"?: string;
  "created_at": string;
  "updated_at": string;
};

export type WebhookDeliveryPage = {
  "items": Array<WebhookDelivery>;
  "next_cursor": string | null;
};

export type WebhookEvent = {
  "id": string;
  "object": "event";
  "api_version": "2026-08-21";
  "type": "transcript.completed" | "transcript.failed" | "transcript.cancelled" | "batch.completed" | "batch.cancelled";
  "created_at": string;
  "resource": {
  "id": string;
  "object": "transcript" | "batch";
  "status": "completed" | "failed" | "cancelled";
  "request_id"?: string;
  "version": number;
  "url": string;
};
};

export type OutcomeError = {
  "code": "source_not_found" | "source_removed" | "source_private" | "source_restricted" | "source_live_not_ready" | "transcript_unavailable" | "track_not_available" | "source_too_large" | "upstream_enforcement" | "proxy_unavailable" | "temporarily_unavailable" | "internal_error";
  "detail": string;
  "request_id": string;
  "retryable": boolean;
  "retry_after_seconds"?: number;
  "observed_at"?: string;
  "cache_status"?: "hit" | "miss" | "refresh";
};

export type Problem = {
  "type": string;
  "title": string;
  "status": number;
  "code": "invalid_request" | "invalid_api_key" | "insufficient_credits" | "funding_suspended" | "forbidden" | "resource_not_found" | "resource_not_ready" | "caption_access_expired" | "idempotency_conflict" | "idempotency_resource_deleted" | "idempotency_secret_unavailable" | "request_not_cancellable" | "endpoint_limit_exceeded" | "api_key_limit_exceeded" | "last_management_key" | "webhook_verification_failed" | "webhook_delivery_not_replayable" | "webhook_secret_rotation_blocked" | "payload_too_large" | "invalid_source" | "temporarily_unavailable" | "account_recovery_capacity" | "rate_limited" | "checkout_rate_limited" | "control_plane_rate_limited" | "internal_error";
  "detail": string;
  "request_id": string;
  "retryable": boolean;
  "retry_after_seconds"?: number;
  "resource_id"?: string;
  "access_expires_at"?: string;
  [key: string]: unknown;
};

