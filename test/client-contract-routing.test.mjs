import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TranscriptLayerClient } from "../sdk/typescript/src/index.js";

const contract = JSON.parse(await readFile(new URL("../docs/contracts/openapi-v1.json", import.meta.url), "utf8"));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function operations() {
  return Object.entries(contract.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  );
}

function usesBearerKey(operation) {
  return (operation.security ?? contract.security ?? [])
    .some((requirement) => Object.hasOwn(requirement, "bearerKey"));
}

function samplePathValue(name) {
  if (name === "request_id") return "req_contract";
  return `${name.replace(/_id$/u, "")}_contract`;
}

function invocationArguments(path, operation) {
  const pathArguments = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => samplePathValue(match[1]));
  if (pathArguments.length > 0) return pathArguments;
  if (operation.requestBody) return [{}];
  return [];
}

function materializePath(path) {
  return path.replace(/\{([^}]+)\}/gu, (_match, name) => samplePathValue(name));
}

test("TypeScript SDK dispatches every bearer operation in the OpenAPI contract", async () => {
  const entries = operations().filter(({ operation }) => usesBearerKey(operation));
  assert.ok(entries.length > 0, "OpenAPI must expose bearer operations");
  for (const entry of entries) {
    const calls = [];
    const client = new TranscriptLayerClient({ apiKey: "contract_key", fetch: async () => assert.fail("request stub was bypassed") });
    client.request = async (method, path, options) => {
      calls.push({ method, path, options });
      return { data: {} };
    };
    assert.equal(typeof client[entry.operation.operationId], "function", `${entry.operation.operationId} must be callable`);
    await client[entry.operation.operationId](...invocationArguments(entry.path, entry.operation));
    assert.equal(calls.length, 1, `${entry.operation.operationId} must dispatch exactly one request`);
    assert.equal(calls[0].method, entry.method, `${entry.operation.operationId} uses the wrong HTTP method`);
    assert.equal(new URL(calls[0].path, "https://contract.invalid").pathname, materializePath(entry.path));
    assert.equal(calls[0].options?.body !== undefined, entry.operation.requestBody !== undefined);
  }
});
