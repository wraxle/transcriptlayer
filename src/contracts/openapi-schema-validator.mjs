function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function resolveReference(contract, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Only local OpenAPI references are supported: ${reference}`);
  let current = contract;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current?.[key];
  }
  if (!current || typeof current !== "object") throw new Error(`Unresolved OpenAPI reference: ${reference}`);
  return current;
}

function resolveReferenceChain(contract, value, label) {
  let current = value;
  const seen = new Set();
  for (let depth = 0; current?.$ref; depth += 1) {
    if (depth > 100) throw new Error(`OpenAPI ${label} reference recursion exceeded`);
    if (seen.has(current.$ref)) throw new Error(`Circular OpenAPI ${label} reference: ${current.$ref}`);
    seen.add(current.$ref);
    current = resolveReference(contract, current.$ref);
  }
  return current;
}

function normalizedMediaType(value) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("OpenAPI response media type is required");
  return value.split(";", 1)[0].trim().toLowerCase();
}

function validateFormat(format, value) {
  if (format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      && Number.isFinite(Date.parse(value));
  }
  if (format === "uri") {
    try {
      return new URL(value).href.length > 0;
    } catch {
      return false;
    }
  }
  return true;
}

function inspect(contract, schema, value, path, errors, depth) {
  if (!schema || typeof schema !== "object") return;
  if (depth > 100) throw new Error(`OpenAPI schema recursion exceeded at ${path}`);

  if (schema.$ref) inspect(contract, resolveReference(contract, schema.$ref), value, path, errors, depth + 1);

  const matches = (candidate) => {
    const candidateErrors = [];
    inspect(contract, candidate, value, path, candidateErrors, depth + 1);
    return candidateErrors.length === 0;
  };

  if (schema.allOf) {
    for (const candidate of schema.allOf) inspect(contract, candidate, value, path, errors, depth + 1);
  }
  if (schema.anyOf && !schema.anyOf.some(matches)) errors.push(`${path}: must match at least one anyOf branch`);
  if (schema.oneOf) {
    const count = schema.oneOf.filter(matches).length;
    if (count !== 1) errors.push(`${path}: must match exactly one oneOf branch; matched ${count}`);
  }
  if (schema.not && matches(schema.not)) errors.push(`${path}: matches a forbidden schema`);
  if (schema.if) {
    const branch = matches(schema.if) ? schema.then : schema.else;
    if (branch) inspect(contract, branch, value, path, errors, depth + 1);
  }

  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push(`${path}: must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`);
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${expected.join(" or ")}, found ${valueType(value)}`);
      return;
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format !== undefined && !validateFormat(schema.format, value)) errors.push(`${path}: invalid ${schema.format}`);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: less than ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: greater than ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: has more than ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const unique = new Set(value.map((item) => JSON.stringify(item)));
      if (unique.size !== value.length) errors.push(`${path}: items are not unique`);
    }
    if (schema.items) value.forEach((item, index) => inspect(contract, schema.items, item, `${path}[${index}]`, errors, depth + 1));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(value, field)) errors.push(`${path}.${field}: required field is missing`);
    }
    for (const [field, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, field)) inspect(contract, child, value[field], `${path}.${field}`, errors, depth + 1);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const field of Object.keys(value)) {
        if (!allowed.has(field)) errors.push(`${path}.${field}: additional property is not allowed`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const [field, child] of Object.entries(value)) {
        if (!declared.has(field)) inspect(contract, schema.additionalProperties, child, `${path}.${field}`, errors, depth + 1);
      }
    }
  }
}

export function validateOpenApiSchema(contract, schema, value) {
  const errors = [];
  inspect(contract, schema, value, "$", errors, 0);
  return errors;
}

export function assertOpenApiSchema(contract, schema, value, label = "value") {
  const errors = validateOpenApiSchema(contract, schema, value);
  if (errors.length > 0) throw new Error(`${label} violates OpenAPI:\n${errors.join("\n")}`);
}

export function findOpenApiOperation(contract, operationId) {
  if (typeof operationId !== "string" || operationId === "") throw new TypeError("OpenAPI operationId is required");
  const matches = [];
  for (const [path, pathItem] of Object.entries(contract?.paths ?? {})) {
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      const operation = pathItem?.[method];
      if (operation?.operationId === operationId) matches.push({ method, path, operation });
    }
  }
  if (matches.length === 0) throw new Error(`Unknown OpenAPI operationId: ${operationId}`);
  if (matches.length > 1) throw new Error(`Duplicate OpenAPI operationId: ${operationId}`);
  return matches[0];
}

export function validateOpenApiOperationResponse(contract, {
  operationId,
  status,
  mediaType,
  value,
}) {
  const { operation } = findOpenApiOperation(contract, operationId);
  const statusKey = String(status);
  const documented = operation.responses?.[statusKey] ?? operation.responses?.default;
  if (!documented) throw new Error(`OpenAPI operation ${operationId} does not document response status ${statusKey}`);
  const response = resolveReferenceChain(contract, documented, "response");
  const content = response?.content ?? {};
  const contentTypes = Object.keys(content);

  if (contentTypes.length === 0) {
    if (value !== undefined) {
      return [`$: OpenAPI operation ${operationId} response ${statusKey} has no response body`];
    }
    return [];
  }

  const requestedType = normalizedMediaType(mediaType);
  const documentedType = contentTypes.find((candidate) => normalizedMediaType(candidate) === requestedType);
  if (!documentedType) {
    throw new Error(
      `OpenAPI operation ${operationId} response ${statusKey} does not document media type ${requestedType}; expected ${contentTypes.join(", ")}`,
    );
  }
  const media = resolveReferenceChain(contract, content[documentedType], "media type");
  if (!media?.schema) throw new Error(`OpenAPI operation ${operationId} response ${statusKey} media type ${documentedType} has no schema`);
  return validateOpenApiSchema(contract, media.schema, value);
}

export function assertOpenApiOperationResponse(contract, options, label = "response") {
  const errors = validateOpenApiOperationResponse(contract, options);
  if (errors.length > 0) throw new Error(`${label} violates OpenAPI:\n${errors.join("\n")}`);
}
