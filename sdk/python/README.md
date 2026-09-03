# TranscriptLayer Python SDK

This package is not published. Version `0.1.0b1` and the `transcriptlayer` PyPI identity are approved for the first release; PyPI ownership and trusted publishing still require live setup. Its source is licensed under Apache-2.0, and the release wheel includes the full license text.

```python
import os

from transcriptlayer import TranscriptLayerClient

client = TranscriptLayerClient(api_key=os.environ["TRANSCRIPTLAYER_API_KEY"])
response = client.create_transcript(
    {
        "source": {"platform": "youtube", "id": "dQw4w9WgXcQ"},
        "language_preferences": ["en"],
    },
    wait_seconds=10,
)
terminal = client.wait_for_transcript(
    response.data["id"],
    timeout_seconds=300,
    poll_interval_seconds=2,
)

for page in client.iterate_transcript_pages(limit=100):
    print(page.request_id, page.data["items"])
```

`wait_for_transcript` and `wait_for_batch` poll with ETags, cap each request by the remaining overall deadline, and return failed or cancelled jobs for caller inspection. They do not retry HTTP or transport failures. Page iterators preserve each response's diagnostics, reject cursor loops, and fail after 100 pages by default instead of walking forever. Set `max_pages` from 1 through 10,000 for a different bound. The client also exposes response diagnostics, including request IDs, credit charges, rate-limit fields, Location, ETags, and retry metadata.

`retry_failed_batch` requires a new caller-owned `idempotency_key`. Save one `now` value with that key and reuse both after an ambiguous transport failure. This keeps the selected items and request body stable while the API replays the original atomic admission.

## Install, upgrade, and rollback

These commands become valid after publication. Install or restore the first beta by exact version:

```sh
python -m pip install transcriptlayer==0.1.0b1
```

Take a later release deliberately by naming its exact version. Pre-releases are never selected implicitly by this command:

```sh
python -m pip install --upgrade transcriptlayer==0.1.0b1
```

Roll back by reinstalling the last known-good exact version:

```sh
python -m pip install --force-reinstall transcriptlayer==0.1.0b1
```
