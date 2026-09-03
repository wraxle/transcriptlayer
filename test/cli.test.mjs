import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { EXIT, run } from "../src/cli.mjs";

function stream(isTTY = false) {
  let value = "";
  return {
    isTTY,
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

function binaryStream(isTTY = false) {
  const chunks = [];
  return {
    isTTY,
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    bytes() { return Buffer.concat(chunks); },
  };
}

const ENV = {
  TRANSCRIPTLAYER_API_URL: "https://api.example.test",
  TRANSCRIPTLAYER_API_KEY: "tl_test_unit_secret",
};

test("help, version, and completion need no API configuration and expose only the selected-track product", async () => {
  const help = stream();
  assert.equal(await run(["--help"], { env: {}, stdout: help, stderr: stream(), fetchFunction: null }), EXIT.ok);
  assert.match(help.text(), /transcripts create INPUT/);
  assert.match(help.text(), /batches retry-failed/);
  assert.match(help.text(), /--timeout MS\s+Per-request timeout from 1 to 60000 \(default: 15000\)/);
  assert.doesNotMatch(help.text(), /submissions|archives|collections|prices/);

  const version = stream();
  assert.equal(await run(["--version"], { env: {}, stdout: version, stderr: stream(), fetchFunction: null }), EXIT.ok);
  assert.equal(version.text(), "transcriptlayer 0.1.0-beta.1\n");

  const completion = stream();
  assert.equal(await run(["completion", "zsh"], { env: {}, stdout: completion, stderr: stream(), fetchFunction: null }), EXIT.ok);
  assert.match(completion.text(), /#compdef transcriptlayer/);
  assert.doesNotMatch(completion.text(), /submissions|archives/);
});

test("auth status uses the account route, production default, and an environment-only key", async () => {
  let observed;
  const stdout = stream();
  const code = await run(["--json", "auth", "status"], {
    env: { TRANSCRIPTLAYER_API_KEY: "tl_live_secret" },
    stdout,
    stderr: stream(),
    fetchFunction: async (url, init) => {
      observed = { url: String(url), init };
      return Response.json({ id: "acct_1", object: "account", status: "active" });
    },
  });
  assert.equal(code, EXIT.ok);
  assert.equal(observed.url, "https://api.transcriptlayer.com/v1/account");
  assert.equal(observed.init.headers.get("authorization"), "Bearer tl_live_secret");
  assert.equal(JSON.parse(stdout.text()).id, "acct_1");
});

test("caller cancellation aborts an active request and returns the SIGINT exit code", async () => {
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const result = run(["--timeout", "100", "auth", "status"], {
    env: ENV,
    signal: controller.signal,
    stdout: stream(),
    stderr: stream(),
    fetchFunction: async (_url, init) => {
      requestStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await started;
  controller.abort();
  assert.equal(await result, EXIT.interrupted);
});

test("request timeout stays distinct from caller cancellation", async () => {
  const stderr = stream();
  const code = await run(["--json", "--timeout", "1", "auth", "status"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  assert.equal(code, EXIT.service);
  assert.deepEqual(JSON.parse(stderr.text()), { code: "request_timeout", retryable: true });
});

test("caller cancellation stops a polling sleep", async () => {
  const controller = new AbortController();
  let sleepStarted;
  const sleeping = new Promise((resolve) => { sleepStarted = resolve; });
  const result = run(["transcripts", "thumbnail", "tr_wait", "--wait-timeout", "60000"], {
    env: ENV,
    signal: controller.signal,
    stdout: binaryStream(),
    stderr: stream(),
    fetchFunction: async () => new Response(null, { status: 202, headers: { "retry-after": "1" } }),
    sleepFunction: async (_milliseconds, signal) => {
      sleepStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  await sleeping;
  controller.abort();
  assert.equal(await result, EXIT.interrupted);
});

test("caller cancellation stops a batch read from stdin", async () => {
  const controller = new AbortController();
  const stdin = new PassThrough();
  const result = run(["batches", "create", "-", "--idempotency-key", "batch-interrupt"], {
    env: ENV,
    signal: controller.signal,
    stdin,
    stdout: stream(),
    stderr: stream(),
    fetchFunction: async () => assert.fail("request must not run"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await result, EXIT.interrupted);
});

test("transcript creation canonicalizes selection, freshness, includes, and Prefer without leaking diagnostics", async () => {
  let observed;
  const stdout = stream();
  const stderr = stream();
  const code = await run([
    "--json", "--verbose", "transcripts", "create", "youtube:abcdefghijk",
    "--language", "en-us", "--caption-kind", "manual", "--fallback", "any", "--content-format", "both",
    "--include", "metadata", "--include", "available-tracks", "--refresh", "--allow-stale-on-error",
    "--async", "--idempotency-key", "job-1",
  ], {
    env: ENV,
    stdout,
    stderr,
    fetchFunction: async (url, init) => {
      observed = { url: String(url), init };
      return Response.json({ id: "tr_1", object: "transcript", status: "processing", poll_url: "/v1/transcripts/tr_1" }, { status: 202 });
    },
  });
  assert.equal(code, EXIT.ok);
  assert.equal(observed.url, "https://api.example.test/v1/transcripts");
  assert.equal(observed.init.headers.get("idempotency-key"), "job-1");
  assert.equal(observed.init.headers.get("prefer"), "respond-async");
  assert.deepEqual(JSON.parse(observed.init.body), {
    source: { platform: "youtube", id: "abcdefghijk" },
    language_preferences: ["en-US"],
    caption_kinds: ["manual"],
    language_fallback: "any",
    content_format: "both",
    max_age_seconds: 0,
    allow_stale_on_error: true,
    include: ["metadata", "available_tracks"],
  });
  assert.equal(JSON.parse(stdout.text()).status, "processing");
  assert.match(stderr.text(), /> POST https:\/\/api\.example\.test\/v1\/transcripts/);
  assert.doesNotMatch(stderr.text(), /tl_test_unit_secret|abcdefghijk|job-1/);
});

test("the default request timeout outlives the maximum inline wait", async () => {
  let timeoutMs;
  let timeoutDisposed = 0;
  let prefer;
  const code = await run([
    "--json", "transcripts", "create", "abcdefghijk", "--wait-seconds", "10", "--idempotency-key", "job-wait",
  ], {
    env: ENV,
    stdout: stream(),
    stderr: stream(),
    timeoutSignalFunction(milliseconds) {
      timeoutMs = milliseconds;
      return {
        signal: new AbortController().signal,
        dispose() { timeoutDisposed += 1; },
      };
    },
    fetchFunction: async (_url, init) => {
      prefer = init.headers.get("prefer");
      return Response.json({ id: "tr_wait", object: "transcript", status: "processing" }, { status: 202 });
    },
  });
  assert.equal(code, EXIT.ok);
  assert.equal(prefer, "wait=10");
  assert.equal(timeoutMs, 15_000);
  assert.equal(timeoutDisposed, 1);
});

test("human output calls HTTP 202 accepted and prints a polling command", async () => {
  const stdout = stream();
  assert.equal(await run(["transcripts", "create", "abcdefghijk", "--idempotency-key", "job-2"], {
    env: ENV,
    stdout,
    stderr: stream(),
    fetchFunction: async () => Response.json({ id: "tr_wait", status: "queued" }, { status: 202 }),
  }), EXIT.ok);
  assert.match(stdout.text(), /^id: tr_wait\nstatus: accepted\npoll: transcriptlayer transcripts get tr_wait\n$/);
  assert.doesNotMatch(stdout.text(), /completed/);
});

test("unsafe or ambiguous transcript selections fail before a request", async () => {
  const cases = [
    ["transcripts", "create", "abcdefghijk", "--track-id", "track", "--language", "en", "--idempotency-key", "x"],
    ["transcripts", "create", "abcdefghijk", "--refresh", "--max-age", "60", "--idempotency-key", "x"],
    ["transcripts", "create", "https://example.com/watch?v=abcdefghijk", "--idempotency-key", "x"],
  ];
  for (const argv of cases) {
    const stderr = stream();
    assert.equal(await run(argv, {
      env: ENV,
      stdout: stream(),
      stderr,
      fetchFunction: async () => assert.fail("request must not run"),
    }), EXIT.usage);
    assert.notEqual(stderr.text(), "");
  }
});

test("non-interactive transcript and batch mutations require explicit idempotency keys", async () => {
  for (const argv of [["transcripts", "create", "abcdefghijk"], ["batches", "create", "-"]]) {
    const stderr = stream();
    assert.equal(await run(argv, {
      env: ENV,
      stdout: stream(false),
      stderr,
      fetchFunction: async () => assert.fail("request must not run"),
    }), EXIT.usage);
    assert.match(stderr.text(), /idempotency-key is required/);
  }
});

test("a command-line API key is rejected without echoing its value", async () => {
  const stderr = stream();
  assert.equal(await run(["--api-key", "must-not-echo", "auth", "status"], {
    env: {},
    stdout: stream(),
    stderr,
    fetchFunction: async () => assert.fail("request must not run"),
  }), EXIT.usage);
  assert.match(stderr.text(), /TRANSCRIPTLAYER_API_KEY/);
  assert.doesNotMatch(stderr.text(), /must-not-echo/);
});

test("quiet and verbose modes are mutually exclusive", async () => {
  const stderr = stream();
  assert.equal(await run(["--quiet", "--verbose", "auth", "status"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async () => assert.fail("request must not run"),
  }), EXIT.usage);
  assert.match(stderr.text(), /--quiet and --verbose cannot be combined/u);
});

test("unexpected local output failures use the internal exit without leaking state", async () => {
  const stderr = stream();
  const code = await run(["--help"], {
    env: {},
    stdout: { write() { throw new Error("output closed"); } },
    stderr,
    fetchFunction: null,
  });
  assert.equal(code, EXIT.internal);
  assert.deepEqual(JSON.parse(stderr.text()), { code: "cli_internal_error", detail: "output closed" });
});

test("API problems keep stable fields and map to stable exit codes", async () => {
  const cases = [
    [401, EXIT.auth], [404, EXIT.notFound], [409, EXIT.conflict], [413, EXIT.limited], [429, EXIT.limited], [503, EXIT.service],
  ];
  for (const [status, expected] of cases) {
    const stdout = stream();
    const stderr = stream();
    const problem = { code: `failure_${status}`, detail: "failed", status, request_id: "req_1", retryable: status >= 500 };
    const code = await run(["--json", "auth", "status"], {
      env: ENV,
      stdout,
      stderr,
      fetchFunction: async () => Response.json(problem, { status, headers: { "content-type": "application/problem+json" } }),
    });
    assert.equal(code, expected, String(status));
    assert.equal(stdout.text(), "");
    assert.deepEqual(JSON.parse(stderr.text()), problem);
  }
});

test("API errors use response-header correlation and retain it when the body is invalid", async () => {
  const mismatch = stream();
  assert.equal(await run(["--json", "auth", "status"], {
    env: ENV,
    stdout: stream(),
    stderr: mismatch,
    fetchFunction: async () => Response.json({
      code: "rate_limited", detail: "Wait", status: 429,
      request_id: "req_body", retryable: true, retry_after_seconds: 3,
    }, {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": "req_header",
        "retry-after": "9",
      },
    }),
  }), EXIT.limited);
  assert.deepEqual(JSON.parse(mismatch.text()), {
    code: "rate_limited", detail: "Wait", status: 429,
    request_id: "req_header", retryable: true, retry_after_seconds: 9,
  });

  const malformed = stream();
  assert.equal(await run(["--json", "auth", "status"], {
    env: ENV,
    stdout: stream(),
    stderr: malformed,
    fetchFunction: async () => new Response("{broken", {
      status: 503,
      headers: { "content-type": "application/problem+json", "x-request-id": "req_invalid" },
    }),
  }), EXIT.service);
  assert.deepEqual(JSON.parse(malformed.text()), {
    code: "invalid_api_response", upstream_status: 503, retryable: false,
    request_id: "req_invalid",
  });
});

test("terminal transcript failures use retryability for the process exit", async () => {
  for (const [retryable, expected] of [[false, EXIT.conflict], [true, EXIT.service]]) {
    const stdout = stream();
    const code = await run(["--json", "transcripts", "get", "tr_failed"], {
      env: ENV,
      stdout,
      stderr: stream(),
      fetchFunction: async () => Response.json({ id: "tr_failed", status: "failed", error: { code: "temporarily_unavailable", retryable } }),
    });
    assert.equal(code, expected);
    assert.equal(JSON.parse(stdout.text()).status, "failed");
  }
});

test("API URL validation rejects credentials and non-local HTTP", async () => {
  for (const apiUrl of ["http://api.example.test", "https://user:pass@api.example.test"]) {
    const stderr = stream();
    assert.equal(await run(["auth", "status"], {
      env: { ...ENV, TRANSCRIPTLAYER_API_URL: apiUrl },
      stdout: stream(),
      stderr,
      fetchFunction: async () => assert.fail("request must not run"),
    }), EXIT.usage);
    assert.match(stderr.text(), /API URL/);
  }
});

test("CLI rejects an oversized API response before buffering it", async () => {
  const stderr = stream();
  assert.equal(await run(["--json", "auth", "status"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async () => new Response("small", {
      headers: {
        "content-length": String(17 * 1024 * 1024),
        "content-type": "application/json",
        "x-request-id": "req_oversized",
      },
    }),
  }), EXIT.service);
  assert.deepEqual(JSON.parse(stderr.text()), {
    code: "api_response_too_large", retryable: false, request_id: "req_oversized",
  });
});

test("content output preserves bytes and validates the requested media type", async () => {
  const stdout = binaryStream();
  let observed;
  assert.equal(await run(["transcripts", "content", "tr_content", "--format", "vtt"], {
    env: ENV,
    stdout,
    stderr: stream(),
    fetchFunction: async (url, init) => {
      observed = { url: String(url), accept: init.headers.get("accept") };
      return new Response("WEBVTT\n\n", { headers: { "content-type": "text/vtt; charset=utf-8" } });
    },
  }), EXIT.ok);
  assert.equal(stdout.bytes().toString(), "WEBVTT\n\n");
  assert.equal(observed.url, "https://api.example.test/v1/transcripts/tr_content/content?format=vtt");
  assert.equal(observed.accept, "text/vtt");

  const stderr = stream();
  assert.equal(await run(["transcripts", "content", "tr_content", "--format", "srt"], {
    env: ENV,
    stdout: binaryStream(),
    stderr,
    fetchFunction: async () => new Response("wrong", { headers: { "content-type": "text/plain" } }),
  }), EXIT.service);
  assert.match(stderr.text(), /unsupported media type/);
});

test("JSON content remains one compact JSON value", async () => {
  const stdout = stream();
  assert.equal(await run(["--json", "transcripts", "content", "tr_content", "--format", "json"], {
    env: ENV,
    stdout,
    stderr: stream(),
    fetchFunction: async () => Response.json({ included: "text", text: "hello" }),
  }), EXIT.ok);
  assert.deepEqual(JSON.parse(stdout.text()), { included: "text", text: "hello" });
});

test("thumbnail polling keeps progress off stdout and writes exact image bytes", async () => {
  const stdout = binaryStream();
  const stderr = stream();
  let calls = 0;
  const sleeps = [];
  assert.equal(await run(["transcripts", "thumbnail", "tr_thumb", "--wait-timeout", "1000"], {
    env: ENV,
    stdout,
    stderr,
    sleepFunction: async (milliseconds) => sleeps.push(milliseconds),
    fetchFunction: async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 202, headers: { "retry-after": "0" } });
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    },
  }), EXIT.ok);
  assert.deepEqual(stdout.bytes(), Buffer.from([0xff, 0xd8, 0xff]));
  assert.deepEqual(sleeps, [0]);
  assert.match(stderr.text(), /Waiting for thumbnail/);
});

test("thumbnail output refuses terminals, active content, empty bodies, and overwrite", async () => {
  assert.equal(await run(["transcripts", "thumbnail", "tr_thumb"], {
    env: ENV,
    stdout: binaryStream(true),
    stderr: stream(),
    fetchFunction: async () => assert.fail("request must not run"),
  }), EXIT.usage);

  for (const response of [
    () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } }),
  ]) {
    assert.equal(await run(["transcripts", "thumbnail", "tr_thumb"], {
      env: ENV,
      stdout: binaryStream(),
      stderr: stream(),
      fetchFunction: async () => response(),
    }), EXIT.service);
  }

  const stderr = stream();
  assert.equal(await run(["transcripts", "thumbnail", "tr_thumb", "--output", "thumb.jpg"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async () => new Response(Uint8Array.from([1]), { headers: { "content-type": "image/jpeg" } }),
    writeFileFunction: async () => { const error = new Error("exists"); error.code = "EEXIST"; throw error; },
  }), EXIT.usage);
  assert.match(stderr.text(), /already exists/);
});

test("batch create reads one bounded request, normalizes items, and sends one atomic body", async () => {
  let observed;
  const stdout = stream();
  const input = JSON.stringify({
    items: [
      { reference: "one", source: { platform: "youtube", id: "abcdefghijk" }, language_preferences: ["en-us"] },
      { reference: "two", source: { platform: "youtube", id: "bcdefghijkl" }, track_id: "track-two" },
    ],
  });
  assert.equal(await run(["--json", "batches", "create", "-", "--idempotency-key", "batch-1"], {
    env: ENV,
    stdout,
    stderr: stream(),
    readInputFunction: async () => input,
    fetchFunction: async (url, init) => {
      observed = { url: String(url), init };
      return Response.json({ id: "bat_new", status: "queued" }, { status: 202 });
    },
  }), EXIT.ok);
  assert.equal(observed.url, "https://api.example.test/v1/batches");
  assert.equal(observed.init.headers.get("idempotency-key"), "batch-1");
  const body = JSON.parse(observed.init.body);
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.items[0].language_preferences, ["en-US"]);
  assert.deepEqual(body.items[0].caption_kinds, ["manual", "automatic", "unknown"]);
  assert.equal(body.items[1].track_id, "track-two");
  assert.equal(JSON.parse(stdout.text()).id, "bat_new");
});

test("resource, page, cancellation, and usage commands use the deployed paths", async () => {
  const cases = [
    [["transcripts", "get", "tr_one"], "GET", "/v1/transcripts/tr_one", { id: "tr_one", status: "processing" }],
    [["transcripts", "list", "--cursor", "next", "--limit", "10"], "GET", "/v1/transcripts?cursor=next&limit=10", { items: [], next_cursor: null }],
    [["transcripts", "cancel", "tr_one"], "POST", "/v1/transcripts/tr_one/cancel", { id: "tr_one", status: "cancelled" }],
    [["batches", "list", "--cursor", "next", "--limit", "10"], "GET", "/v1/batches?cursor=next&limit=10", { items: [], next_cursor: null }],
    [["batches", "get", "bat_one"], "GET", "/v1/batches/bat_one", { id: "bat_one", status: "processing" }],
    [["batches", "items", "bat_one", "--limit", "20"], "GET", "/v1/batches/bat_one/items?limit=20", { items: [], next_cursor: null }],
    [["batches", "cancel", "bat_one"], "POST", "/v1/batches/bat_one/cancel", { id: "bat_one", status: "cancelling" }],
    [["usage", "list", "--limit", "5"], "GET", "/v1/usage?limit=5", { items: [], next_cursor: null }],
  ];
  for (const [argv, method, path, payload] of cases) {
    assert.equal(await run(["--json", ...argv], {
      env: ENV,
      stdout: stream(),
      stderr: stream(),
      fetchFunction: async (url, init) => {
        const parsed = new URL(url);
        assert.equal(init.method, method);
        assert.equal(`${parsed.pathname}${parsed.search}`, path);
        return Response.json(payload);
      },
    }), EXIT.ok, argv.join(" "));
  }
});

test("batch create rejects raw overflow, item overflow, duplicate references, and duplicate normalized requests", async () => {
  const tooMany = { items: Array.from({ length: 1001 }, (_, index) => ({ reference: String(index), source: { platform: "youtube", id: "abcdefghijk" } })) };
  const cases = [
    "x".repeat((128 * 1024) + 1),
    JSON.stringify(tooMany),
    JSON.stringify({ items: [
      { reference: "same", source: { platform: "youtube", id: "abcdefghijk" } },
      { reference: "same", source: { platform: "youtube", id: "bcdefghijkl" } },
    ] }),
    JSON.stringify({ items: [
      { reference: "a", source: { url: "https://youtu.be/abcdefghijk" } },
      { reference: "b", source: { platform: "youtube", id: "abcdefghijk" } },
    ] }),
  ];
  for (const input of cases) {
    assert.equal(await run(["batches", "create", "-", "--idempotency-key", "batch-x"], {
      env: ENV,
      stdout: stream(),
      stderr: stream(),
      readInputFunction: async () => input,
      fetchFunction: async () => assert.fail("request must not run"),
    }), EXIT.usage);
  }
});

test("deletion polls the same resource to 204 and async mode stops at 202", async () => {
  let calls = 0;
  const sleeps = [];
  const stdout = stream();
  assert.equal(await run(["--json", "transcripts", "delete", "tr_delete", "--wait-timeout", "1000"], {
    env: ENV,
    stdout,
    stderr: stream(),
    sleepFunction: async (milliseconds) => sleeps.push(milliseconds),
    fetchFunction: async (url, init) => {
      assert.equal(String(url), "https://api.example.test/v1/transcripts/tr_delete");
      assert.equal(init.method, "DELETE");
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 202, headers: { "retry-after": "0" } })
        : new Response(null, { status: 204 });
    },
  }), EXIT.ok);
  assert.deepEqual(JSON.parse(stdout.text()), { object: "deletion", resource: "tr_delete", status: "completed" });
  assert.deepEqual(sleeps, [0]);

  calls = 0;
  const asyncOutput = stream();
  assert.equal(await run(["--json", "batches", "delete", "bat_delete", "--async"], {
    env: ENV,
    stdout: asyncOutput,
    stderr: stream(),
    fetchFunction: async () => { calls += 1; return new Response(null, { status: 202 }); },
  }), EXIT.ok);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(asyncOutput.text()).status, "accepted");
});

test("retry-failed creates one new batch from elapsed retryable failures only", async () => {
  const requests = [];
  const old = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now()).toISOString();
  const fetchFunction = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ pathname: parsed.pathname, search: parsed.search, method: init.method, body: init.body });
    if (parsed.pathname === "/v1/batches/bat_source") return Response.json({ id: "bat_source", status: "completed" });
    if (parsed.pathname.endsWith("/items")) return Response.json({
      items: [
        {
          position: 0,
          reference: "retry-me",
          transcript: {
            status: "failed",
            updated_at: old,
            requested: { source: { platform: "youtube", id: "abcdefghijk" }, caption_kinds: ["manual"], language_fallback: "none", content_format: "segments", allow_stale_on_error: false, include: [] },
            error: { retryable: true, retry_after_seconds: 1 },
          },
        },
        {
          position: 1,
          reference: "permanent",
          transcript: { status: "failed", updated_at: old, requested: { source: { platform: "youtube", id: "bcdefghijkl" } }, error: { retryable: false } },
        },
        {
          position: 2,
          reference: "not-yet",
          transcript: { status: "failed", updated_at: future, requested: { source: { platform: "youtube", id: "cdefghijklm" } }, error: { retryable: true, retry_after_seconds: 600 } },
        },
      ],
      next_cursor: null,
    });
    if (parsed.pathname === "/v1/batches") return Response.json({ id: "bat_retry", status: "queued" }, { status: 202 });
    assert.fail(`unexpected request ${parsed.pathname}`);
  };
  const stdout = stream();
  assert.equal(await run(["--json", "batches", "retry-failed", "bat_source", "--idempotency-key", "retry-1"], {
    env: ENV,
    stdout,
    stderr: stream(),
    fetchFunction,
  }), EXIT.ok);
  const posted = requests.find((request) => request.pathname === "/v1/batches");
  const body = JSON.parse(posted.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].reference, "retry-me");
  assert.deepEqual(body.items[0].source, { platform: "youtube", id: "abcdefghijk" });
  assert.deepEqual(JSON.parse(stdout.text()), { source_batch_id: "bat_source", batch: { id: "bat_retry", status: "queued" } });
});

