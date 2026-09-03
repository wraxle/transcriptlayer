import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { InputError, normalizeTranscriptRequest, stableJson } from "./service/protocol.mjs";

const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 128 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const TRANSCRIPT_ID = /^tr_[A-Za-z0-9]+$/;
const BATCH_ID = /^bat_[A-Za-z0-9]+$/;
const TERMINAL_BATCH_STATES = new Set(["completed", "cancelled"]);

const EXIT = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  limited: 6,
  service: 7,
  interrupted: 130,
});

const TOP_HELP = `Usage: transcriptlayer [global options] <command> [arguments]

Commands:
  auth status                              Check the configured key and account
  transcripts create INPUT [options]       Get or start one selected transcript
  transcripts get TRANSCRIPT_ID            Read or poll one transcript request
  transcripts list [--cursor C] [--limit N]
  transcripts cancel TRANSCRIPT_ID         Cancel before the commit grant
  transcripts delete TRANSCRIPT_ID         Hide and erase customer data
  transcripts content TRANSCRIPT_ID        Write text, JSON, SRT, or WebVTT
  transcripts thumbnail TRANSCRIPT_ID      Write validated image bytes
  batches create FILE                      Submit up to 1,000 explicit items
  batches list [--cursor C] [--limit N]    List account batch history
  batches get BATCH_ID                     Read aggregate batch state
  batches items BATCH_ID                   List batch item results
  batches cancel BATCH_ID                  Cancel ungranted items
  batches delete BATCH_ID                  Hide and erase the batch and items
  batches retry-failed BATCH_ID             Create a new batch of eligible failures
  usage list [--cursor C] [--limit N]       List immutable credit entries
  completion bash|zsh|fish                 Print a shell completion script

Global options:
  --api-url URL    API origin (default: https://api.transcriptlayer.com)
  --timeout MS     Per-request timeout from 1 to 60000 (default: 15000)
  --json           Emit one compact JSON value
  --quiet          Suppress non-error diagnostics
  --verbose        Write redacted request diagnostics to stderr
  --no-color       Disable color; accepted for script portability
  --no-input       Disable interactive idempotency-key generation
  --version        Show the CLI version
  -h, --help       Show help

Authentication:
  Set TRANSCRIPTLAYER_API_KEY. A command-line key flag is intentionally unsupported.`;

const GROUP_HELP = {
  auth: "Usage: transcriptlayer auth status",
  transcripts: `Usage: transcriptlayer transcripts <create|get|list|cancel|delete|content|thumbnail> [arguments]

Create options:
  --language TAG             Repeat for ordered language preferences
  --caption-kind KIND        Repeat manual or automatic
  --track-id ID              Select one exact observed track
  --fallback none|any        Language fallback (default: none)
  --content-format FORMAT    segments, text, or both (default: segments)
  --include VALUE            Repeat metadata or available-tracks
  --refresh                  Force a fresh source observation
  --max-age SECONDS          Accept observations from 1 to 2592000 seconds old
  --allow-stale-on-error     Return an older artifact after refresh failure
  --webhook-endpoint-id ID   Deliver the terminal event to this endpoint
  --async                    Return as soon as durable admission commits
  --wait-seconds N           Inline wait from 0 to 10 seconds
  --idempotency-key KEY      Stable retry key

List options:
  --cursor CURSOR            Signed cursor returned by the API
  --limit N                  Page size from 1 to 200

Delete and thumbnail options:
  --wait-timeout MS          Total polling limit (default: 300000)
  --async                    Delete once without polling to 204

Content options:
  --format FORMAT            text, json, srt, or vtt (default: text)

Thumbnail options:
  --output FILE              Create a new file instead of writing stdout`,
  batches: `Usage: transcriptlayer batches <create|list|get|items|cancel|delete|retry-failed> [arguments]

Create options:
  --idempotency-key KEY      Stable retry key

List and items options:
  --cursor CURSOR            Signed cursor returned by the API
  --limit N                  Page size from 1 to 200

Delete options:
  --wait-timeout MS          Total polling limit (default: 300000)
  --async                    Delete once without polling to 204

Retry-failed options:
  --idempotency-key KEY      New stable key for the new atomic batch`,
  usage: "Usage: transcriptlayer usage list [--cursor CURSOR] [--limit N]",
};

const COMPLETION_WORDS = [
  "auth", "transcripts", "batches", "usage", "completion", "status", "create", "get", "list", "cancel", "delete",
  "content", "thumbnail", "items", "retry-failed", "bash", "zsh", "fish", "--api-url", "--timeout", "--json",
  "--quiet", "--verbose", "--no-color", "--no-input", "--help", "--version", "--language", "--caption-kind",
  "--track-id", "--fallback", "--content-format", "--include", "--refresh", "--max-age", "--allow-stale-on-error",
  "--webhook-endpoint-id", "--async", "--wait-seconds", "--wait-timeout", "--idempotency-key", "--format", "--output",
  "--cursor", "--limit",
].join(" ");

