const PLATFORM = /^[a-z][a-z0-9_]{0,31}$/;
// Canonical IDs are opaque to consumers but remain safe in public route segments,
// Durable Object names, and storage prefixes. Adapters may hash a provider key
// when its native identity does not fit this alphabet.
const SOURCE_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const AUTHORITY_NAME = /^[^\u0000\n\r]{1,288}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export class SourceReferenceError extends Error {
  constructor(message, code = "invalid_source", status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requirePlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SourceReferenceError(message);
  }
}

function parseHttpsUrl(value, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new SourceReferenceError("The source URL is invalid or unsupported.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SourceReferenceError("The source URL is invalid or unsupported.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new SourceReferenceError("The source URL is invalid or unsupported.");
  }
  return url;
}

function youtubeIdFromUrl(url) {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (url.pathname === "/watch") {
    id = url.searchParams.get("v");
  } else {
    id = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

export const youtubeSourceAdapter = Object.freeze({
  platform: "youtube",
  sourceMarket: "US",
  extractionPolicy: "selected-track-v1",
  matchesUrl(url) {
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  },
  normalizeId(value) {
    if (typeof value !== "string" || !YOUTUBE_ID.test(value)) {
      throw new SourceReferenceError("The YouTube source ID must contain exactly 11 letters, numbers, underscores, or hyphens.");
    }
    return value;
  },
  parseUrl(url) {
    const id = youtubeIdFromUrl(url);
    if (!id) throw new SourceReferenceError("The source URL is not a supported YouTube video URL.");
    return id;
  },
  canonicalUrl(id) {
    return `https://www.youtube.com/watch?v=${id}`;
  },
  authorityName(source) {
    return `youtube:${source.id}:US:selected-track-v1`;
  },
  parseAuthorityName(value) {
    const match = typeof value === "string"
      ? value.match(/^youtube:([A-Za-z0-9_-]{11}):US:selected-track-v1$/)
      : null;
    return match ? { platform: "youtube", id: match[1] } : null;
  },
  sourceStoragePrefix(source) {
    return `source/youtube/${source.id}`;
  },
  thumbnailStoragePrefix(source) {
    return `thumbnail/youtube/${source.id}`;
  },
  extractionPayload(source) {
    return { platform: "youtube", video_id: source.id, source_market: "US" };
  },
  publicMetadata(metadata) {
    return {
      title: metadata?.title,
      creator_id: metadata?.channel_id,
      creator_name: metadata?.channel_name,
      duration_ms: metadata?.duration_ms,
    };
  },
  thumbnailUrls(source) {
    return [
      `https://i.ytimg.com/vi/${source.id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${source.id}/hqdefault.jpg`,
    ];
  },
});

function validateAdapter(adapter) {
  requirePlainObject(adapter, "A source Adapter must be an object.");
  if (!PLATFORM.test(adapter.platform ?? "")) throw new TypeError("A source Adapter has an invalid platform name.");
  if (!/^[A-Z]{2}$/.test(adapter.sourceMarket ?? "")) throw new TypeError(`Source Adapter ${adapter.platform} has an invalid source market.`);
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(adapter.extractionPolicy ?? "")) {
    throw new TypeError(`Source Adapter ${adapter.platform} has an invalid extraction policy.`);
  }
  for (const method of [
    "matchesUrl",
    "normalizeId",
    "parseUrl",
    "canonicalUrl",
    "authorityName",
    "parseAuthorityName",
    "sourceStoragePrefix",
    "thumbnailStoragePrefix",
    "extractionPayload",
    "publicMetadata",
    "thumbnailUrls",
  ]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`Source Adapter ${adapter.platform} lacks ${method}().`);
  }
  return adapter;
}

