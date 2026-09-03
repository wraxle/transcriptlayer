import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertOpenApiOperationResponse } from "../src/contracts/openapi-schema-validator.mjs";
import { TranscriptLayerClient, TranscriptLayerError } from "../sdk/typescript/src/index.js";

const contract = JSON.parse(await readFile(new URL("../docs/contracts/openapi-v1.json", import.meta.url), "utf8"));
const sdkFixtures = JSON.parse(await readFile(new URL("./fixtures/sdk-response-fixtures.json", import.meta.url), "utf8"));

function operationExample(name, operationId, status, overrides = {}) {
  const value = { ...structuredClone(contract.components.examples[name].value), ...overrides };
  assertOpenApiOperationResponse(contract, { operationId, status, mediaType: "application/json", value }, `${name} SDK fixture`);
  return value;
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return Response.json(value, { status, headers });
}

function sdkFixture(name, overrides = {}) {
  const fixture = sdkFixtures[name];
  assert.ok(fixture, `unknown SDK response fixture ${name}`);
  const value = { ...structuredClone(fixture.value), ...overrides };
  if (value.secret === "<generated-test-api-key>") {
    value.secret = ["tl", "test", "a".repeat(43)].join("_");
  }
  assertOpenApiOperationResponse(contract, {
    operationId: fixture.operation_id,
    status: fixture.status,
    mediaType: "application/json",
    value,
  }, `${name} SDK response fixture`);
  return value;
}

function uncheckedControlFlowResponse(value, options) {
  return jsonResponse(value, options);
}

test("TypeScript SDK decodes contract-valid account, key, page, webhook, usage, and analytics responses", async () => {
  const cases = [
    ["account", (client) => client.getAccount()],
    ["api_key_with_secret", (client) => client.createApiKey({ name: "Deploy", scopes: ["transcripts:read"] })],
    ["transcript_page", (client) => client.listTranscripts()],
    ["batch_page", (client) => client.listBatches()],
    ["batch_item_page", (client) => client.listBatchItems("bat_sdk")],
    ["webhook_endpoint_with_secret", (client) => client.createWebhookEndpoint({ name: "Production", url: "https://hooks.example.com/transcriptlayer" })],
    ["webhook_endpoint_list", (client) => client.listWebhookEndpoints()],
    ["webhook_delivery_page", (client) => client.listWebhookDeliveries()],
    ["usage_page", (client) => client.listUsage()],
    ["analytics_overview", (client) => client.getAccountAnalyticsOverview()],
    ["account_request_diagnostic", (client) => client.getAccountRequestDiagnostic("req_sdk")],
  ];

  for (const [name, invoke] of cases) {
    const value = sdkFixture(name);
    const client = new TranscriptLayerClient({
      apiKey: "key",
      fetch: async () => jsonResponse(value, { status: sdkFixtures[name].status }),
    });
    const response = await invoke(client);
    assert.deepEqual(response.data, value, `${name} response must survive decoding`);
  }
});

test("TypeScript SDK keeps credentials in headers and exposes response diagnostics", async () => {
  const calls = [];
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const pending = operationExample("PendingTranscript", "createTranscript", 202, { id: "tr_1" });
      return jsonResponse({ ...pending, future_field: { kept: true } }, {
        status: 202,
        headers: {
          "x-request-id": "req_1",
          "x-credits-charged": "0",
          "x-ratelimit-limit": "20",
          "x-ratelimit-remaining": "19",
          "x-ratelimit-reset": "123",
          location: "/v1/transcripts/tr_1",
          "retry-after": "1",
          "x-transcriptlayer-thumbnail-cache": "miss",
        },
      });
    },
  });

  const response = await client.createTranscript({ source: { platform: "youtube", id: "abcdefghijk" } }, { respondAsync: true });
  assert.equal(JSON.stringify(client).includes("tl_test_secret"), false, "client serialization must not expose the API key");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes("tl_test_secret"), false);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer tl_test_secret");
  assert.match(new Headers(calls[0].init.headers).get("idempotency-key"), /^[0-9a-f-]{36}$/u);
  assert.equal(new Headers(calls[0].init.headers).get("prefer"), "respond-async");
  assert.deepEqual(response.data.future_field, { kept: true }, "additive fields must survive decoding");
  assert.equal(response.requestId, "req_1");
  assert.equal(response.creditsCharged, 0);
  assert.deepEqual(response.rateLimit, { limit: 20, remaining: 19, reset: 123 });
  assert.equal(response.location, "/v1/transcripts/tr_1");
  assert.equal(response.retryAfter, "1");
  assert.equal(response.thumbnailCache, "miss");
});

