import assert from "node:assert/strict";
import test from "node:test";

import { SafeFactFactory } from "../src/safety/index.js";
import { extractTypeScriptSource } from "../src/ts-adapter/index.js";
import type { SafeIdentifier, SafePath } from "../src/safety/types.js";

const file = "src/api.ts" as SafePath;
const sourceId = "source-api" as SafeIdentifier;

function runtimeScope(): object {
  return {
    id: "api-main",
    componentId: "api",
    phase: "runtime",
    stage: { kind: "exact", values: ["production"] },
    channel: "environment",
  };
}

test("TypeScript adapter materializes a direct process.env read through Safety", () => {
  const result = extractTypeScriptSource(
    {
      sourceText: "const url = process.env.DATABASE_URL;",
      file,
      language: "ts",
      scope: runtimeScope(),
      exposure: "server",
    },
    new SafeFactFactory(),
  );

  assert.equal(result.backendId, "typescript-compiler-api/v1");
  assert.deepEqual(
    result.references.map((reference) => reference.requested.name),
    ["DATABASE_URL"],
  );
  assert.equal(result.demandEdges.length, 1);
  assert.equal(result.dynamicLookupEdges.length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("extracts aliases, destructuring, constant-folded keys, and finite branches", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        'const env = process.env; const { API_TOKEN: token, DATABASE_URL } = env; const staticKey = "REGION_" + "TOKEN"; env[staticKey]; process.env["BRACKET_KEY"]; process?.env?.OPTIONAL_KEY; const choice = enabled ? "FIRST_KEY" : "SECOND_KEY"; env[choice];',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.deepEqual(
    result.references
      .map((reference) => reference.requested.name)
      .filter((name) => typeof name === "string")
      .map((name) => String(name))
      .sort(),
    ["API_TOKEN", "BRACKET_KEY", "DATABASE_URL", "OPTIONAL_KEY", "REGION_TOKEN"],
  );
  assert.equal(result.demandEdges.length, 5);
  assert.equal(result.dynamicLookupEdges.length, 1);
  assert.deepEqual(result.dynamicLookupEdges[0]?.domain, {
    kind: "finite",
    keys: ["FIRST_KEY", "SECOND_KEY"],
  });
  assert.deepEqual(
    result.dynamicLookupEdges[0]?.likelyKeys.map((key) => key.name),
    ["FIRST_KEY", "SECOND_KEY"],
  );
});

test("keeps a fixed-segment template as a user-controlled pattern", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "function handler(request: unknown) { return process.env[`SERVICE_${request.query.region}`]; }",
      file,
      sourceId,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.references.length, 1);
  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 1);
  const lookup = result.dynamicLookupEdges[0];
  assert.equal(lookup?.origin, "user-controlled");
  assert.equal(lookup?.domain.kind, "pattern");
  if (lookup?.domain.kind === "pattern") {
    assert.equal(lookup.domain.pattern.kind, "prefix");
    assert.equal(lookup.domain.pattern.prefix, "SERVICE_");
    assert.equal(
      lookup.domain.pattern.patternId.startsWith("pattern-source-api-dynamic-l0-c"),
      true,
    );
  }
  assert.deepEqual(lookup?.likelyKeys, []);
});

test("preserves prefix, suffix, and surrounded fixed segments in dynamic templates", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "const prefix = \"SERVICE_\"; const suffix = \"_TOKEN\"; process.env[`${prefix}${request.query.region}`]; process.env[`${request.query.region}${suffix}`]; process.env[`BEFORE_${request.query.region}_AFTER`];",
      file,
      sourceId,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.dynamicLookupEdges.length, 3);
  assert.deepEqual(
    result.dynamicLookupEdges.map((edge) => {
      if (edge.domain.kind !== "pattern") {
        return edge.domain.kind;
      }
      const pattern = edge.domain.pattern;
      return pattern.kind === "surrounded"
        ? [pattern.kind, pattern.prefix, pattern.suffix]
        : pattern.kind === "prefix"
          ? [pattern.kind, pattern.prefix]
          : [pattern.kind, pattern.suffix];
    }),
    [
      ["prefix", "SERVICE_"],
      ["suffix", "_TOKEN"],
      ["surrounded", "BEFORE_", "_AFTER"],
    ],
  );
  assert.equal(
    result.dynamicLookupEdges.every((edge) => edge.origin === "user-controlled"),
    true,
  );
});

