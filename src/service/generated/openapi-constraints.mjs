// Generated from docs/contracts/openapi-v1.json. Run npm run generate:sdks.
export const OPENAPI_RUNTIME_CONSTRAINTS = Object.freeze({
  "transcript_request": {
    "allowed_fields": [
      "source",
      "track_id",
      "language_preferences",
      "caption_kinds",
      "language_fallback",
      "content_format",
      "max_age_seconds",
      "allow_stale_on_error",
      "include",
      "webhook_endpoint_id"
    ],
    "source_allowed_fields": [
      "url",
      "platform",
      "id"
    ],
    "source_url_max_length": 2048,
    "source_platform_pattern": "^[a-z][a-z0-9_]{0,31}$",
    "source_id_min_length": 1,
    "source_id_max_length": 128,
    "source_id_pattern": "^[A-Za-z0-9._~-]+$",
    "track_id_min_length": 1,
    "track_id_max_length": 300,
    "language_preferences_min_items": 1,
    "language_preferences_max_items": 10,
    "language_preference_min_length": 1,
    "language_preference_max_length": 35,
    "caption_kinds_min_items": 1,
    "caption_kinds_max_items": 3,
    "caption_kinds": [
      "manual",
      "automatic",
      "unknown"
    ],
    "default_caption_kinds": [
      "manual",
      "automatic",
      "unknown"
    ],
    "language_fallbacks": [
      "none",
      "any"
    ],
    "default_language_fallback": "none",
    "content_formats": [
      "segments",
      "text",
      "both"
    ],
    "default_content_format": "segments",
    "max_age_seconds_minimum": 0,
    "max_age_seconds_maximum": 2592000,
    "default_allow_stale_on_error": false,
    "include_min_items": 0,
    "include_max_items": 2,
    "includes": [
      "metadata",
      "available_tracks"
    ],
    "webhook_endpoint_id_pattern": "^whe_[A-Za-z0-9]+$"
  },
  "batch_request": {
    "allowed_fields": [
      "items",
      "webhook_endpoint_id"
    ],
    "min_items": 1,
    "max_items": 1000,
    "reference_min_length": 1,
    "reference_max_length": 100,
    "webhook_endpoint_id_pattern": "^whe_[A-Za-z0-9]+$"
  }
});
