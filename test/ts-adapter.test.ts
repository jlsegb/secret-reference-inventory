import assert from "node:assert/strict";
import test from "node:test";

import { SafeFactFactory } from "../src/safety/index.js";
import { extractTypeScriptSource } from "../src/ts-adapter/index.js";
import type { SafeIdentifier, SafePath } from "../src/safety/types.js";

const file = "src/api.ts" as SafePath;
const sourceId = "source-api" as SafeIdentifier;

/**
 * Builds the common runtime environment scope fixture used by adapter extraction cases.
 *
 * Inputs: No parameters.
 * Outputs: A new plain scope record for the production API runtime environment channel.
 * Does not handle: Safe-factory materialization, scope matching, or fixture immutability.
 * Side effects: Allocates nested plain objects/arrays for each caller.
 */
function runtimeScope(): object {
  return {
    id: "api-main",
    componentId: "api",
    phase: "runtime",
    stage: { kind: "exact", values: ["production"] },
    channel: "environment",
  };
}

test("TypeScript adapter materializes a direct process.env read through Safety", /**
 * Verifies that one direct process environment property read becomes a safe reference and direct demand edge through the default TypeScript backend.
 *
 * Inputs: No parameters; supplies an in-memory TypeScript source snippet and local safe factory.
 * Outputs: No value; assertions establish backend identity, one key, direct demand, no dynamic edge, and no diagnostic.
 * Does not handle: Filesystem loading, import resolution, or non-TypeScript parser backends.
 * Side effects: Parses/extracts the snippet, constructs facts, maps references, and performs assertions.
 */
() => {
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
    result.references.map(/**
 * Projects the requested logical-name field from one extracted reference for the expected-key assertion.
 *
 * Inputs: One normalized secret reference.
 * Outputs: Its `requested.name` identifier or opaque sentinel representation.
 * Does not handle: Filtering opaque names or checking the source location.
 * Side effects: Reads the nested requested-name field during `.map`.
 */
(reference) => reference.requested.name),
    ["DATABASE_URL"],
  );
  assert.equal(result.demandEdges.length, 1);
  assert.equal(result.dynamicLookupEdges.length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("extracts aliases, destructuring, constant-folded keys, and finite branches", /**
 * Verifies alias, destructuring, bracket, optional-chain, concatenation, and conditional extraction with exact reads separated from finite dynamic evidence.
 *
 * Inputs: No parameters; supplies one dense in-memory source fixture and default factory.
 * Outputs: No value; assertions establish five exact demand keys and one finite dynamic branch domain.
 * Does not handle: Runtime branch evaluation, imports, or arbitrary alias flow.
 * Side effects: Parses/extracts source, projects/filter/sorts results, and performs assertions.
 */
() => {
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
      .map(/**
 * Projects each extracted reference to its requested logical name before excluding opaque values.
 *
 * Inputs: One normalized reference.
 * Outputs: Its requested-name field.
 * Does not handle: String narrowing or ordering.
 * Side effects: Reads the requested name during `.map`.
 */
(reference) => reference.requested.name)
      .filter(/**
 * Keeps only concrete string names so opaque identifier values cannot enter the sorted expected-key list.
 *
 * Inputs: One logical-name representation.
 * Outputs: True exactly for string values.
 * Does not handle: Validating environment-key grammar.
 * Side effects: Performs a type test during `.filter`.
 */
(name) => typeof name === "string")
      .map(/**
 * Converts each known-string name into a comparison string after the preceding type filter.
 *
 * Inputs: One name narrowed to a string by the preceding filter.
 * Outputs: `String(name)` for the sorted expected-key comparison.
 * Does not handle: Redaction or further narrowing.
 * Side effects: Performs string conversion during `.map`.
 */
(name) => String(name))
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
    result.dynamicLookupEdges[0]?.likelyKeys.map(/**
 * Projects each finite dynamic-edge likely key to its logical-name field.
 *
 * Inputs: One normalized likely logical key.
 * Outputs: That key's name representation.
 * Does not handle: Validating its namespace or filtering opaque values.
 * Side effects: Reads `key.name` during `.map`.
 */
(key) => key.name),
    ["FIRST_KEY", "SECOND_KEY"],
  );
});

test("keeps a fixed-segment template as a user-controlled pattern", /**
 * Verifies that a request-derived template preserves its fixed prefix as user-controlled pattern evidence rather than inventing exact keys.
 *
 * Inputs: No parameters; uses a non-exported handler source snippet with request-query interpolation and an explicit safe source ID. The request-property naming convention, rather than exported-parameter classification, makes this expression user-controlled.
 * Outputs: No value; assertions establish one dynamic user-controlled prefix pattern with no likely keys or direct demand.
 * Does not handle: HTTP request parsing, runtime region values, or non-prefix template shapes.
 * Side effects: Parses/extracts source, builds facts, and performs assertions.
 */
() => {
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

test("preserves prefix, suffix, and surrounded fixed segments in dynamic templates", /**
 * Verifies that request-derived templates retain fixed prefix, suffix, and both surrounding segments as distinct dynamic pattern shapes.
 *
 * Inputs: No parameters; supplies three in-memory template forms with constant aliases and request interpolation.
 * Outputs: No value; assertions establish the three pattern projections and user-controlled origin for all edges.
 * Does not handle: Pattern expansion, source locations, or runtime values.
 * Side effects: Parses/extracts source, maps/evaluates dynamic edges, and performs assertions.
 */
() => {
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
    result.dynamicLookupEdges.map(/**
 * Converts one dynamic edge into a stable tuple describing its pattern kind and represented fixed segments.
 *
 * Inputs: One normalized dynamic lookup edge.
 * Outputs: Its nonpattern domain kind or a pattern tuple containing kind/prefix/suffix as available.
 * Does not handle: Checking origin, likely keys, or pattern IDs.
 * Side effects: Reads nested domain/pattern fields and allocates a small tuple for pattern edges.
 */
(edge) => {
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
    result.dynamicLookupEdges.every(/**
 * Checks that each produced dynamic edge retained the user-controlled origin expected for request-derived interpolation.
 *
 * Inputs: One dynamic lookup edge.
 * Outputs: Whether its origin literal is `user-controlled`.
 * Does not handle: Checking domain shape or source evidence.
 * Side effects: Reads `edge.origin` during `.every`.
 */
(edge) => edge.origin === "user-controlled"),
    true,
  );
});

test("preserves both fixed segments across concatenated dynamic keys", /**
 * Verifies that string concatenation around a request-derived key becomes one user-controlled surrounded pattern.
 *
 * Inputs: No parameters; supplies one concatenated environment-index source fixture.
 * Outputs: No value; assertions establish surrounded shape, both fixed segments, and user-controlled origin.
 * Does not handle: Multiple concatenation branches or exact-key promotion.
 * Side effects: Parses/extracts source and performs nested domain assertions.
 */
() => {
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

test("flags user-controlled keys without inventing candidate names", /**
 * Verifies that exported parameters, request properties, and CLI arguments are all unbounded user-controlled evidence with no invented candidates.
 *
 * Inputs: No parameters; supplies an exported handler source using parameter/request/argv indices.
 * Outputs: No value; assertions establish three unbounded user-controlled edges and zero direct demand.
 * Does not handle: Other user-input APIs or pattern preservation.
 * Side effects: Parses/extracts source, iterates edges, and performs assertions.
 */
() => {
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

test("marks parameters of a locally declared then exported handler as user-controlled", /**
 * Verifies that a local handler named in a later export declaration still makes its parameter a user-controlled environment index.
 *
 * Inputs: No parameters; supplies a local function followed by named export syntax.
 * Outputs: No value; assertions establish a single unbounded user-controlled edge with no likely keys.
 * Does not handle: Re-exports from another module or default export syntax.
 * Side effects: Parses/extracts source and performs assertions.
 */
() => {
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

test("marks environment enumeration and forwarding as scoped unbounded uncertainty", /**
 * Verifies that environment enumeration, for-in, and spread forwarding become scoped opaque unbounded evidence instead of individual reads.
 *
 * Inputs: No parameters; supplies one source fixture using `Object.keys`, `for...in`, and object spread.
 * Outputs: No value; assertions establish three opaque unbounded dynamic edges and no direct demand.
 * Does not handle: Enumeration values, collection size, or forwarding into external code.
 * Side effects: Parses/extracts source, iterates dynamic edges, and performs assertions.
 */
() => {
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

test("marks broad environment-object forwarding as unbounded uncertainty", /**
 * Verifies that return, call argument, mutable assignment, assignment expression, and object-property forwarding of the full environment are opaque uncertainty.
 *
 * Inputs: No parameters; supplies a source fixture covering five broad environment forwarding forms.
 * Outputs: No value; assertions establish five opaque unbounded edges and no direct demand.
 * Does not handle: Downstream consumer analysis or precise forwarding destinations.
 * Side effects: Parses/extracts source, iterates results, and performs assertions.
 */
() => {
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

test("preserves no-value-leak behavior for unsafe static literals", /**
 * Verifies that an invalid static environment literal becomes dynamic opaque evidence and does not appear in serialized extraction output.
 *
 * Inputs: No parameters; builds a deliberately invalid non-secret test literal into an in-memory bracket-access fixture.
 * Outputs: No value; assertions establish no direct demand, unbounded dynamic evidence, and no raw literal leakage.
 * Does not handle: Credential-prefix detection or parser error handling.
 * Side effects: Concatenates source text, parses/extracts it, serializes the result, and performs assertions.
 */
() => {
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

test("keeps a user-selected literal map finite without claiming an exact read", /**
 * Verifies that a request-selected index into a finite literal map retains both candidates without claiming either one is an exact read.
 *
 * Inputs: No parameters; supplies a literal region-to-key map selected through request input.
 * Outputs: No value; assertions establish one finite user-controlled dynamic domain and its two likely keys.
 * Does not handle: Runtime map mutation, more complex map values, or exact demand promotion.
 * Side effects: Parses/extracts source, maps likely keys, and performs assertions.
 */
() => {
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
    result.dynamicLookupEdges[0]?.likelyKeys.map(/**
 * Projects each likely logical key from the finite map domain to its name for exact array comparison.
 *
 * Inputs: One likely key from the extracted dynamic edge.
 * Outputs: The key name representation.
 * Does not handle: Namespace validation or opaque-key filtering.
 * Side effects: Reads `key.name` during `.map`.
 */
(key) => key.name),
    ["SERVICE_US", "SERVICE_EU"],
  );
});

test("supports import.meta, Bun, and Deno environment accessors", /**
 * Verifies that import-meta Bun and Deno environment accessors each produce exact direct reads through the same backend.
 *
 * Inputs: No parameters; supplies one source fixture with all three supported runtime accessor forms.
 * Outputs: No value; assertions establish the three exact names, three demand edges, and no dynamic evidence.
 * Does not handle: Runtime availability, user aliases, or additional environment APIs.
 * Side effects: Parses/extracts source, maps/filters/sorts reference names, and performs assertions.
 */
() => {
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
      .map(/**
 * Projects an extracted reference to its requested-name field before concrete-name filtering.
 *
 * Inputs: One normalized reference.
 * Outputs: Its requested name representation.
 * Does not handle: Determining whether it is opaque.
 * Side effects: Reads the requested name during `.map`.
 */
(reference) => reference.requested.name)
      .filter(/**
 * Retains concrete reference names for the multi-runtime expected-key comparison.
 *
 * Inputs: One requested name representation.
 * Outputs: True exactly when it is a string.
 * Does not handle: Validating safe identifier syntax.
 * Side effects: Performs a type check during `.filter`.
 */
(name) => typeof name === "string")
      .map(/**
 * Converts each retained concrete name into a string for sorting against the expected runtime keys.
 *
 * Inputs: One name narrowed to a string by the preceding filter.
 * Outputs: Its `String` conversion.
 * Does not handle: Redaction or name normalization.
 * Side effects: Converts the value during `.map`.
 */
(name) => String(name))
      .sort(),
    ["BUN_TOKEN", "DENO_TOKEN", "PUBLIC_URL"],
  );
  assert.equal(result.demandEdges.length, 3);
  assert.equal(result.dynamicLookupEdges.length, 0);
});

test("does not treat a shadowed process binding as the Node process global", /**
 * Verifies that a locally declared `process` shadows the Node global and prevents false environment-read observations.
 *
 * Inputs: No parameters; supplies source that declares a plain local `process.env` object before property access.
 * Outputs: No value; assertions establish empty references, demand edges, and dynamic edges.
 * Does not handle: Type checking the local object's shape or imports that shadow globals.
 * Side effects: Parses/extracts source and performs assertions.
 */
() => {
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

test("turns over-budget finite domains and zero-segment templates into unbounded facts", /**
 * Verifies that an over-cap conditional key and a request-only template both widen to unbounded evidence with their respective reasons/origins.
 *
 * Inputs: No parameters; extracts an over-budget ternary using cap two and a template with no fixed segment.
 * Outputs: No value; assertions establish `over-budget` lexical and `user-controlled` unbounded domains.
 * Does not handle: Partial fixed-segment patterns or different cap alignment failures.
 * Side effects: Runs two extractions with local factories/options and performs assertions.
 */
() => {
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

test("reports parse failure without retaining parser text", /**
 * Verifies that malformed source yields only the fixed parse-failure diagnostic and never retains the malformed source text in serialized output.
 *
 * Inputs: No parameters; supplies one intentionally malformed in-memory TypeScript statement.
 * Outputs: No value; assertions establish the fixed diagnostic and absence of source text from JSON.
 * Does not handle: Parser recovery observations or semantic compiler diagnostics.
 * Side effects: Parses/extracts the malformed text, serializes result, and performs assertions.
 */
() => {
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

test("safe source IDs namespace identical coordinates across independently scanned files", /**
 * Verifies that caller-provided safe source IDs distinguish fact IDs for identical coordinates in independently scanned files.
 *
 * Inputs: No parameters; runs two direct-read extractions with identical source text and distinct safe file/source IDs.
 * Outputs: No value; assertions establish distinct reference/demand IDs with their supplied source-ID prefixes.
 * Does not handle: Source ID safety validation or ID collisions for callers that reuse the same ID/coordinates.
 * Side effects: Runs two extractions, constructs factories, and performs string/inequality assertions.
 */
() => {
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

test("direct-use fallback IDs remain distinct without encoding source paths", /**
 * Verifies that automatic direct-use IDs differ across calls without leaking either safe-path fixture name into the generated IDs.
 *
 * Inputs: No parameters; runs two direct-read extractions without source IDs but with differently named safe file fixtures.
 * Outputs: No value; assertions establish distinct fallback reference IDs and absence of both path fragments.
 * Does not handle: Counter reset across processes or source-ID override behavior.
 * Side effects: Advances module-global fallback sequence through two extractions and performs assertions.
 */
() => {
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