test("preserves both fixed segments across concatenated dynamic keys", () => {
  const result = extractTypeScriptSource(
    {
      sourceText: 'process.env["BEFORE_" + request.query.key + "_AFTER"];',
      file,
      sourceId,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  const domain = result.dynamicLookupEdges[0]?.domain;
  assert.equal(domain?.kind, "pattern");
  if (domain?.kind === "pattern") {
    assert.deepEqual(domain.pattern.kind, "surrounded");
    if (domain.pattern.kind === "surrounded") {
      assert.equal(domain.pattern.prefix, "BEFORE_");
      assert.equal(domain.pattern.suffix, "_AFTER");
    }
  }
  assert.equal(result.dynamicLookupEdges[0]?.origin, "user-controlled");
});

test("flags user-controlled keys without inventing candidate names", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "export function handler(key: string, request: unknown) { process.env[key]; process.env[request.query.key]; process.env[process.argv[2]]; }",
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 3);
  for (const lookup of result.dynamicLookupEdges) {
    assert.equal(lookup.origin, "user-controlled");
    assert.deepEqual(lookup.domain, { kind: "unbounded", reason: "user-controlled" });
    assert.deepEqual(lookup.likelyKeys, []);
  }
});

test("marks parameters of a locally declared then exported handler as user-controlled", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "function handler(key: string) { return process.env[key]; } export { handler };",
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 1);
  assert.equal(result.dynamicLookupEdges[0]?.origin, "user-controlled");
  assert.deepEqual(result.dynamicLookupEdges[0]?.domain, {
    kind: "unbounded",
    reason: "user-controlled",
  });
  assert.deepEqual(result.dynamicLookupEdges[0]?.likelyKeys, []);
});

test("marks environment enumeration and forwarding as scoped unbounded uncertainty", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "const keys = Object.keys(process.env); for (const key in process.env) { consume(key); } const copy = { ...process.env };",
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 3);
  for (const lookup of result.dynamicLookupEdges) {
    assert.deepEqual(lookup.domain, { kind: "unbounded", reason: "opaque" });
    assert.deepEqual(lookup.likelyKeys, []);
  }
});

test("marks broad environment-object forwarding as unbounded uncertainty", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        "function forward() { return process.env; } send(process.env); let replacement = process.env; target = process.env; const options = { env: process.env };",
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 5);
  for (const lookup of result.dynamicLookupEdges) {
    assert.deepEqual(lookup.domain, { kind: "unbounded", reason: "opaque" });
  }
});

test("preserves no-value-leak behavior for unsafe static literals", () => {
  const sentinel = "test-only-invalid-env-key";
  const result = extractTypeScriptSource(
    {
      sourceText: 'process.env["' + sentinel + '"];',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 1);
  assert.equal(result.dynamicLookupEdges[0]?.domain.kind, "unbounded");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("keeps a user-selected literal map finite without claiming an exact read", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        'const map = { us: "SERVICE_US", eu: "SERVICE_EU" }; process.env[map[request.query.region]];',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 1);
  assert.equal(result.dynamicLookupEdges[0]?.origin, "user-controlled");
  assert.deepEqual(result.dynamicLookupEdges[0]?.domain, {
    kind: "finite",
    keys: ["SERVICE_US", "SERVICE_EU"],
  });
  assert.deepEqual(
    result.dynamicLookupEdges[0]?.likelyKeys.map((key) => key.name),
    ["SERVICE_US", "SERVICE_EU"],
  );
});

test("supports import.meta, Bun, and Deno environment accessors", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        'const one = import.meta.env?.PUBLIC_URL; const two = Bun.env["BUN_TOKEN"]; const three = Deno.env.get("DENO_TOKEN");',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.deepEqual(
    result.references
      .map((reference) => reference.requested.name)
      .filter((name) => typeof name === "string")
      .map((name) => String(name))
      .sort(),
    ["BUN_TOKEN", "DENO_TOKEN", "PUBLIC_URL"],
  );
  assert.equal(result.demandEdges.length, 3);
  assert.equal(result.dynamicLookupEdges.length, 0);
});

