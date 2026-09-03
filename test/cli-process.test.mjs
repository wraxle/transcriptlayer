import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/transcriptlayer.mjs", import.meta.url));

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  delete env.TRANSCRIPTLAYER_API_KEY;
  delete env.TRANSCRIPTLAYER_API_URL;
  return { ...env, ...overrides };
}

function runCli(args, { env = cleanEnvironment(), onSpawn = null } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: REPOSITORY,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn?.(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function localServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("CLI executable help, version, and completions are non-interactive and color-free", async () => {
  const env = cleanEnvironment({ NO_COLOR: "1" });
  const help = await runCli(["--no-color", "--help"], { env });
  assert.deepEqual({ code: help.code, signal: help.signal, stderr: help.stderr }, { code: 0, signal: null, stderr: "" });
  assert.match(help.stdout, /^Usage: transcriptlayer/u);
  assert.doesNotMatch(help.stdout, /\u001b\[/u);

  const version = await runCli(["--version"], { env });
  assert.deepEqual({ code: version.code, signal: version.signal, stderr: version.stderr }, { code: 0, signal: null, stderr: "" });
  assert.equal(version.stdout, "transcriptlayer 0.1.0-beta.1\n");

  for (const shell of ["bash", "zsh", "fish"]) {
    const completion = await runCli(["completion", shell], { env });
    assert.deepEqual({ code: completion.code, signal: completion.signal, stderr: completion.stderr }, { code: 0, signal: null, stderr: "" });
    assert.match(completion.stdout, /transcriptlayer/u);
    assert.doesNotMatch(completion.stdout, /\u001b\[/u);
  }
});

test("CLI executable keeps compact JSON on stdout and maps HTTP failures to stable exits", async () => {
  const server = await localServer((request, response) => {
    const match = request.url?.match(/^\/(\d+)\/v1\/account$/u);
    const status = Number(match?.[1] ?? 500);
    response.writeHead(status, { "content-type": status === 200 ? "application/json" : "application/problem+json" });
    response.end(JSON.stringify(status === 200
      ? { id: "acct_process", object: "account", status: "active" }
      : { code: `failure_${status}`, detail: "failed", status, retryable: status >= 500 }));
  });
  try {
    for (const [status, expectedExit] of [[200, 0], [401, 3], [404, 4], [409, 5], [429, 6], [503, 7]]) {
      const result = await runCli(["--json", "auth", "status"], {
        env: cleanEnvironment({
          TRANSCRIPTLAYER_API_KEY: "tl_test_process_secret",
          TRANSCRIPTLAYER_API_URL: `${server.origin}/${status}`,
        }),
      });
      assert.equal(result.code, expectedExit, `HTTP ${status}`);
      assert.equal(result.signal, null);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /tl_test_process_secret/u);
      const output = status === 200 ? result.stdout : result.stderr;
      assert.equal(output.split("\n").filter(Boolean).length, 1, `HTTP ${status}`);
      assert.doesNotThrow(() => JSON.parse(output));
      assert.equal(status === 200 ? result.stderr : result.stdout, "");
    }
  } finally {
    await server.close();
  }

  const usage = await runCli(["auth", "status"]);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /TRANSCRIPTLAYER_API_KEY/u);
});

test("CLI executable distinguishes request timeout from SIGINT", async () => {
  let signalRequest;
  const requestReceived = new Promise((resolve) => { signalRequest = resolve; });
  const server = await localServer((request) => {
    if (request.url?.startsWith("/interrupt/")) signalRequest();
  });
  try {
    const timeout = await runCli(["--json", "--timeout", "100", "auth", "status"], {
      env: cleanEnvironment({
        TRANSCRIPTLAYER_API_KEY: "tl_test_process_secret",
        TRANSCRIPTLAYER_API_URL: `${server.origin}/timeout`,
      }),
    });
    assert.equal(timeout.code, 7);
    assert.equal(timeout.signal, null);
    assert.equal(timeout.stdout, "");
    assert.deepEqual(JSON.parse(timeout.stderr), { code: "request_timeout", retryable: true });

    let child;
    const interrupted = runCli(["--timeout", "60000", "auth", "status"], {
      env: cleanEnvironment({
        TRANSCRIPTLAYER_API_KEY: "tl_test_process_secret",
        TRANSCRIPTLAYER_API_URL: `${server.origin}/interrupt`,
      }),
      onSpawn(value) { child = value; },
    });
    await requestReceived;
    assert.equal(child.kill("SIGINT"), true);
    const result = await interrupted;
    assert.deepEqual(result, { code: 130, signal: null, stdout: "", stderr: "" });
  } finally {
    await server.close();
  }
});