export function createSourceRegistry(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) throw new TypeError("At least one source Adapter is required.");
  const byPlatform = new Map();
  for (const candidate of adapters) {
    const adapter = validateAdapter(candidate);
    if (byPlatform.has(adapter.platform)) throw new TypeError(`Duplicate source Adapter: ${adapter.platform}.`);
    byPlatform.set(adapter.platform, adapter);
  }

  function adapterFor(platform) {
    if (typeof platform !== "string" || !PLATFORM.test(platform)) {
      throw new SourceReferenceError("The source platform is invalid.");
    }
    const adapter = byPlatform.get(platform);
    if (!adapter) throw new SourceReferenceError(`The source platform '${platform}' is not supported.`);
    return adapter;
  }

  function canonicalize(platform, id) {
    const adapter = adapterFor(platform);
    const canonicalId = adapter.normalizeId(id);
    if (!SOURCE_ID.test(canonicalId)) throw new SourceReferenceError("The canonical source ID is invalid.");
    return Object.freeze({
      platform: adapter.platform,
      id: canonicalId,
      url: adapter.canonicalUrl(canonicalId),
    });
  }

  function normalize(reference, { urlMaxLength = 2048 } = {}) {
    requirePlainObject(reference, "source must be a JSON object.");
    const unknown = Object.keys(reference).filter((field) => !["url", "platform", "id"].includes(field));
    if (unknown.length) throw new SourceReferenceError(`Unknown source field: ${unknown[0]}.`);

    const hasUrl = Object.hasOwn(reference, "url");
    const hasIdentity = Object.hasOwn(reference, "platform") || Object.hasOwn(reference, "id");
    if (hasUrl === hasIdentity) throw new SourceReferenceError("Supply source.url or source.platform with source.id, but not both.");

    if (!hasUrl) {
      if (!Object.hasOwn(reference, "platform") || !Object.hasOwn(reference, "id")) {
        throw new SourceReferenceError("source.platform and source.id must be supplied together.");
      }
      return canonicalize(reference.platform, reference.id);
    }

    const url = parseHttpsUrl(reference.url, urlMaxLength);
    const adapter = [...byPlatform.values()].find((candidate) => candidate.matchesUrl(url));
    if (!adapter) throw new SourceReferenceError("The source URL is not supported.");
    return canonicalize(adapter.platform, adapter.parseUrl(url));
  }

  function parseAuthorityName(value) {
    if (typeof value !== "string" || !AUTHORITY_NAME.test(value)) {
      throw new SourceReferenceError("The source authority name is invalid.");
    }
    for (const adapter of byPlatform.values()) {
      const parsed = adapter.parseAuthorityName(value);
      if (!parsed) continue;
      const canonical = canonicalize(parsed.platform, parsed.id);
      if (adapter.authorityName(canonical) === value) return canonical;
    }
    throw new SourceReferenceError("The source authority name is invalid.");
  }

  return Object.freeze({
    platforms: Object.freeze([...byPlatform.keys()]),
    adapterFor,
    canonicalize,
    normalize,
    parseAuthorityName,
  });
}

export const sourceRegistry = createSourceRegistry([youtubeSourceAdapter]);

export function sourceIdIsValid(platform, id) {
  try {
    sourceRegistry.canonicalize(platform, id);
    return true;
  } catch (error) {
    if (error instanceof SourceReferenceError) return false;
    throw error;
  }
}

export function sourceFromRequested(requested) {
  if (requested?.source) return sourceRegistry.canonicalize(requested.source.platform, requested.source.id);
  if (requested?.platform === "youtube" && typeof requested.video_id === "string") {
    return sourceRegistry.canonicalize("youtube", requested.video_id);
  }
  throw new SourceReferenceError("The normalized request has no canonical source identity.");
}

export function sourceAuthorityName(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  const name = sourceRegistry.adapterFor(canonical.platform).authorityName(canonical);
  if (typeof name !== "string" || !AUTHORITY_NAME.test(name)) {
    throw new SourceReferenceError("The source authority name is invalid.");
  }
  return name;
}

export function sourceAuthorityNameIsValid(value) {
  try {
    sourceRegistry.parseAuthorityName(value);
    return true;
  } catch (error) {
    if (error instanceof SourceReferenceError) return false;
    throw error;
  }
}

export function sourceGenerationName(source, generation) {
  if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000_000) {
    throw new TypeError("Source generation must be an integer from 1 through 1,000,000,000.");
  }
  return `${sourceAuthorityName(source)}:${generation}`;
}

export function parseSourceGenerationName(value) {
  if (typeof value !== "string") throw new SourceReferenceError("The source generation name is invalid.");
  const separator = value.lastIndexOf(":");
  const generationText = separator >= 0 ? value.slice(separator + 1) : "";
  if (!/^[1-9][0-9]{0,9}$/.test(generationText)) {
    throw new SourceReferenceError("The source generation name is invalid.");
  }
  const source = sourceRegistry.parseAuthorityName(value.slice(0, separator));
  const generation = Number.parseInt(generationText, 10);
  if (generation > 1_000_000_000) throw new SourceReferenceError("The source generation name is invalid.");
  return { source, generation };
}

export function sourceGenerationNameIsValid(value) {
  try {
    parseSourceGenerationName(value);
    return true;
  } catch (error) {
    if (error instanceof SourceReferenceError) return false;
    throw error;
  }
}

export function sourceStoragePrefix(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).sourceStoragePrefix(canonical);
}

export function sourceThumbnailStoragePrefix(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).thumbnailStoragePrefix(canonical);
}

export function sourceExtractionPayload(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).extractionPayload(canonical);
}

export function sourceExtractionPolicy(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).extractionPolicy;
}

export function sourceMarket(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).sourceMarket;
}

export function sourcePublicMetadata(source, metadata) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).publicMetadata(metadata);
}

export function sourceThumbnailUrls(source) {
  const canonical = sourceRegistry.canonicalize(source?.platform, source?.id);
  return sourceRegistry.adapterFor(canonical.platform).thumbnailUrls(canonical);
}