test("retry-failed requires a caller-owned idempotency key before reading the source", async () => {
  let calls = 0;
  const stderr = stream();
  assert.equal(await run(["--json", "batches", "retry-failed", "bat_source"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async () => { calls += 1; return assert.fail("request must not run"); },
  }), EXIT.usage);
  assert.equal(calls, 0);
  assert.match(stderr.text(), /--idempotency-key is required/u);
});

test("retry-failed rejects a repeated page cursor instead of looping", async () => {
  let pages = 0;
  const stderr = stream();
  assert.equal(await run(["--json", "batches", "retry-failed", "bat_loop", "--idempotency-key", "retry-loop"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/batches/bat_loop") return Response.json({ id: "bat_loop", status: "completed" });
      pages += 1;
      return Response.json({ items: [], next_cursor: "same-cursor" });
    },
  }), EXIT.service);
  assert.equal(pages, 2);
  assert.equal(JSON.parse(stderr.text()).code, "invalid_api_response");
});

test("verbose list diagnostics omit cursor query values and credentials", async () => {
  const stderr = stream();
  assert.equal(await run(["--verbose", "--json", "usage", "list", "--cursor", "cursor-secret", "--limit", "10"], {
    env: ENV,
    stdout: stream(),
    stderr,
    fetchFunction: async () => Response.json({ items: [], next_cursor: null }, { headers: {
      "x-request-id": "req_verbose",
      "x-credits-charged": "0",
      "x-ratelimit-limit": "20",
      "x-ratelimit-remaining": "19",
      "x-ratelimit-reset": "1787680800",
      location: "/v1/usage",
      etag: '"usage-v1"',
      "retry-after": "3",
      "x-transcriptlayer-thumbnail-cache": "hit",
    } }),
  }), EXIT.ok);
  assert.match(stderr.text(), /> GET https:\/\/api\.example\.test\/v1\/usage/);
  assert.match(stderr.text(), /< HTTP 200 request_id=req_verbose credits_charged=0 rate_limit=19\/20 rate_reset=1787680800/);
  assert.match(stderr.text(), /retry_after="3" location="\/v1\/usage" etag="\\"usage-v1\\"" thumbnail_cache="hit" retry=0/);
  assert.doesNotMatch(stderr.text(), /cursor-secret|tl_test_unit_secret/);
});
