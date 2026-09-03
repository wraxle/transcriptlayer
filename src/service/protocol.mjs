import { OPENAPI_RUNTIME_CONSTRAINTS } from "./generated/openapi-constraints.mjs";
import { sourceRegistry, SourceReferenceError } from "./source-registry.mjs";

const REQUEST = OPENAPI_RUNTIME_CONSTRAINTS.transcript_request;
const TRACK_ID = new RegExp(`^[^\\r\\n\\0]{${REQUEST.track_id_min_length},${REQUEST.track_id_max_length}}$`);
const WEBHOOK_ID = new RegExp(REQUEST.webhook_endpoint_id_pattern);
const ALLOWED_FIELDS = new Set(REQUEST.allowed_fields);

export class InputError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requirePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new InputError("The request body must be a JSON object.");
  }
}

function uniqueArray(value, name, { minimum = 1, maximum, allowed = null } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new InputError(`${name} must contain ${minimum} to ${maximum} items.`);
  }
  if (new Set(value).size !== value.length) throw new InputError(`${name} cannot contain duplicates.`);
  if (allowed && value.some((entry) => !allowed.has(entry))) throw new InputError(`${name} contains an unsupported value.`);
  return [...value];
}

function canonicalLanguages(value) {
  const languages = uniqueArray(value, "language_preferences", {
    minimum: REQUEST.language_preferences_min_items,
    maximum: REQUEST.language_preferences_max_items,
  });
  if (languages.some((language) => typeof language !== "string"
    || language.length < REQUEST.language_preference_min_length
    || language.length > REQUEST.language_preference_max_length)) {
    throw new InputError("language_preferences contains an invalid language tag.");
  }
  try {
    const result = Intl.getCanonicalLocales(languages);
    if (new Set(result).size !== result.length) throw new InputError("language_preferences cannot contain equivalent duplicates.");
    return result;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("language_preferences contains an invalid language tag.");
  }
}

export function normalizeTranscriptRequest(input) {
  requirePlainObject(input);
  const unknown = Object.keys(input).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknown.length) throw new InputError(`Unknown request field: ${unknown[0]}.`);

  let source;
  try {
    source = sourceRegistry.normalize(input.source, { urlMaxLength: REQUEST.source_url_max_length });
  } catch (error) {
    if (error instanceof SourceReferenceError) throw new InputError(error.message, error.code, error.status);
    throw error;
  }

  const hasTrack = Object.hasOwn(input, "track_id");
  if (hasTrack && (Object.hasOwn(input, "language_preferences") || Object.hasOwn(input, "caption_kinds") || Object.hasOwn(input, "language_fallback"))) {
    throw new InputError("track_id cannot be combined with language or caption-kind selection.");
  }
  if (hasTrack && (typeof input.track_id !== "string" || !TRACK_ID.test(input.track_id))) {
    throw new InputError("track_id is invalid.");
  }

  const normalized = {
    source: {
      platform: source.platform,
      id: source.id,
    },
  };
  if (hasTrack) normalized.track_id = input.track_id;
  else {
    if (input.language_preferences !== undefined) normalized.language_preferences = canonicalLanguages(input.language_preferences);
    normalized.caption_kinds = input.caption_kinds === undefined
      ? [...REQUEST.default_caption_kinds]
      : uniqueArray(input.caption_kinds, "caption_kinds", {
        minimum: REQUEST.caption_kinds_min_items,
        maximum: REQUEST.caption_kinds_max_items,
        allowed: new Set(REQUEST.caption_kinds),
      });
    normalized.language_fallback = input.language_fallback ?? REQUEST.default_language_fallback;
    if (!REQUEST.language_fallbacks.includes(normalized.language_fallback)) throw new InputError("language_fallback is invalid.");
  }

  normalized.content_format = input.content_format ?? REQUEST.default_content_format;
  if (!REQUEST.content_formats.includes(normalized.content_format)) throw new InputError("content_format is invalid.");
  if (input.max_age_seconds !== undefined) {
    if (!Number.isInteger(input.max_age_seconds)
      || input.max_age_seconds < REQUEST.max_age_seconds_minimum
      || input.max_age_seconds > REQUEST.max_age_seconds_maximum) {
      throw new InputError(`max_age_seconds must be an integer from ${REQUEST.max_age_seconds_minimum} to ${REQUEST.max_age_seconds_maximum}.`);
    }
    normalized.max_age_seconds = input.max_age_seconds;
  }
  normalized.allow_stale_on_error = input.allow_stale_on_error ?? REQUEST.default_allow_stale_on_error;
  if (typeof normalized.allow_stale_on_error !== "boolean") throw new InputError("allow_stale_on_error must be a boolean.");
  if (normalized.allow_stale_on_error && input.max_age_seconds === undefined) {
    throw new InputError("allow_stale_on_error requires max_age_seconds.");
  }
  normalized.include = input.include === undefined
    ? []
    : uniqueArray(input.include, "include", {
      minimum: REQUEST.include_min_items,
      maximum: REQUEST.include_max_items,
      allowed: new Set(REQUEST.includes),
    });
  if (input.webhook_endpoint_id !== undefined) {
    if (typeof input.webhook_endpoint_id !== "string" || !WEBHOOK_ID.test(input.webhook_endpoint_id)) {
      throw new InputError("webhook_endpoint_id is invalid.");
    }
    normalized.webhook_endpoint_id = input.webhook_endpoint_id;
  }
  return normalized;
}

function defaultTrack(tracks) {
  return tracks.find((track) => track.is_default && track.kind === "manual")
    ?? tracks.find((track) => track.is_default && track.kind === "automatic")
    ?? tracks.find((track) => track.kind === "manual")
    ?? tracks.find((track) => track.kind === "automatic")
    ?? null;
}

export function selectTrack(tracks, requested) {
  if (!Array.isArray(tracks)) return null;
  let selected = null;
  let fallbackApplied = false;
  if (requested.track_id !== undefined) {
    selected = tracks.find((track) => track.id === requested.track_id) ?? null;
  } else if (requested.language_preferences?.length) {
    for (const language of requested.language_preferences) {
      for (const kind of requested.caption_kinds) {
        selected = tracks.find((track) => track.language === language && track.kind === kind) ?? null;
        if (selected) break;
      }
      if (selected) break;
    }
    if (!selected && requested.language_fallback === "any") {
      selected = defaultTrack(tracks);
      fallbackApplied = Boolean(selected);
    }
  } else {
    selected = defaultTrack(tracks);
  }
  return selected ? { track: selected, fallbackApplied } : null;
}

export function parsePrefer(header, maximumWaitMs) {
  if (!header) return { waitMs: maximumWaitMs, applied: null };
  const tokens = header.split(",").map((part) => part.trim().toLowerCase());
  if (tokens.includes("respond-async")) return { waitMs: 0, applied: "respond-async" };
  const waitToken = tokens.find((token) => token.startsWith("wait="));
  if (!waitToken) return { waitMs: maximumWaitMs, applied: null };
  const raw = waitToken.slice(5);
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new InputError("Prefer wait must be an integer from 0 to 10.");
  const seconds = Number(raw);
  if (seconds > 10 || seconds * 1_000 > maximumWaitMs) throw new InputError("Prefer wait exceeds the service limit.");
  return { waitMs: seconds * 1_000, applied: `wait=${seconds}` };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