test("TypeScript SDK returns structured API problems without automatic retries", async () => {
  let calls = 0;
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async () => {
      calls += 1;
      const problem = structuredClone(contract.components.examples.RateLimitedProblem.value);
      assertOpenApiOperationResponse(contract, {
        operationId: "getAccount",
        status: 429,
        mediaType: "application/problem+json",
        value: problem,
      }, "RateLimitedProblem SDK fixture");
      return jsonResponse(problem, {
        status: 429,
        headers: {
          "x-request-id": "req_limited_header",
          "x-credits-charged": "0",
          "x-ratelimit-limit": "20",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "123",
          location: "/v1/transcripts/tr_limited",
          "retry-after": "9",
          etag: '"problem-v1"',
        },
      });
    },
  });

  await assert.rejects(client.getAccount(), (error) => {
    assert.equal(error instanceof TranscriptLayerError, true);
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.requestId, "req_limited_header");
    assert.equal(error.creditsCharged, 0);
    assert.deepEqual(error.rateLimit, { limit: 20, remaining: 0, reset: 123 });
    assert.equal(error.location, "/v1/transcripts/tr_limited");
    assert.equal(error.etag, '"problem-v1"');
    assert.equal(error.retryAfter, "9");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterSeconds, 9);
    return true;
  });
  assert.equal(calls, 1);
});

test("TypeScript SDK keeps response diagnostics when an error body is invalid", async () => {
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async () => new Response("{broken", {
      status: 503,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": "req_invalid",
        "x-ratelimit-limit": "not-an-integer",
        "retry-after": "Wed, 26 Aug 2026 12:00:00 GMT",
      },
    }),
  });
  await assert.rejects(client.getAccount(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.problem.upstream_status, 503);
    assert.equal(error.requestId, "req_invalid");
    assert.deepEqual(error.rateLimit, { limit: null, remaining: null, reset: null });
    assert.equal(error.retryAfter, "Wed, 26 Aug 2026 12:00:00 GMT");
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });
});

test("TypeScript SDK makes API-key creation caller-retryable", async () => {
  let headers;
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async (_url, init) => {
      headers = new Headers(init.headers);
      return jsonResponse(sdkFixture("api_key_with_secret", { id: "key_new" }), { status: 201 });
    },
  });
  await client.createApiKey({ name: "Deploy", scopes: ["transcripts:read"] }, { idempotencyKey: "deploy-key" });
  assert.equal(headers.get("idempotency-key"), "deploy-key");
});

test("TypeScript SDK blocks base URL and path credential leaks", async () => {
  assert.throws(() => new TranscriptLayerClient({ apiKey: "key", baseUrl: "http://api.example.com" }), /HTTPS/u);
  assert.throws(() => new TranscriptLayerClient({ apiKey: "key\nleak" }), /safe characters/u);
  const client = new TranscriptLayerClient({ apiKey: "key", fetch: async () => assert.fail("request must not run") });
  await assert.rejects(client.request("GET", "/v1/../outside"), /path must stay under \/v1/u);
  assert.throws(() => client.listBatches({ limit: 0 }), /1 to 200/u);
  assert.throws(() => client.listUsage({ limit: 201 }), /1 to 200/u);
});

test("TypeScript SDK lists batches with signed pagination values", async () => {
  let requestedUrl;
  const client = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(sdkFixture("batch_page"));
    },
  });
  await client.listBatches({ cursor: "signed", limit: 25 });
  assert.equal(requestedUrl, "https://api.transcriptlayer.com/v1/batches?cursor=signed&limit=25");
});

test("TypeScript SDK iterates bounded pages without hiding response diagnostics", async () => {
  const requestedUrls = [];
  const responses = [
    uncheckedControlFlowResponse({ items: [{ id: "tr_1" }], next_cursor: "signed-next" }, { headers: { "x-request-id": "req_page_1" } }),
    uncheckedControlFlowResponse({ items: [{ id: "tr_2" }], next_cursor: null }, { headers: { "x-request-id": "req_page_2" } }),
  ];
  const client = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return responses.shift();
    },
  });
  const pages = [];
  for await (const page of client.iterateTranscriptPages({ limit: 25, maxPages: 2 })) pages.push(page);
  assert.deepEqual(pages.map((page) => page.requestId), ["req_page_1", "req_page_2"]);
  assert.deepEqual(requestedUrls, [
    "https://api.transcriptlayer.com/v1/transcripts?limit=25",
    "https://api.transcriptlayer.com/v1/transcripts?cursor=signed-next&limit=25",
  ]);

  const repeated = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async () => jsonResponse(sdkFixture("usage_page", { items: [], next_cursor: "same" })),
  });
  await assert.rejects(async () => {
    for await (const _page of repeated.iterateUsagePages({ cursor: "same" })) assert.fail("repeated cursor page must not be yielded");
  }, (error) => error.code === "invalid_api_response");

  const bounded = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async () => jsonResponse(sdkFixture("batch_page", { next_cursor: "more" })),
  });
  const iterator = bounded.iterateBatchPages({ maxPages: 1 });
  assert.equal((await iterator.next()).done, false);
  await assert.rejects(iterator.next(), (error) => error.code === "pagination_limit_reached");
  assert.throws(() => bounded.iterateWebhookDeliveryPages({ maxPages: 0 }), /1 to 10000/u);
});