const COMPLETIONS = {
  bash: `_transcriptlayer() {
  local current
  current="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${COMPLETION_WORDS}" -- "$current") )
}
complete -F _transcriptlayer transcriptlayer`,
  zsh: `#compdef transcriptlayer
_arguments '*:argument:(${COMPLETION_WORDS})'`,
  fish: `complete -c transcriptlayer -f -a '${COMPLETION_WORDS}'`,
};

class UsageError extends Error {}

class ApiError extends Error {
  constructor(message, status, payload, diagnostics = null) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.diagnostics = diagnostics;
  }
}

function requestTimeout(milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`request timed out after ${milliseconds} ms`, "TimeoutError"));
  }, milliseconds);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); },
  };
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function parseGlobal(argv) {
  const options = { apiUrl: null, timeoutMs: 15_000, json: false, quiet: false, verbose: false, noInput: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--api-url") options.apiUrl = takeValue(argv, index++, argument);
    else if (argument === "--api-key") throw new UsageError("--api-key is unsupported; set TRANSCRIPTLAYER_API_KEY");
    else if (argument === "--timeout") options.timeoutMs = strictInteger(takeValue(argv, index++, argument), argument, 1, 60_000);
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--no-input") options.noInput = true;
    else if (argument === "--no-color") {}
    else rest.push(argument);
  }
  if (options.quiet && options.verbose) throw new UsageError("--quiet and --verbose cannot be combined");
  return { options, rest };
}

function parseOptions(args, definitions) {
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const definition = definitions[argument];
    if (!definition) throw new UsageError(`unknown option: ${argument}`);
    const key = argument.slice(2);
    if (definition === "boolean") values[key] = true;
    else if (definition === "repeat") (values[key] ??= []).push(takeValue(args, index++, argument));
    else values[key] = takeValue(args, index++, argument);
  }
  return { values, positional };
}

function requirePositionals(positional, count, usage) {
  if (positional.length !== count) throw new UsageError(usage);
}

function strictInteger(value, option, minimum, maximum) {
  if (!/^(?:0|[1-9]\d*)$/.test(String(value))) throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function boundedString(value, label, maximum, pattern = null) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new UsageError(`${label} must contain 1 to ${maximum} safe characters`);
  }
  if (pattern && !pattern.test(value)) throw new UsageError(`${label} has an invalid format`);
  return value;
}

function transcriptId(value) {
  return boundedString(value, "transcript ID", 200, TRANSCRIPT_ID);
}

function batchId(value) {
  return boundedString(value, "batch ID", 200, BATCH_ID);
}

function validateApiUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new UsageError("API URL is invalid"); }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new UsageError("API URL must use HTTPS; HTTP is allowed only for localhost");
  if (url.username || url.password || url.search || url.hash) {
    throw new UsageError("API URL cannot contain credentials, a query, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function idempotencyKey(value, context) {
  if (value !== undefined) return boundedString(value, "idempotency key", 200, /^[\x20-\x7e]+$/);
  if (context.noInput || !context.stdout.isTTY) throw new UsageError("--idempotency-key is required in non-interactive mode");
  const generated = crypto.randomUUID();
  if (!context.quiet) writeLine(context.stderr, `Generated idempotency key: ${generated}`);
  return generated;
}

function statusExit(status) {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if ([400, 409, 412, 422].includes(status)) return EXIT.conflict;
  if ([402, 408, 413, 425, 429].includes(status)) return EXIT.limited;
  return EXIT.service;
}

function terminalTranscriptExit(resource) {
  return resource?.status === "failed" ? (resource.error?.retryable ? EXIT.service : EXIT.conflict) : EXIT.ok;
}

function responseDiagnostics(response) {
  const bounded = (name, maximum) => {
    const raw = response.headers.get(name);
    return typeof raw === "string" && raw.length > 0 && raw.length <= maximum && !/[\r\n\0]/u.test(raw)
      ? raw
      : null;
  };
  const integer = (name) => {
    const raw = response.headers.get(name);
    if (raw === null || !/^-?\d+$/u.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const thumbnailCache = bounded("x-transcriptlayer-thumbnail-cache", 32);
  return {
    requestId: (() => {
      const value = bounded("x-request-id", 200);
      return value !== null && /^req_[A-Za-z0-9]+$/u.test(value) ? value : null;
    })(),
    creditsCharged: integer("x-credits-charged"),
    rateLimit: {
      limit: integer("x-ratelimit-limit"),
      remaining: integer("x-ratelimit-remaining"),
      reset: integer("x-ratelimit-reset"),
    },
    location: bounded("location", 2_048),
    etag: bounded("etag", 1_000),
    retryAfter: bounded("retry-after", 128),
    thumbnailCache: new Set(["miss", "hit", "coalesced"]).has(thumbnailCache) ? thumbnailCache : null,
  };
}

function verboseResponseLine(response, diagnostics, attempt) {
  const tokens = [`< HTTP ${response.status}`];
  if (diagnostics.requestId) tokens.push(`request_id=${diagnostics.requestId}`);
  if (diagnostics.creditsCharged !== null) tokens.push(`credits_charged=${diagnostics.creditsCharged}`);
  if (diagnostics.rateLimit.remaining !== null && diagnostics.rateLimit.limit !== null) {
    tokens.push(`rate_limit=${diagnostics.rateLimit.remaining}/${diagnostics.rateLimit.limit}`);
  }
  if (diagnostics.rateLimit.reset !== null) tokens.push(`rate_reset=${diagnostics.rateLimit.reset}`);
  if (diagnostics.retryAfter !== null) tokens.push(`retry_after=${JSON.stringify(diagnostics.retryAfter)}`);
  if (diagnostics.location !== null) tokens.push(`location=${JSON.stringify(diagnostics.location)}`);
  if (diagnostics.etag !== null) tokens.push(`etag=${JSON.stringify(diagnostics.etag)}`);
  if (diagnostics.thumbnailCache !== null) tokens.push(`thumbnail_cache=${JSON.stringify(diagnostics.thumbnailCache)}`);
  tokens.push(`retry=${attempt - 1}`);
  return tokens.join(" ");
}

async function readBody(response, maximum, { bytes = false } = {}) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel("response limit exceeded");
    throw new ApiError(`API response exceeded the ${maximum} byte limit`, 502, {
      code: "api_response_too_large", retryable: false,
    }, responseDiagnostics(response));
  }
  if (!response.body) return bytes ? new Uint8Array() : "";
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel("response limit exceeded");
        throw new ApiError(`API response exceeded the ${maximum} byte limit`, 502, {
          code: "api_response_too_large", retryable: false,
        }, responseDiagnostics(response));
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return bytes ? joined : new TextDecoder().decode(joined);
}

function parseJson(text, status, diagnostics = null) {
  try { return text === "" ? {} : JSON.parse(text); }
  catch {
    throw new ApiError("API returned invalid JSON", 502, {
      code: "invalid_api_response", upstream_status: status, retryable: false,
    }, diagnostics);
  }
}

function problemMessage(payload, status) {
  if (payload && typeof payload === "object") return payload.detail ?? payload.message ?? payload.code ?? `request failed with HTTP ${status}`;
  return typeof payload === "string" && payload ? payload.slice(0, 500) : `request failed with HTTP ${status}`;
}

async function apiRequest(context, method, path, {
  body,
  idempotency,
  accept = "application/json",
  prefer,
  responseType = "json",
  maximumBytes = MAX_API_RESPONSE_BYTES,
  expectedMediaTypes = null,
  attempt = 1,
} = {}) {
  const url = new URL(path.replace(/^\//, ""), context.apiUrl);
  const headers = new Headers({
    accept,
    authorization: `Bearer ${context.apiKey}`,
    "user-agent": "transcriptlayer-cli/0.1.0-beta.1",
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotency) headers.set("idempotency-key", idempotency);
  if (prefer) headers.set("prefer", prefer);
  if (context.verbose) writeLine(context.stderr, `> ${method} ${url.origin}${url.pathname}`);

  let response;
  let timeout;
  try {
    timeout = context.timeoutSignalFunction(context.timeoutMs);
    const timeoutSignal = timeout?.signal ?? timeout;
    const requestSignal = context.signal === null
      ? timeoutSignal
      : AbortSignal.any([context.signal, timeoutSignal]);
    response = await context.fetchFunction(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: requestSignal,
    });
  } catch (error) {
    if (context.signal?.aborted) throw new DOMException("The operation was interrupted", "AbortError");
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ApiError(`request timed out after ${context.timeoutMs} ms`, 504, { code: "request_timeout", retryable: true });
    }
    throw new ApiError("API transport failed", 503, { code: "transport_error", retryable: true });
  } finally {
    if (typeof timeout?.dispose === "function") timeout.dispose();
  }
  const diagnostics = responseDiagnostics(response);
  if (context.verbose) writeLine(context.stderr, verboseResponseLine(response, diagnostics, attempt));

  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!response.ok) {
    const text = await readBody(response, MAX_API_RESPONSE_BYTES);
    const payload = mediaType.includes("json") || text.trimStart().startsWith("{")
      ? parseJson(text, response.status, diagnostics)
      : text;
    throw new ApiError(problemMessage(payload, response.status), response.status, payload, diagnostics);
  }
  if (response.status === 204 || response.status === 304) return { status: response.status, headers: response.headers, mediaType, data: null };
  if (response.status === 202 && responseType === "bytes") {
    await response.body?.cancel("pending response has no representation");
    return { status: response.status, headers: response.headers, mediaType, data: null };
  }
  if (responseType === "bytes") {
    if (expectedMediaTypes && !expectedMediaTypes.includes(mediaType)) {
      await response.body?.cancel("unexpected media type");
      throw new ApiError(`API returned unsupported media type ${mediaType || "none"}`, 502, {
        code: "invalid_api_response", retryable: false,
      }, diagnostics);
    }
    const data = await readBody(response, maximumBytes, { bytes: true });
    if (data.byteLength === 0) {
      throw new ApiError("API returned an empty body", 502, {
        code: "invalid_api_response", retryable: false,
      }, diagnostics);
    }
    return { status: response.status, headers: response.headers, mediaType, data };
  }
  const text = await readBody(response, maximumBytes);
  const data = responseType === "text" ? text : parseJson(text, response.status, diagnostics);
  return { status: response.status, headers: response.headers, mediaType, data };
}

function withQuery(path, values) {
  const url = new URL(path, "https://placeholder.invalid");
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function pageOptions(tail, usage) {
  const parsed = parseOptions(tail, { "--cursor": "value", "--limit": "value" });
  const cursor = parsed.values.cursor === undefined ? undefined : boundedString(parsed.values.cursor, "cursor", 1_000);
  const limit = parsed.values.limit === undefined ? undefined : strictInteger(parsed.values.limit, "--limit", 1, 200);
  return { parsed, cursor, limit, usage };
}

function buildTranscriptRequest(input, values) {
  if (values.refresh && values["max-age"] !== undefined) throw new UsageError("--refresh and --max-age cannot be combined");
  if (values.async && values["wait-seconds"] !== undefined) throw new UsageError("--async and --wait-seconds cannot be combined");
  const maxAge = values.refresh ? 0 : values["max-age"] === undefined
    ? undefined
    : strictInteger(values["max-age"], "--max-age", 1, 2_592_000);
  const qualifiedSource = input.match(/^([a-z][a-z0-9_]{0,31}):([A-Za-z0-9._~-]{1,128})$/);
  const source = qualifiedSource
    ? { platform: qualifiedSource[1], id: qualifiedSource[2] }
    : /^[A-Za-z0-9_-]{11}$/.test(input)
      ? { platform: "youtube", id: input }
      : { url: boundedString(input, "input", 2_048) };
  const include = values.include?.map((value) => value === "available-tracks" ? "available_tracks" : value);
  if (include?.some((value) => !["metadata", "available_tracks"].includes(value))) {
    throw new UsageError("--include must be metadata or available-tracks");
  }
  try {
    return normalizeTranscriptRequest({
      source,
      ...(values["track-id"] === undefined ? {} : { track_id: values["track-id"] }),
      ...(values.language === undefined ? {} : { language_preferences: values.language }),
      ...(values["caption-kind"] === undefined ? {} : { caption_kinds: values["caption-kind"] }),
      ...(values.fallback === undefined ? {} : { language_fallback: values.fallback }),
      ...(values["content-format"] === undefined ? {} : { content_format: values["content-format"] }),
      ...(maxAge === undefined ? {} : { max_age_seconds: maxAge }),
      ...(values["allow-stale-on-error"] ? { allow_stale_on_error: true } : {}),
      ...(include === undefined ? {} : { include }),
      ...(values["webhook-endpoint-id"] === undefined ? {} : { webhook_endpoint_id: values["webhook-endpoint-id"] }),
    });
  } catch (error) {
    if (error instanceof InputError) throw new UsageError(error.message);
    throw error;
  }
}

function waitTimeout(values) {
  return values["wait-timeout"] === undefined
    ? DEFAULT_WAIT_TIMEOUT_MS
    : strictInteger(values["wait-timeout"], "--wait-timeout", 1, 3_600_000);
}

function retryDelay(headers) {
  const value = Number(headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60) * 1_000 : 1_000;
}

async function pollDeletion(context, path, resource, { async = false, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const result = await apiRequest(context, "DELETE", path, { attempt });
    if (result.status === 204) return { object: "deletion", resource, status: "completed" };
    if (result.status !== 202) throw new ApiError("API returned an invalid deletion response", 502, { code: "invalid_api_response", retryable: false });
    if (async) return { object: "deletion", resource, status: "accepted" };
    const delay = retryDelay(result.headers);
    if (Date.now() + delay > deadline) {
      throw new ApiError(`deletion did not finish within ${timeoutMs} ms`, 408, { code: "wait_timeout", retryable: true });
    }
    if (!context.quiet) writeLine(context.stderr, `Waiting for ${resource} erasure`);
    await context.sleepFunction(delay, context.signal);
  }
}

async function readInputBounded(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maximum) {
      stream.destroy?.();
      throw new UsageError(`batch request exceeds ${maximum} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function defaultReadInput(pathname, stdin, signal) {
  const stream = pathname === "-" ? stdin : createReadStream(pathname, { signal: signal ?? undefined });
  const abort = () => stream.destroy?.(new DOMException("The operation was interrupted", "AbortError"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await readInputBounded(stream, MAX_BATCH_BYTES);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function normalizeBatchFile(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new UsageError("batch file must contain valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new UsageError("batch file must contain one JSON object");
  }
  const unknown = Object.keys(value).filter((key) => !["items", "webhook_endpoint_id"].includes(key));
  if (unknown.length) throw new UsageError(`unknown batch field: ${unknown[0]}`);
  if (value.webhook_endpoint_id !== undefined
    && !/^whe_[A-Za-z0-9]+$/.test(value.webhook_endpoint_id)) {
    throw new UsageError("webhook_endpoint_id has an invalid format");
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 1_000) {
    throw new UsageError("batch must contain 1 to 1000 items");
  }
  const references = new Set();
  const requests = new Set();
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new UsageError(`items[${index}] must be a JSON object`);
    }
    if (Object.hasOwn(item, "webhook_endpoint_id")) throw new UsageError(`items[${index}].webhook_endpoint_id is not allowed`);
    const { reference, ...request } = item;
    boundedString(reference, `items[${index}].reference`, 100);
    if (references.has(reference)) throw new UsageError("batch item references must be unique");
    references.add(reference);
    let normalized;
    try { normalized = normalizeTranscriptRequest(request); }
    catch (error) {
      if (error instanceof InputError) throw new UsageError(`items[${index}]: ${error.message}`);
      throw error;
    }
    const identity = stableJson({
      source: normalized.source,
      ...(normalized.track_id === undefined
        ? {
          ...(normalized.language_preferences === undefined ? {} : { language_preferences: normalized.language_preferences }),
          caption_kinds: normalized.caption_kinds,
          language_fallback: normalized.language_fallback,
        }
        : { track_id: normalized.track_id }),
    });
    if (requests.has(identity)) throw new UsageError("normalized batch item requests must be unique");
    requests.add(identity);
    return { ...normalized, reference };
  });
  const normalized = { items, ...(value.webhook_endpoint_id === undefined ? {} : { webhook_endpoint_id: value.webhook_endpoint_id }) };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BATCH_BYTES) throw new UsageError(`normalized batch request exceeds ${MAX_BATCH_BYTES} bytes`);
  return normalized;
}

async function collectBatchItems(context, id) {
  const items = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await apiRequest(context, "GET", withQuery(`/v1/batches/${encodeURIComponent(id)}/items`, { cursor, limit: 200 }));
    if (!Array.isArray(page.data?.items) || !(page.data.next_cursor === null || typeof page.data.next_cursor === "string")) {
      throw new ApiError("API returned an invalid batch page", 502, { code: "invalid_api_response", retryable: false });
    }
    items.push(...page.data.items);
    if (items.length > 1_000) throw new ApiError("API returned too many batch items", 502, { code: "invalid_api_response", retryable: false });
    cursor = page.data.next_cursor;
    if (cursor !== null) {
      if (cursor.length < 1 || cursor.length > 1_000 || /[\r\n\0]/.test(cursor)) {
        throw new ApiError("API returned an invalid batch cursor", 502, { code: "invalid_api_response", retryable: false });
      }
      if (cursors.has(cursor)) throw new ApiError("API repeated a batch cursor", 502, { code: "invalid_api_response", retryable: false });
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

function retryEligible(item, now) {
  const transcript = item?.transcript;
  if (!transcript || transcript.status !== "failed" || transcript.error?.retryable !== true) return false;
  const seconds = transcript.error.retry_after_seconds ?? 0;
  const anchor = Date.parse(transcript.updated_at ?? transcript.completed_at ?? "");
  return Number.isFinite(anchor) && Number.isInteger(seconds) && seconds >= 0 && anchor + (seconds * 1_000) <= now;
}

function humanValue(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

function emitTranscript(data, context, accepted) {
  writeLine(context.stdout, `id: ${data.id}`);
  writeLine(context.stdout, `status: ${accepted ? "accepted" : data.status}`);
  if (accepted) {
    writeLine(context.stdout, `poll: transcriptlayer transcripts get ${data.id}`);
    return;
  }
  if (data.track) writeLine(context.stdout, `track: ${data.track.id}`);
  if (data.track?.language) writeLine(context.stdout, `language: ${data.track.language}`);
  if (data.retrieval?.observed_at) writeLine(context.stdout, `observed_at: ${data.retrieval.observed_at}`);
  if (Number.isInteger(data.retrieval?.cache_age_seconds)) writeLine(context.stdout, `cache_age_seconds: ${data.retrieval.cache_age_seconds}`);
  if (Number.isInteger(data.usage?.credits_charged)) writeLine(context.stdout, `credits_charged: ${data.usage.credits_charged}`);
  if (data.error) writeLine(context.stdout, `error: ${data.error.code}`);
}

function emitData(result, context) {
  if (result.raw instanceof Uint8Array) {
    context.stdout.write(result.raw);
    return;
  }
  if (context.json) {
    writeLine(context.stdout, JSON.stringify(result.data));
    return;
  }
  if (result.kind === "transcript") {
    emitTranscript(result.data, context, result.accepted);
    return;
  }
  if (typeof result.data === "string") {
    context.stdout.write(result.data.endsWith("\n") ? result.data : `${result.data}\n`);
    return;
  }
  for (const [key, value] of Object.entries(result.data ?? {})) writeLine(context.stdout, `${key}: ${humanValue(value)}`);
}

async function dispatch(args, context) {
  const [group, action, ...tail] = args;
  if (!group || group === "help" || group === "--help" || group === "-h") return { local: TOP_HELP };
  if (group === "--version") {
    requirePositionals([action, ...tail].filter((value) => value !== undefined), 0, "Usage: transcriptlayer --version");
    return { local: "transcriptlayer 0.1.0-beta.1" };
  }
  if (group === "completion") {
    requirePositionals([action, ...tail].filter((value) => value !== undefined), 1, "Usage: transcriptlayer completion bash|zsh|fish");
    if (!COMPLETIONS[action]) throw new UsageError("completion shell must be bash, zsh, or fish");
    return { local: COMPLETIONS[action] };
  }
  if (action === "--help" || action === "-h" || (!action && GROUP_HELP[group]) || tail.includes("--help") || tail.includes("-h")) {
    return { local: GROUP_HELP[group] ?? TOP_HELP };
  }

  if (group === "auth" && action === "status") {
    requirePositionals(tail, 0, GROUP_HELP.auth);
    return { data: (await apiRequest(context, "GET", "/v1/account")).data };
  }

  if (group === "transcripts" && action === "create") {
    const parsed = parseOptions(tail, {
      "--language": "repeat", "--caption-kind": "repeat", "--track-id": "value", "--fallback": "value",
      "--content-format": "value", "--include": "repeat", "--refresh": "boolean", "--max-age": "value",
      "--allow-stale-on-error": "boolean", "--webhook-endpoint-id": "value", "--async": "boolean",
      "--wait-seconds": "value", "--idempotency-key": "value",
    });
    requirePositionals(parsed.positional, 1, GROUP_HELP.transcripts);
    const body = buildTranscriptRequest(parsed.positional[0], parsed.values);
    const key = idempotencyKey(parsed.values["idempotency-key"], context);
    const waitSeconds = parsed.values["wait-seconds"] === undefined ? undefined : strictInteger(parsed.values["wait-seconds"], "--wait-seconds", 0, 10);
    const prefer = parsed.values.async ? "respond-async" : waitSeconds === undefined ? undefined : `wait=${waitSeconds}`;
    const response = await apiRequest(context, "POST", "/v1/transcripts", { body, idempotency: key, prefer });
    return { data: response.data, kind: "transcript", accepted: response.status === 202, exitCode: terminalTranscriptExit(response.data) };
  }
  if (group === "transcripts" && action === "get") {
    requirePositionals(tail, 1, GROUP_HELP.transcripts);
    const data = (await apiRequest(context, "GET", `/v1/transcripts/${encodeURIComponent(transcriptId(tail[0]))}`)).data;
    return { data, kind: "transcript", exitCode: terminalTranscriptExit(data) };
  }
  if (group === "transcripts" && action === "list") {
    const { parsed, cursor, limit } = pageOptions(tail, GROUP_HELP.transcripts);
    requirePositionals(parsed.positional, 0, GROUP_HELP.transcripts);
    return { data: (await apiRequest(context, "GET", withQuery("/v1/transcripts", { cursor, limit }))).data };
  }
  if (group === "transcripts" && action === "cancel") {
    requirePositionals(tail, 1, GROUP_HELP.transcripts);
    const data = (await apiRequest(context, "POST", `/v1/transcripts/${encodeURIComponent(transcriptId(tail[0]))}/cancel`)).data;
    return { data, kind: "transcript", exitCode: terminalTranscriptExit(data) };
  }
  if (group === "transcripts" && action === "delete") {
    const parsed = parseOptions(tail, { "--async": "boolean", "--wait-timeout": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.transcripts);
    const id = transcriptId(parsed.positional[0]);
    return { data: await pollDeletion(context, `/v1/transcripts/${encodeURIComponent(id)}`, id, { async: parsed.values.async, timeoutMs: waitTimeout(parsed.values) }) };
  }
  if (group === "transcripts" && action === "content") {
    const parsed = parseOptions(tail, { "--format": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.transcripts);
    const format = parsed.values.format ?? "text";
    const media = { text: "text/plain", json: "application/json", srt: "application/x-subrip", vtt: "text/vtt" }[format];
    if (!media) throw new UsageError("--format must be text, json, srt, or vtt");
    if (context.json && format !== "json") throw new UsageError("--json requires --format json for transcript content");
    const response = await apiRequest(context, "GET", withQuery(`/v1/transcripts/${encodeURIComponent(transcriptId(parsed.positional[0]))}/content`, { format }), {
      accept: media,
      responseType: "bytes",
      expectedMediaTypes: [media],
    });
    if (context.json) return { data: parseJson(new TextDecoder().decode(response.data), response.status) };
    return { raw: response.data };
  }
  if (group === "transcripts" && action === "thumbnail") {
    const parsed = parseOptions(tail, { "--output": "value", "--wait-timeout": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.transcripts);
    if (context.json) throw new UsageError("--json cannot be used with thumbnail bytes");
    if (!parsed.values.output && context.stdout.isTTY) throw new UsageError("thumbnail output requires redirection or --output FILE");
    const id = transcriptId(parsed.positional[0]);
    const deadline = Date.now() + waitTimeout(parsed.values);
    let response;
    let attempt = 0;
    while (true) {
      attempt += 1;
      response = await apiRequest(context, "GET", `/v1/transcripts/${encodeURIComponent(id)}/thumbnail`, {
        accept: "image/jpeg, image/png, image/webp",
        responseType: "bytes",
        maximumBytes: MAX_THUMBNAIL_BYTES,
        expectedMediaTypes: ["image/jpeg", "image/png", "image/webp"],
        attempt,
      });
      if (response.status === 200) break;
      const delay = retryDelay(response.headers);
      if (response.status !== 202 || Date.now() + delay > deadline) {
        throw new ApiError("thumbnail did not become available within the wait limit", 408, { code: "wait_timeout", retryable: true });
      }
      if (!context.quiet) writeLine(context.stderr, "Waiting for thumbnail materialization");
      await context.sleepFunction(delay, context.signal);
    }
    if (parsed.values.output) {
      const pathname = boundedString(parsed.values.output, "output path", 4_096);
      try { await context.writeFileFunction(pathname, response.data, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error?.code === "EEXIST") throw new UsageError(`output file already exists: ${pathname}`);
        throw error;
      }
      if (!context.quiet) writeLine(context.stderr, `Wrote ${response.data.byteLength} bytes to ${pathname}`);
      return { data: null, suppress: true };
    }
    return { raw: response.data };
  }

  if (group === "batches" && action === "create") {
    const parsed = parseOptions(tail, { "--idempotency-key": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.batches);
    const key = idempotencyKey(parsed.values["idempotency-key"], context);
    let text;
    try { text = await context.readInputFunction(parsed.positional[0], context.stdin, context.signal); }
    catch (error) {
      if (error instanceof UsageError) throw error;
      if (error?.name === "AbortError") throw error;
      throw new UsageError(`could not read batch file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.byteLength(text) > MAX_BATCH_BYTES) throw new UsageError(`batch request exceeds ${MAX_BATCH_BYTES} bytes`);
    const body = normalizeBatchFile(text);
    return { data: (await apiRequest(context, "POST", "/v1/batches", { body, idempotency: key })).data };
  }
  if (group === "batches" && action === "list") {
    const { parsed, cursor, limit } = pageOptions(tail, GROUP_HELP.batches);
    requirePositionals(parsed.positional, 0, GROUP_HELP.batches);
    return { data: (await apiRequest(context, "GET", withQuery("/v1/batches", { cursor, limit }))).data };
  }
  if (group === "batches" && action === "get") {
    requirePositionals(tail, 1, GROUP_HELP.batches);
    return { data: (await apiRequest(context, "GET", `/v1/batches/${encodeURIComponent(batchId(tail[0]))}`)).data };
  }
  if (group === "batches" && action === "items") {
    const { parsed, cursor, limit } = pageOptions(tail, GROUP_HELP.batches);
    requirePositionals(parsed.positional, 1, GROUP_HELP.batches);
    const id = batchId(parsed.positional[0]);
    return { data: (await apiRequest(context, "GET", withQuery(`/v1/batches/${encodeURIComponent(id)}/items`, { cursor, limit }))).data };
  }
  if (group === "batches" && action === "cancel") {
    requirePositionals(tail, 1, GROUP_HELP.batches);
    return { data: (await apiRequest(context, "POST", `/v1/batches/${encodeURIComponent(batchId(tail[0]))}/cancel`)).data };
  }
  if (group === "batches" && action === "delete") {
    const parsed = parseOptions(tail, { "--async": "boolean", "--wait-timeout": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.batches);
    const id = batchId(parsed.positional[0]);
    return { data: await pollDeletion(context, `/v1/batches/${encodeURIComponent(id)}`, id, { async: parsed.values.async, timeoutMs: waitTimeout(parsed.values) }) };
  }
  if (group === "batches" && action === "retry-failed") {
    const parsed = parseOptions(tail, { "--idempotency-key": "value" });
    requirePositionals(parsed.positional, 1, GROUP_HELP.batches);
    const id = batchId(parsed.positional[0]);
    if (parsed.values["idempotency-key"] === undefined) {
      throw new UsageError("--idempotency-key is required for batches retry-failed");
    }
    const key = boundedString(parsed.values["idempotency-key"], "idempotency key", 200, /^[\x20-\x7e]+$/);
    const source = (await apiRequest(context, "GET", `/v1/batches/${encodeURIComponent(id)}`)).data;
    if (!TERMINAL_BATCH_STATES.has(source?.status)) throw new ApiError("source batch is not terminal", 409, { code: "batch_not_terminal", retryable: false });
    const items = await collectBatchItems(context, id);
    const eligible = items.filter((item) => retryEligible(item, Date.now())).map((item) => ({ ...item.transcript.requested, reference: item.reference }));
    if (eligible.length === 0) throw new ApiError("source batch has no retryable failures whose delay has elapsed", 409, { code: "no_retryable_items", retryable: false });
    const body = normalizeBatchFile(JSON.stringify({ items: eligible }));
    const created = (await apiRequest(context, "POST", "/v1/batches", { body, idempotency: key })).data;
    return { data: { source_batch_id: id, batch: created } };
  }

  if (group === "usage" && action === "list") {
    const { parsed, cursor, limit } = pageOptions(tail, GROUP_HELP.usage);
    requirePositionals(parsed.positional, 0, GROUP_HELP.usage);
    return { data: (await apiRequest(context, "GET", withQuery("/v1/usage", { cursor, limit }))).data };
  }

  throw new UsageError(`unknown command: ${[group, action].filter(Boolean).join(" ")}\n\n${TOP_HELP}`);
}

function emitApiError(error, context) {
  const problem = error.payload && typeof error.payload === "object" && !Array.isArray(error.payload)
    ? { ...error.payload }
    : {
        code: error.payload?.code ?? "api_error",
        status: error.status,
        detail: error.message,
        retryable: false,
      };
  if (error.diagnostics?.requestId) problem.request_id = error.diagnostics.requestId;
  const retryAfter = error.diagnostics?.retryAfter;
  if (typeof retryAfter === "string" && /^\d+$/u.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds)) problem.retry_after_seconds = seconds;
  }
  if (context.json) {
    writeLine(context.stderr, JSON.stringify(problem));
    return;
  }
  const code = problem.code ?? "api_error";
  const requestId = problem.request_id ? ` request_id=${problem.request_id}` : "";
  const retry = Number.isSafeInteger(problem.retry_after_seconds)
    ? ` retry_after_seconds=${problem.retry_after_seconds}`
    : "";
  writeLine(context.stderr, `${code}: ${error.message} (HTTP ${error.status})${requestId}${retry}`);
}