test("does not treat a shadowed process binding as the Node process global", () => {
  const result = extractTypeScriptSource(
    {
      sourceText:
        'const process = { env: { NOT_A_REAL_ENVIRONMENT: "value" } }; process.env.NOT_A_REAL_ENVIRONMENT;',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.equal(result.references.length, 0);
  assert.equal(result.demandEdges.length, 0);
  assert.equal(result.dynamicLookupEdges.length, 0);
});

test("turns over-budget finite domains and zero-segment templates into unbounded facts", () => {
  const overBudget = extractTypeScriptSource(
    {
      sourceText:
        'const key = first ? "ONE_KEY" : second ? "TWO_KEY" : "THREE_KEY"; process.env[key];',
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory({ maxFiniteKeyDomain: 2 }),
    { maxFiniteKeyDomain: 2 },
  );
  const zeroSegment = extractTypeScriptSource(
    {
      sourceText:
        "process.env[`${request.query.key}`];",
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.deepEqual(overBudget.dynamicLookupEdges[0]?.domain, {
    kind: "unbounded",
    reason: "over-budget",
  });
  assert.equal(overBudget.dynamicLookupEdges[0]?.origin, "lexical");
  assert.deepEqual(zeroSegment.dynamicLookupEdges[0]?.domain, {
    kind: "unbounded",
    reason: "user-controlled",
  });
  assert.equal(zeroSegment.dynamicLookupEdges[0]?.origin, "user-controlled");
});

test("reports parse failure without retaining parser text", () => {
  const malformed = "const x = process.env.;";
  const result = extractTypeScriptSource(
    {
      sourceText: malformed,
      file,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.deepEqual(result.diagnostics, [{ code: "PARSE_FAILURE" }]);
  assert.equal(JSON.stringify(result).includes(malformed), false);
});

test("safe source IDs namespace identical coordinates across independently scanned files", () => {
  const first = extractTypeScriptSource(
    {
      sourceText: "process.env.DATABASE_URL;",
      file: "src/one.ts" as SafePath,
      sourceId: "source-one" as SafeIdentifier,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );
  const second = extractTypeScriptSource(
    {
      sourceText: "process.env.DATABASE_URL;",
      file: "src/two.ts" as SafePath,
      sourceId: "source-two" as SafeIdentifier,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  assert.notEqual(first.references[0]?.id, second.references[0]?.id);
  assert.notEqual(first.demandEdges[0]?.id, second.demandEdges[0]?.id);
  assert.equal(first.references[0]?.id.startsWith("source-one-reference-l0-c0"), true);
  assert.equal(second.references[0]?.id.startsWith("source-two-reference-l0-c0"), true);
});

test("direct-use fallback IDs remain distinct without encoding source paths", () => {
  const first = extractTypeScriptSource(
    {
      sourceText: "process.env.DATABASE_URL;",
      file: "src/private-one.ts" as SafePath,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );
  const second = extractTypeScriptSource(
    {
      sourceText: "process.env.DATABASE_URL;",
      file: "src/private-two.ts" as SafePath,
      language: "ts",
      scope: runtimeScope(),
    },
    new SafeFactFactory(),
  );

  const firstId = String(first.references[0]?.id);
  const secondId = String(second.references[0]?.id);
  assert.notEqual(firstId, secondId);
  assert.equal(firstId.includes("private-one"), false);
  assert.equal(secondId.includes("private-two"), false);
});