test("TypeScript SDK addresses exact request diagnostics safely", async () => {
  let requestedUrl;
  const client = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(sdkFixture("account_request_diagnostic", { request_id: "req_123" }));
    },
  });
  await client.getAccountRequestDiagnostic("req_123");
  assert.equal(requestedUrl, "https://api.transcriptlayer.com/v1/analytics/requests/req_123");
  assert.throws(() => client.getAccountRequestDiagnostic("req_bad/path"), /request ID/u);
});

test("TypeScript SDK waits for transcripts with ETags and returns the terminal response", async () => {
  const calls = [];
  const responses = [
    jsonResponse(operationExample("PendingTranscript", "getTranscript", 200, { id: "tr_wait" }), { headers: { etag: '"tr-v1"' } }),
    new Response(null, { status: 304, headers: { etag: '"tr-v1"' } }),
    jsonResponse(operationExample("CompletedTranscript", "getTranscript", 200, { id: "tr_wait" }), { headers: { etag: '"tr-v2"', "x-request-id": "req_done" } }),
  ];
  const client = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return responses.shift();
    },
  });

  const response = await client.waitForTranscript("tr_wait", { timeoutMs: 1_000, pollIntervalMs: 100 });
  assert.equal(response.data.status, "completed");
  assert.equal(response.requestId, "req_done");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.get("if-none-match"), null);
  assert.equal(calls[1].headers.get("if-none-match"), '"tr-v1"');
  assert.equal(calls[2].headers.get("if-none-match"), '"tr-v1"');
});