export async function run(argv, {
  env = process.env,
  fetchFunction = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  signal = null,
  timeoutSignalFunction = requestTimeout,
  sleepFunction = (milliseconds, activeSignal) => sleep(milliseconds, undefined, { signal: activeSignal ?? undefined }),
  readInputFunction = defaultReadInput,
  writeFileFunction = writeFile,
} = {}) {
  let context = { json: false };
  try {
    const { options, rest } = parseGlobal(argv);
    const helpOnly = rest.length === 0 || rest.includes("--help") || rest.includes("-h") || rest[0] === "help";
    const localOnly = helpOnly || rest[0] === "--version" || rest[0] === "completion";
    context = {
      ...options,
      stdout,
      stderr,
      stdin,
      signal,
      timeoutSignalFunction,
      fetchFunction,
      sleepFunction,
      readInputFunction,
      writeFileFunction,
      apiUrl: localOnly ? null : validateApiUrl(options.apiUrl ?? env.TRANSCRIPTLAYER_API_URL ?? "https://api.transcriptlayer.com"),
      apiKey: localOnly ? null : env.TRANSCRIPTLAYER_API_KEY,
    };
    if (!localOnly && !context.apiKey) throw new UsageError("set TRANSCRIPTLAYER_API_KEY; command-line key flags are unsupported");
    if (!localOnly) boundedString(context.apiKey, "TRANSCRIPTLAYER_API_KEY", 4_096);
    const result = await dispatch(rest, context);
    if (result.local !== undefined) writeLine(stdout, result.local);
    else if (!result.suppress) emitData(result, context);
    return result.exitCode ?? EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      writeLine(stderr, error.message);
      return EXIT.usage;
    }
    if (error instanceof ApiError) {
      emitApiError(error, context);
      return statusExit(error.status);
    }
    if (error?.name === "AbortError") return EXIT.interrupted;
    writeLine(stderr, JSON.stringify({ code: "cli_internal_error", detail: error instanceof Error ? error.message : String(error) }));
    return EXIT.internal;
  }
}

export { EXIT };
