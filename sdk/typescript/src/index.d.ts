export * from "./schema-types.js";

import type {
  Account,
  AccountAnalyticsOverview,
  AccountAnalyticsRequest,
  ApiKeyList,
  ApiKeyWithSecret,
  Batch,
  BatchItemPage,
  BatchPage,
  CreateApiKeyRequest,
  CreateBatchRequest,
  CreateTranscriptRequest,
  CreateWebhookEndpointRequest,
  PendingTranscript,
  Problem,
  TerminalTranscript,
  Transcript,
  TranscriptContent,
  TranscriptPage,
  UsagePage,
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from "./schema-types.js";

export interface RateLimitMetadata {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
}

export type ThumbnailCacheStatus = "miss" | "hit" | "coalesced";

export interface ApiResponse<T> {
  data: T;
  status: number;
  requestId: string | null;
  creditsCharged: number | null;
  rateLimit: RateLimitMetadata;
  location: string | null;
  etag: string | null;
  retryAfter: string | null;
  thumbnailCache: ThumbnailCacheStatus | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ConditionalRequestOptions extends RequestOptions {
  etag?: string;
}

export interface PageOptions extends RequestOptions {
  cursor?: string;
  limit?: number;
}

export interface PageIteratorOptions extends PageOptions {
  maxPages?: number;
}

export interface IdempotentRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export interface RetryFailedBatchOptions extends RequestOptions {
  idempotencyKey: string;
  now?: number;
}

export interface CreateTranscriptOptions extends IdempotentRequestOptions {
  waitSeconds?: number;
  respondAsync?: boolean;
}

export interface WaitOptions extends RequestOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class TranscriptLayerError extends Error {
  readonly status: number;
  readonly problem: Problem | Record<string, unknown> | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly creditsCharged: number | null;
  readonly rateLimit: RateLimitMetadata;
  readonly location: string | null;
  readonly etag: string | null;
  readonly retryAfter: string | null;
  readonly thumbnailCache: ThumbnailCacheStatus | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
}

export class TranscriptLayerClient {
  constructor(options: ClientOptions);

  request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions & {
      body?: unknown;
      idempotencyKey?: string;
      prefer?: string;
      accept?: string;
      ifNoneMatch?: string;
      bytes?: boolean;
      maximumBytes?: number;
    },
  ): Promise<ApiResponse<T>>;

  getAccount(options?: RequestOptions): Promise<ApiResponse<Account>>;
  listApiKeys(options?: RequestOptions): Promise<ApiResponse<ApiKeyList>>;
  createApiKey(body: CreateApiKeyRequest, options?: IdempotentRequestOptions): Promise<ApiResponse<ApiKeyWithSecret>>;
  revokeApiKey(apiKeyId: string, options?: RequestOptions): Promise<ApiResponse<null>>;

  createTranscript(body: CreateTranscriptRequest, options?: CreateTranscriptOptions): Promise<ApiResponse<TerminalTranscript | PendingTranscript>>;
  listTranscripts(options?: PageOptions): Promise<ApiResponse<TranscriptPage>>;
  iterateTranscriptPages(options?: PageIteratorOptions): AsyncGenerator<ApiResponse<TranscriptPage>, void, void>;
  getTranscript(transcriptId: string, options?: ConditionalRequestOptions): Promise<ApiResponse<Transcript | null>>;
  waitForTranscript(transcriptId: string, options?: WaitOptions): Promise<ApiResponse<Transcript>>;
  deleteTranscript(transcriptId: string, options?: RequestOptions): Promise<ApiResponse<null>>;
  cancelTranscript(transcriptId: string, options?: RequestOptions): Promise<ApiResponse<Transcript>>;
  downloadTranscriptContent(transcriptId: string, options?: ConditionalRequestOptions & { format?: "json" }): Promise<ApiResponse<TranscriptContent | null>>;
  downloadTranscriptContent(transcriptId: string, options: ConditionalRequestOptions & { format: "text" | "srt" | "vtt" }): Promise<ApiResponse<Uint8Array | null>>;
  downloadTranscriptThumbnail(transcriptId: string, options?: ConditionalRequestOptions): Promise<ApiResponse<Uint8Array | null>>;

  createBatch(body: CreateBatchRequest, options?: IdempotentRequestOptions): Promise<ApiResponse<Batch>>;
  listBatches(options?: PageOptions): Promise<ApiResponse<BatchPage>>;
  iterateBatchPages(options?: PageIteratorOptions): AsyncGenerator<ApiResponse<BatchPage>, void, void>;
  getBatch(batchId: string, options?: ConditionalRequestOptions): Promise<ApiResponse<Batch | null>>;
  waitForBatch(batchId: string, options?: WaitOptions): Promise<ApiResponse<Batch>>;
  deleteBatch(batchId: string, options?: RequestOptions): Promise<ApiResponse<null>>;
  listBatchItems(batchId: string, options?: PageOptions): Promise<ApiResponse<BatchItemPage>>;
  iterateBatchItemPages(batchId: string, options?: PageIteratorOptions): AsyncGenerator<ApiResponse<BatchItemPage>, void, void>;
  cancelBatch(batchId: string, options?: RequestOptions): Promise<ApiResponse<Batch>>;
  retryFailedBatch(batchId: string, options: RetryFailedBatchOptions): Promise<ApiResponse<Batch>>;

  createWebhookEndpoint(body: CreateWebhookEndpointRequest, options?: IdempotentRequestOptions): Promise<ApiResponse<WebhookEndpointWithSecret>>;
  listWebhookEndpoints(options?: RequestOptions): Promise<ApiResponse<WebhookEndpointList>>;
  getWebhookEndpoint(endpointId: string, options?: RequestOptions): Promise<ApiResponse<WebhookEndpoint>>;
  deleteWebhookEndpoint(endpointId: string, options?: RequestOptions): Promise<ApiResponse<null>>;
  verifyWebhookEndpoint(endpointId: string, options?: RequestOptions): Promise<ApiResponse<WebhookEndpoint>>;
  rotateWebhookEndpointSecret(endpointId: string, options?: IdempotentRequestOptions): Promise<ApiResponse<WebhookEndpointWithSecret>>;
  listWebhookDeliveries(options?: PageOptions): Promise<ApiResponse<WebhookDeliveryPage>>;
  iterateWebhookDeliveryPages(options?: PageIteratorOptions): AsyncGenerator<ApiResponse<WebhookDeliveryPage>, void, void>;
  getWebhookDelivery(deliveryId: string, options?: RequestOptions): Promise<ApiResponse<WebhookDelivery>>;
  replayWebhookDelivery(deliveryId: string, options?: IdempotentRequestOptions): Promise<ApiResponse<WebhookDelivery>>;

  getAccountAnalyticsOverview(options?: RequestOptions & { window?: "24h" | "7d" | "30d" }): Promise<ApiResponse<AccountAnalyticsOverview>>;
  getAccountRequestDiagnostic(requestId: string, options?: RequestOptions): Promise<ApiResponse<AccountAnalyticsRequest>>;
  listUsage(options?: PageOptions): Promise<ApiResponse<UsagePage>>;
  iterateUsagePages(options?: PageIteratorOptions): AsyncGenerator<ApiResponse<UsagePage>, void, void>;
}
