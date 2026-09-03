#!/usr/bin/env node

import { run } from "../src/cli.mjs";

const interruption = new AbortController();
process.once("SIGINT", () => interruption.abort());
process.exitCode = await run(process.argv.slice(2), { signal: interruption.signal });
