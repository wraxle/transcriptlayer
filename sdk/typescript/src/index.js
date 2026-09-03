const DEFAULT_BASE_URL = "https://api.transcriptlayer.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const TRANSCRIPT_STATES = new Set(["queued", "processing", "completed", "failed", "cancelled"]);
const TERMINAL_TRANSCRIPT_STATES = new Set(["completed", "failed", "cancelled"]);
const BATCH_STATES = new Set(["queued", "processing", "cancelling", "completed", "cancelled"]);
const TERMINAL_BATCH_STATES = new Set(["completed", "cancelled"]);

export class TranscriptLayerError extends Error {
  constructor(message, { status = 0, problem = null, diagnostics = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TranscriptLayerError";
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? (status === 0 ? "transport_error" : "api_error");
    this.requestId = diagnostics?.requestId ?? problem?.request_id ?? null;
    this.creditsCharged = diagnostics?.creditsCharged ?? null;
    this.rateLimit = diagnostics?.rateLimit ?? { limit: null, remaining: null, reset: null };
    this.location = diagnostics?.location ?? null;
    this.etag = diagnostics?.etag ?? null;
    this.retryAfter = diagnostics?.retryAfter ?? null;
    this.thumbnailCache = diagnostics?.thumbnailCache ?? null;
    this.retryable = problem?.retryable === true;
    this.retryAfterSeconds = retryAfterSeconds(this.retryAfter, problem);
  }
}

function retryAfterSeconds(retryAfter, problem) {
  if (typeof retryAfter === "string" && /^\d+$/u.test(retryAfter)) {
    const parsed = Number(retryAfter);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return Number.isSafeInteger(problem?.retry_after_seconds) && problem.retry_after_seconds >= 0
    ? problem.retry_after_seconds
    : null;
}

function validateBaseUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new TypeError("baseUrl must be an absolute URL"); }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new TypeError("baseUrl must use HTTPS; HTTP is allowed only for localhost");
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl cannot contain credentials, a query, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function safeValue(value, label, maximum = 1_000) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new TypeError(`${label} must contain 1 to ${maximum} safe characters`);
  }
  return value;
}

function id(value) {
  return encodeURIComponent(safeValue(value, "resource ID", 200));
}

function requestIdValue(value) {
  const safe = safeValue(value, "request ID", 200);
  if (!/^req_[A-Za-z0-9]+$/u.test(safe)) throw new TypeError("request ID has an invalid format");
  return safe;
}

function query(path, values) {
  const url = new URL(path, "https://placeholder.invalid");
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function pageValues(cursor, limit) {
  if (cursor !== undefined) safeValue(cursor, "cursor");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new TypeError("limit must be an integer from 1 to 200");
  }
  return { cursor, limit };
}

function pageIteratorValues(cursor, limit = 100, maxPages = 100) {
  const page = pageValues(cursor, limit);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new TypeError("maxPages must be an integer from 1 to 10000");
  }
  return { ...page, maxPages };
}

function generatedIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new TypeError("idempotencyKey is required when crypto.randomUUID is unavailable");
  }
  return globalThis.crypto.randomUUID();
}

function key(value) {
  return value === undefined ? generatedIdempotencyKey() : safeValue(value, "idempotency key", 200);
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`request timed out after ${timeoutMs} ms`, "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); },
  };
}

function combinedTimeoutSignal(callerSignal, timeoutMs) {
  const timeout = timeoutSignal(timeoutMs);
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal,
    dispose: timeout.dispose,
  };
}

function waitValues(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 3600000");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new TypeError("pollIntervalMs must be an integer from 100 to 60000");
  }
  return { timeoutMs, pollIntervalMs };
}

function waitError(message, code, retryable) {
  return new TranscriptLayerError(message, { problem: { code, retryable } });
}