test("TypeScript SDK bounds waits, supports cancellation, and rejects invalid resources", async () => {
  const requestTimeoutClient = new TranscriptLayerClient({
    apiKey: "key",
    timeoutMs: 1,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  await assert.rejects(requestTimeoutClient.getAccount(), (error) => {
    assert.equal(error.code, "request_timeout");
    assert.equal(error.retryable, true);
    return true;
  });

  let deadlineCalls = 0;
  const deadlineClient = new TranscriptLayerClient({
    apiKey: "key",
    timeoutMs: 60_000,
    fetch: async (_url, init) => {
      deadlineCalls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(deadlineClient.waitForTranscript("tr_wait", { timeoutMs: 100, pollIntervalMs: 100 }), (error) => {
    assert.equal(error.code, "wait_timeout");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(deadlineCalls, 1);

  let cancelledCalls = 0;
  const cancelledClient = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async () => {
      cancelledCalls += 1;
      return assert.fail("an already-aborted wait must not request a response");
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancelledClient.waitForTranscript("tr_wait", { signal: controller.signal }), (error) => {
    assert.equal(error.code, "request_cancelled");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(cancelledCalls, 0);

  let failureCalls = 0;
  const failedRequestClient = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async () => {
      failureCalls += 1;
      return uncheckedControlFlowResponse({ code: "rate_limited", detail: "Try later", retryable: true }, { status: 429 });
    },
  });
  await assert.rejects(failedRequestClient.waitForTranscript("tr_wait"), (error) => error.code === "rate_limited");
  assert.equal(failureCalls, 1, "wait helpers must not retry failed requests");

  const invalidClient = new TranscriptLayerClient({
    apiKey: "key",
    fetch: async () => uncheckedControlFlowResponse({ id: "tr_other", status: "completed" }),
  });
  await assert.rejects(invalidClient.waitForTranscript("tr_wait"), (error) => error.code === "invalid_api_response");
  assert.throws(() => invalidClient.waitForTranscript("tr_wait", { pollIntervalMs: 99 }), /100 to 60000/u);
});

test("TypeScript SDK waits for batches through cancelling state", async () => {
  const responses = [
    jsonResponse(operationExample("QueuedBatch", "getBatch", 200, { id: "bat_wait", status: "cancelling" }), { headers: { etag: '"bat-v1"' } }),
    jsonResponse(operationExample("CancelledBatch", "getBatch", 200, { id: "bat_wait" }), { headers: { etag: '"bat-v2"' } }),
  ];
  const client = new TranscriptLayerClient({ apiKey: "key", fetch: async () => responses.shift() });
  const response = await client.waitForBatch("bat_wait", { timeoutMs: 1_000, pollIntervalMs: 100 });
  assert.equal(response.data.status, "cancelled");
});

test("TypeScript SDK failed-batch retry creates a new batch with only elapsed retryable failures", async () => {
  const requests = [];
  const now = Date.parse("2026-08-22T12:00:00Z");
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      requests.push({ path: `${parsed.pathname}${parsed.search}`, init });
      if (parsed.pathname === "/v1/batches/bat_source") {
        return jsonResponse(operationExample("CancelledBatch", "getBatch", 200, {
          id: "bat_source",
          status: "completed",
          counts: { total: 2, queued: 0, processing: 0, completed: 2, failed: 0, cancelled: 0 },
        }));
      }
      if (parsed.pathname.endsWith("/items") && !parsed.searchParams.has("cursor")) {
        return uncheckedControlFlowResponse({ items: [{
          reference: "elapsed",
          transcript: {
            status: "failed",
            error: { retryable: true, retry_after_seconds: 60 },
            updated_at: "2026-08-22T11:58:00Z",
            requested: { source: { platform: "youtube", id: "aaaaaaaaaaa" } },
          },
        }], next_cursor: "next" });
      }
      if (parsed.pathname.endsWith("/items")) {
        return uncheckedControlFlowResponse({ items: [{
          reference: "cooldown",
          transcript: {
            status: "failed",
            error: { retryable: true, retry_after_seconds: 600 },
            updated_at: "2026-08-22T11:59:00Z",
            requested: { source: { platform: "youtube", id: "bbbbbbbbbbb" } },
          },
        }, {
          reference: "permanent",
          transcript: {
            status: "failed",
            error: { retryable: false },
            updated_at: "2026-08-22T11:00:00Z",
            requested: { source: { platform: "youtube", id: "ccccccccccc" } },
          },
        }], next_cursor: null });
      }
      if (parsed.pathname === "/v1/batches" && init.method === "POST") {
        return jsonResponse(operationExample("QueuedBatch", "createBatch", 202, { id: "bat_retry" }), { status: 202 });
      }
      assert.fail(`unexpected request ${parsed.pathname}`);
    },
  });

  const response = await client.retryFailedBatch("bat_source", { idempotencyKey: "retry-key", now });
  assert.equal(response.data.id, "bat_retry");
  const create = requests.at(-1);
  assert.equal(new Headers(create.init.headers).get("idempotency-key"), "retry-key");
  assert.deepEqual(JSON.parse(create.init.body), {
    items: [{ source: { platform: "youtube", id: "aaaaaaaaaaa" }, reference: "elapsed" }],
  });
});

test("TypeScript SDK failed-batch retry requires a caller-owned key before reading the source", async () => {
  let calls = 0;
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async () => { calls += 1; return assert.fail("request must not run"); },
  });
  await assert.rejects(client.retryFailedBatch("bat_source"), /idempotency key/u);
  assert.equal(calls, 0);
});

test("TypeScript SDK failed-batch retry makes one ambiguous POST and replays the exact key and body only when called again", async () => {
  const posts = [];
  const now = Date.parse("2026-08-22T12:00:00Z");
  const client = new TranscriptLayerClient({
    apiKey: "tl_test_secret",
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/batches/bat_source") {
        return uncheckedControlFlowResponse({ id: "bat_source", status: "completed" });
      }
      if (parsed.pathname.endsWith("/items")) {
        return uncheckedControlFlowResponse({ items: [{
          reference: "elapsed",
          transcript: {
            status: "failed",
            error: { retryable: true, retry_after_seconds: 60 },
            updated_at: "2026-08-22T11:58:00Z",
            requested: { source: { platform: "youtube", id: "aaaaaaaaaaa" } },
          },
        }], next_cursor: null });
      }
      if (parsed.pathname === "/v1/batches" && init.method === "POST") {
        posts.push({ headers: new Headers(init.headers), body: init.body });
        if (posts.length === 1) throw new TypeError("connection reset after request write");
        return uncheckedControlFlowResponse({ id: "bat_retry", status: "queued" }, { status: 202 });
      }
      return assert.fail(`unexpected request ${parsed.pathname}`);
    },
  });
  const options = { idempotencyKey: "retry-ambiguous", now };
  await assert.rejects(client.retryFailedBatch("bat_source", options), (error) => error.code === "transport_error");
  assert.equal(posts.length, 1, "the helper must not retry an ambiguous POST automatically");
  const replay = await client.retryFailedBatch("bat_source", options);
  assert.equal(replay.data.id, "bat_retry");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers.get("idempotency-key"), "retry-ambiguous");
  assert.equal(posts[1].headers.get("idempotency-key"), "retry-ambiguous");
  assert.equal(posts[1].body, posts[0].body);
});
