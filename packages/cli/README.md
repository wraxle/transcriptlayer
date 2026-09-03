# TranscriptLayer CLI

This package is not published. Version `0.1.0-beta.1` and the `@wraxle/transcriptlayer-cli` identity are approved for the first release; npm ownership and trusted publishing still require live setup. Its source is licensed under Apache-2.0, and the release artifact includes the full license text.

The CLI reads the API key from `TRANSCRIPTLAYER_API_KEY`. It does not accept a key on the command line.

```sh
export TRANSCRIPTLAYER_API_KEY='your-api-key'
transcriptlayer auth status
transcriptlayer transcripts create 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' \
  --language en \
  --idempotency-key first-request
```

Run `transcriptlayer --help` for the complete command list.

## Install, upgrade, and rollback

These commands become valid after the package is published. Install or restore the first beta by exact version:

```sh
npm install --global @wraxle/transcriptlayer-cli@0.1.0-beta.1
```

Upgrade only when you choose to take the current release:

```sh
npm install --global @wraxle/transcriptlayer-cli@latest
```

To roll back after a later upgrade, reinstall the last known-good exact version. If no earlier version exists, uninstall the CLI instead:

```sh
npm install --global @wraxle/transcriptlayer-cli@0.1.0-beta.1
npm uninstall --global @wraxle/transcriptlayer-cli
```

The CLI has no self-update command and never changes its installed version while running.

## Automation

`--json` writes one compact JSON value to stdout on success and to stderr on failure. Progress and verbose diagnostics use stderr. `--quiet` suppresses progress diagnostics. `--quiet` and `--verbose` cannot be combined. API keys are read only from `TRANSCRIPTLAYER_API_KEY` and are omitted from verbose output.

| Exit | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | CLI internal failure |
| 2 | Invalid command or input |
| 3 | Authentication or authorization failure |
| 4 | Resource not found |
| 5 | Conflict or permanent request failure |
| 6 | Funding, size, wait deadline, or rate limit |
| 7 | Service, network timeout, or retryable request failure |
| 130 | Interrupted with `SIGINT` |

The CLI prints completion scripts without authentication or network access:

```sh
source <(transcriptlayer completion bash)
source <(transcriptlayer completion zsh)
transcriptlayer completion fish | source
```