function invalidResource(kind) {
  return new TranscriptLayerError(`API returned an invalid ${kind}`, {
    status: 502,
    problem: { code: "invalid_api_response", retryable: false },
  });
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(waitError("request was cancelled", "request_cancelled", false));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(waitError("request was cancelled", "request_cancelled", false));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function readBounded(response, maximum, bytes = false) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel("response limit exceeded");
    throw new TranscriptLayerError(`response exceeded ${maximum} bytes`, {
      status: 502,
      problem: { code: "invalid_api_response", upstream_status: response.status, retryable: false },
      diagnostics: responseMetadata(response),
    });
  }
  if (!response.body) return bytes ? new Uint8Array() : "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel("response limit exceeded");
        throw new TranscriptLayerError(`response exceeded ${maximum} bytes`, {
          status: 502,
          problem: { code: "invalid_api_response", upstream_status: response.status, retryable: false },
          diagnostics: responseMetadata(response),
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes ? output : new TextDecoder().decode(output);
}

function parseJson(text, response) {
  try { return text === "" ? {} : JSON.parse(text); }
  catch {
    throw new TranscriptLayerError("API returned invalid JSON", {
      status: 502,
      problem: { code: "invalid_api_response", upstream_status: response.status, retryable: false },
      diagnostics: responseMetadata(response),
    });
  }
}

function responseMetadata(response) {
  const integer = (name) => {
    const raw = response.headers.get(name);
    if (raw === null || !/^-?\d+$/u.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const thumbnailCache = response.headers.get("x-transcriptlayer-thumbnail-cache");
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    creditsCharged: integer("x-credits-charged"),
    rateLimit: {
      limit: integer("x-ratelimit-limit"),
      remaining: integer("x-ratelimit-remaining"),
      reset: integer("x-ratelimit-reset"),
    },
    location: response.headers.get("location"),
    etag: response.headers.get("etag"),
    retryAfter: response.headers.get("retry-after"),
    thumbnailCache: new Set(["miss", "hit", "coalesced"]).has(thumbnailCache) ? thumbnailCache : null,
  };
}

function metadata(response, data) {
  return { data, ...responseMetadata(response) };
}

export class TranscriptLayerClient {
  #apiKey;
  #baseUrl;
  #timeoutMs;
  #fetch;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchFunction = globalThis.fetch } = {}) {
    this.#apiKey = safeValue(apiKey, "apiKey", 512);
    this.#baseUrl = validateBaseUrl(baseUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError("timeoutMs must be an integer from 1 to 60000");
    }
    if (typeof fetchFunction !== "function") throw new TypeError("fetch must be a function");
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchFunction;
  }

  async request(method, path, { body, idempotencyKey, prefer, accept = "application/json", ifNoneMatch, signal, bytes = false, maximumBytes = MAX_JSON_BYTES } = {}) {
    if (!/^\/v1(?:\/|$)/u.test(path)) throw new TypeError("path must stay under /v1");
    const url = new URL(path.replace(/^\//u, ""), this.#baseUrl);
    const expectedPath = `${this.#baseUrl.pathname}v1`;
    if (url.origin !== this.#baseUrl.origin || !(url.pathname === expectedPath || url.pathname.startsWith(`${expectedPath}/`))) {
      throw new TypeError("path must stay under /v1");
    }
    const headers = new Headers({ accept, authorization: `Bearer ${this.#apiKey}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (idempotencyKey !== undefined) headers.set("idempotency-key", safeValue(idempotencyKey, "idempotency key", 200));
    if (prefer !== undefined) headers.set("prefer", safeValue(prefer, "Prefer", 100));
    if (ifNoneMatch !== undefined) headers.set("if-none-match", safeValue(ifNoneMatch, "ETag", 500));
    const requestTimeout = combinedTimeoutSignal(signal, this.#timeoutMs);
    try {
      let response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: requestTimeout.signal,
        });
      } catch (cause) {
        const timedOut = requestTimeout.signal.aborted && !signal?.aborted;
        throw new TranscriptLayerError(timedOut ? `request timed out after ${this.#timeoutMs} ms` : "API transport failed", {
          problem: { code: timedOut ? "request_timeout" : "transport_error", retryable: true },
          cause,
        });
      }
      const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!response.ok && response.status !== 304) {
        const text = await readBounded(response, MAX_JSON_BYTES);
        const problem = mediaType.includes("json") || text.trimStart().startsWith("{") ? parseJson(text, response) : null;
        const message = problem?.detail ?? problem?.title ?? (text ? text.slice(0, 500) : `request failed with HTTP ${response.status}`);
        throw new TranscriptLayerError(message, {
          status: response.status,
          problem,
          diagnostics: responseMetadata(response),
        });
      }
      if (response.status === 204 || response.status === 304 || (bytes && response.status === 202)) {
        await response.body?.cancel("response has no representation");
        return metadata(response, null);
      }
      const data = bytes
        ? await readBounded(response, maximumBytes, true)
        : parseJson(await readBounded(response, maximumBytes), response);
      return metadata(response, data);
    } finally {
      requestTimeout.dispose();
    }
  }

  getAccount(options) { return this.request("GET", "/v1/account", options); }
  listApiKeys(options) { return this.request("GET", "/v1/api-keys", options); }
  createApiKey(body, { idempotencyKey, ...options } = {}) {
    return this.request("POST", "/v1/api-keys", { ...options, body, idempotencyKey: key(idempotencyKey) });
  }
  revokeApiKey(apiKeyId, options) { return this.request("DELETE", `/v1/api-keys/${id(apiKeyId)}`, options); }

  createTranscript(body, { idempotencyKey, waitSeconds, respondAsync = false, ...options } = {}) {
    if (respondAsync && waitSeconds !== undefined) throw new TypeError("respondAsync and waitSeconds cannot be combined");
    if (waitSeconds !== undefined && (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 10)) {
      throw new TypeError("waitSeconds must be an integer from 0 to 10");
    }
    const prefer = respondAsync ? "respond-async" : waitSeconds === undefined ? undefined : `wait=${waitSeconds}`;
    return this.request("POST", "/v1/transcripts", { ...options, body, idempotencyKey: key(idempotencyKey), prefer });
  }
  listTranscripts({ cursor, limit, ...options } = {}) { return this.request("GET", query("/v1/transcripts", pageValues(cursor, limit)), options); }
  iterateTranscriptPages({ cursor, limit, maxPages, signal } = {}) {
    const values = pageIteratorValues(cursor, limit, maxPages);
    return this.#iteratePages((nextCursor) => this.listTranscripts({ cursor: nextCursor, limit: values.limit, signal }), values);
  }
  getTranscript(transcriptId, { etag, ...options } = {}) { return this.request("GET", `/v1/transcripts/${id(transcriptId)}`, { ...options, ifNoneMatch: etag }); }
  waitForTranscript(transcriptId, { timeoutMs, pollIntervalMs, signal } = {}) {
    id(transcriptId);
    const wait = waitValues(timeoutMs, pollIntervalMs);
    return this.#waitForResource("transcript", transcriptId, TRANSCRIPT_STATES, TERMINAL_TRANSCRIPT_STATES, wait, signal);
  }
  deleteTranscript(transcriptId, options) { return this.request("DELETE", `/v1/transcripts/${id(transcriptId)}`, options); }
  cancelTranscript(transcriptId, options) { return this.request("POST", `/v1/transcripts/${id(transcriptId)}/cancel`, options); }
  downloadTranscriptContent(transcriptId, { format = "json", etag, ...options } = {}) {
    const accept = { json: "application/json", text: "text/plain", srt: "application/x-subrip", vtt: "text/vtt" }[format];
    if (!accept) throw new TypeError("format must be json, text, srt, or vtt");
    return this.request("GET", query(`/v1/transcripts/${id(transcriptId)}/content`, { format }), {
      ...options, accept, ifNoneMatch: etag, bytes: format !== "json",
    });
  }
  downloadTranscriptThumbnail(transcriptId, { etag, ...options } = {}) {
    return this.request("GET", `/v1/transcripts/${id(transcriptId)}/thumbnail`, {
      ...options, accept: "image/jpeg, image/png, image/webp", ifNoneMatch: etag, bytes: true, maximumBytes: MAX_THUMBNAIL_BYTES,
    });
  }

  createBatch(body, { idempotencyKey, ...options } = {}) {
    return this.request("POST", "/v1/batches", { ...options, body, idempotencyKey: key(idempotencyKey) });
  }
  listBatches({ cursor, limit, ...options } = {}) { return this.request("GET", query("/v1/batches", pageValues(cursor, limit)), options); }
  iterateBatchPages({ cursor, limit, maxPages, signal } = {}) {
    const values = pageIteratorValues(cursor, limit, maxPages);
    return this.#iteratePages((nextCursor) => this.listBatches({ cursor: nextCursor, limit: values.limit, signal }), values);
  }
  getBatch(batchId, { etag, ...options } = {}) { return this.request("GET", `/v1/batches/${id(batchId)}`, { ...options, ifNoneMatch: etag }); }
  waitForBatch(batchId, { timeoutMs, pollIntervalMs, signal } = {}) {
    id(batchId);
    const wait = waitValues(timeoutMs, pollIntervalMs);
    return this.#waitForResource("batch", batchId, BATCH_STATES, TERMINAL_BATCH_STATES, wait, signal);
  }
  deleteBatch(batchId, options) { return this.request("DELETE", `/v1/batches/${id(batchId)}`, options); }
  listBatchItems(batchId, { cursor, limit, ...options } = {}) {
    return this.request("GET", query(`/v1/batches/${id(batchId)}/items`, pageValues(cursor, limit)), options);
  }
  iterateBatchItemPages(batchId, { cursor, limit, maxPages, signal } = {}) {
    id(batchId);
    const values = pageIteratorValues(cursor, limit, maxPages);
    return this.#iteratePages((nextCursor) => this.listBatchItems(batchId, { cursor: nextCursor, limit: values.limit, signal }), values);
  }
  cancelBatch(batchId, options) { return this.request("POST", `/v1/batches/${id(batchId)}/cancel`, options); }

  async retryFailedBatch(batchId, { idempotencyKey, now = Date.now(), signal } = {}) {
    const retryKey = safeValue(idempotencyKey, "idempotency key", 200);
    const source = (await this.getBatch(batchId, { signal })).data;
    if (!TERMINAL_BATCH_STATES.has(source?.status)) {
      throw new TranscriptLayerError("source batch is not terminal", { status: 409, problem: { code: "batch_not_terminal", retryable: false } });
    }
    const items = [];
    for await (const response of this.iterateBatchItemPages(batchId, { limit: 200, maxPages: 100, signal })) {
      items.push(...response.data.items);
      if (items.length > 1_000) throw new TranscriptLayerError("API returned more than 1,000 batch items", { status: 502, problem: { code: "invalid_api_response", retryable: false } });
    }
    const eligible = items.filter((item) => {
      const transcript = item?.transcript;
      if (transcript?.status !== "failed" || transcript.error?.retryable !== true) return false;
      const seconds = transcript.error.retry_after_seconds ?? 0;
      const anchor = Date.parse(transcript.updated_at ?? transcript.completed_at ?? "");
      return Number.isFinite(anchor) && Number.isInteger(seconds) && seconds >= 0 && anchor + seconds * 1_000 <= now;
    }).map((item) => ({ ...item.transcript.requested, reference: item.reference }));
    if (eligible.length === 0) {
      throw new TranscriptLayerError("source batch has no retryable failures whose delay has elapsed", { status: 409, problem: { code: "no_retryable_items", retryable: false } });
    }
    return this.createBatch({ items: eligible }, { idempotencyKey: retryKey, signal });
  }

  createWebhookEndpoint(body, { idempotencyKey, ...options } = {}) {
    return this.request("POST", "/v1/webhook-endpoints", { ...options, body, idempotencyKey: key(idempotencyKey) });
  }
  listWebhookEndpoints(options) { return this.request("GET", "/v1/webhook-endpoints", options); }
  getWebhookEndpoint(endpointId, options) { return this.request("GET", `/v1/webhook-endpoints/${id(endpointId)}`, options); }
  deleteWebhookEndpoint(endpointId, options) { return this.request("DELETE", `/v1/webhook-endpoints/${id(endpointId)}`, options); }
  verifyWebhookEndpoint(endpointId, options) { return this.request("POST", `/v1/webhook-endpoints/${id(endpointId)}/verify`, options); }
  rotateWebhookEndpointSecret(endpointId, { idempotencyKey, ...options } = {}) {
    return this.request("POST", `/v1/webhook-endpoints/${id(endpointId)}/rotate-secret`, { ...options, idempotencyKey: key(idempotencyKey) });
  }
  listWebhookDeliveries({ cursor, limit, ...options } = {}) { return this.request("GET", query("/v1/webhook-deliveries", pageValues(cursor, limit)), options); }
  iterateWebhookDeliveryPages({ cursor, limit, maxPages, signal } = {}) {
    const values = pageIteratorValues(cursor, limit, maxPages);
    return this.#iteratePages((nextCursor) => this.listWebhookDeliveries({ cursor: nextCursor, limit: values.limit, signal }), values);
  }
  getWebhookDelivery(deliveryId, options) { return this.request("GET", `/v1/webhook-deliveries/${id(deliveryId)}`, options); }
  replayWebhookDelivery(deliveryId, { idempotencyKey, ...options } = {}) {
    return this.request("POST", `/v1/webhook-deliveries/${id(deliveryId)}/replay`, { ...options, idempotencyKey: key(idempotencyKey) });
  }
  getAccountAnalyticsOverview({ window = "24h", ...options } = {}) {
    if (!["24h", "7d", "30d"].includes(window)) throw new TypeError("window must be 24h, 7d, or 30d");
    return this.request("GET", query("/v1/analytics/overview", { window }), options);
  }
  getAccountRequestDiagnostic(requestId, options) {
    return this.request("GET", `/v1/analytics/requests/${requestIdValue(requestId)}`, options);
  }
  listUsage({ cursor, limit, ...options } = {}) { return this.request("GET", query("/v1/usage", pageValues(cursor, limit)), options); }
  iterateUsagePages({ cursor, limit, maxPages, signal } = {}) {
    const values = pageIteratorValues(cursor, limit, maxPages);
    return this.#iteratePages((nextCursor) => this.listUsage({ cursor: nextCursor, limit: values.limit, signal }), values);
  }

  async *#iteratePages(loadPage, { cursor, maxPages }) {
    const cursors = new Set(cursor === undefined ? [] : [cursor]);
    let nextCursor = cursor;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const response = await loadPage(nextCursor);
      const page = response.data;
      if (!Array.isArray(page?.items) || !(page.next_cursor === null || typeof page.next_cursor === "string") || page.items.length > 200) {
        throw new TranscriptLayerError("API returned an invalid page", {
          status: 502,
          problem: { code: "invalid_api_response", retryable: false },
        });
      }
      nextCursor = page.next_cursor;
      if (nextCursor !== null) {
        safeValue(nextCursor, "cursor");
        if (cursors.has(nextCursor)) {
          throw new TranscriptLayerError("API repeated a page cursor", {
            status: 502,
            problem: { code: "invalid_api_response", retryable: false },
          });
        }
        cursors.add(nextCursor);
      }
      yield response;
      if (nextCursor === null) return;
    }
    throw new TranscriptLayerError(`pagination exceeded ${maxPages} pages`, {
      problem: { code: "pagination_limit_reached", retryable: false },
    });
  }

  async #waitForResource(kind, resourceId, states, terminalStates, { timeoutMs, pollIntervalMs }, callerSignal) {
    if (callerSignal?.aborted) throw waitError("request was cancelled", "request_cancelled", false);
    const started = performance.now();
    const deadline = started + timeoutMs;
    const waitTimeout = timeoutSignal(timeoutMs);
    const deadlineSignal = waitTimeout.signal;
    const waitSignal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
    let etag;
    let latest = null;
    try {
      while (true) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw waitError(`${kind} wait timed out after ${timeoutMs} ms`, "wait_timeout", true);
        let response;
        try {
          response = kind === "transcript"
            ? await this.getTranscript(resourceId, { etag, signal: waitSignal })
            : await this.getBatch(resourceId, { etag, signal: waitSignal });
        } catch (error) {
          if (callerSignal?.aborted) throw waitError("request was cancelled", "request_cancelled", false);
          if (deadlineSignal.aborted) throw waitError(`${kind} wait timed out after ${timeoutMs} ms`, "wait_timeout", true);
          throw error;
        }
        if (response.status === 304) {
          if (latest === null) throw invalidResource(kind);
        } else {
          const resource = response.data;
          if (resource === null || typeof resource !== "object" || resource.id !== resourceId || !states.has(resource.status)) {
            throw invalidResource(kind);
          }
          latest = response;
          etag = response.etag ?? undefined;
          if (terminalStates.has(resource.status)) return response;
        }
        const afterRequest = deadline - performance.now();
        if (afterRequest <= 0) throw waitError(`${kind} wait timed out after ${timeoutMs} ms`, "wait_timeout", true);
        await delay(Math.min(pollIntervalMs, afterRequest), callerSignal);
      }
    } finally {
      waitTimeout.dispose();
    }
  }
}
