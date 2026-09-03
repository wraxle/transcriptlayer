# TranscriptLayer TypeScript SDK

This package is not published. Version `0.1.0-beta.1` and the `@wraxle/transcriptlayer` identity are approved for the first release; npm ownership and trusted publishing still require live setup. Its source is licensed under Apache-2.0, and the release artifact includes the full license text.

```js
import { TranscriptLayerClient } from "@wraxle/transcriptlayer";

const client = new TranscriptLayerClient({ apiKey: process.env.TRANSCRIPTLAYER_API_KEY });
const response = await client.createTranscript(
  {
    source: { platform: "youtube", id: "dQw4w9WgXcQ" },
    language_preferences: ["en"],
  },
  { waitSeconds: 10 },
);
const terminal = await client.waitForTranscript(response.data.id, {
  timeoutMs: 300_000,
  pollIntervalMs: 2_000,
});

for await (const page of client.iterateTranscriptPages({ limit: 100 })) {
  console.log(page.requestId, page.data.items);
}
```

`waitForTranscript` and `waitForBatch` poll with ETags, enforce an overall deadline, accept an `AbortSignal`, and return failed or cancelled jobs for caller inspection. They do not retry HTTP or transport failures. Page iterators preserve each response's diagnostics, reject cursor loops, and fail after 100 pages by default instead of walking forever. Set `maxPages` from 1 through 10,000 for a different bound. The client also exposes response diagnostics, including request IDs, credit charges, rate-limit fields, Location, ETags, and retry metadata.

`retryFailedBatch` requires a new caller-owned `idempotencyKey`. Save one `now` value with that key and reuse both after an ambiguous transport failure. This keeps the selected items and request body stable while the API replays the original atomic admission.

## Install, upgrade, and rollback

These commands become valid after publication. Pin the SDK in the application's lockfile:

```sh
npm install @wraxle/transcriptlayer@0.1.0-beta.1
```

Take the current release deliberately, then run the application's tests before committing its lockfile:

```sh
npm install @wraxle/transcriptlayer@latest
```

Roll back by reinstalling the last known-good exact version and committing the restored manifest and lockfile:

```sh
npm install @wraxle/transcriptlayer@0.1.0-beta.1
```
