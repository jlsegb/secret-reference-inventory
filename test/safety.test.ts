import assert from "node:assert/strict";
import test from "node:test";

import {
  OPAQUE_IDENTIFIER,
  OPAQUE_PATH,
  SafeFactFactory,
  SafetyConfigurationError,
} from "../src/safety/index.js";
import { MAX_PROVISIONING_RAW_ENTRIES } from "../src/safety/provisioning-budget.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

const scope = {
  id: "api-runtime",
  componentId: "api",
  phase: "runtime",
  stage: { kind: "exact", values: ["production"] },
  channel: "environment",
} as const;

const selector = {
  executionUnitIds: ["api-runtime"],
  phases: ["runtime"],
  stage: { kind: "exact", values: ["production"] },
  channels: ["environment"],
  condition: { kind: "always" },
} as const;

const location = {
  file: "src/index.ts",
  start: { line: 1, column: 0 },
  end: { line: 1, column: 10 },
} as const;

test("SafeFactFactory accepts conventional keys and makes secret-shaped source keys opaque", /**
 * Verifies that a conventional environment key remains visible while a credential-shaped fixture never survives fact serialization.
 *
 * Inputs: No parameters; uses the module's non-production, credential-shaped sentinel fixture.
 * Outputs: No value; assertions establish accepted-key and opaque/redaction behavior.
 * Does not handle: Provider retrieval, filesystem scanning, or identifying every possible credential format.
 * Side effects: Constructs a factory, invokes key conversion, serializes one result, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();

  assert.equal(factory.environmentKey("DATABASE_URL"), "DATABASE_URL");
  assert.deepEqual(factory.environmentKey(SENTINEL), OPAQUE_IDENTIFIER);
  assert.equal(JSON.stringify(factory.environmentKey(SENTINEL)).includes(SENTINEL), false);
});

test("SafeFactFactory permits only exact trusted lower-case environment keys", /**
 * Verifies that the trusted-key allowlist is exact and rejects a token-shaped entry without exposing it through the thrown error.
 *
 * Inputs: No parameters; creates one local factory and reuses the sentinel fixture.
 * Outputs: No value; assertions establish exact allowlist behavior and safe configuration failure text.
 * Does not handle: Iterable exhaustion behavior, provider configuration, or runtime environment injection.
 * Side effects: Constructs factories, invokes conversion/throwing paths, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory({ trustedEnvironmentKeys: ["legacy_config_key"] });

  assert.equal(factory.environmentKey("legacy_config_key"), "legacy_config_key");
  assert.deepEqual(factory.environmentKey("other_lowercase_key"), OPAQUE_IDENTIFIER);
  assert.throws(
    /**
     * Constructs a factory from a trusted-key iterable containing the credential-shaped sentinel.
     *
     * Inputs: No parameters; captures the enclosing sentinel fixture.
     * Outputs: No value normally because construction is expected to throw.
     * Does not handle: Inspecting the thrown error or testing other invalid option shapes.
     * Side effects: Invokes `SafeFactFactory` construction for `assert.throws`.
     */
() => new SafeFactFactory({ trustedEnvironmentKeys: [SENTINEL] }),
    /**
     * Accepts only the configuration-error shape whose rendered message omits the sentinel.
     *
     * Inputs: The error captured by `assert.throws`.
     * Outputs: True for a `SafetyConfigurationError` with no sentinel in its message.
     * Does not handle: Verifying a specific fixed error code.
     * Side effects: Reads the error's type and message during assertion matching.
     */
(error: unknown) => error instanceof SafetyConfigurationError && !error.message.includes(SENTINEL),
  );
});

test("SafeFactFactory makes credential-like source path segments opaque", /**
 * Verifies that a normal in-root path is reportable while token-shaped segments and root escapes become opaque.
 *
 * Inputs: No parameters; uses local string paths and the sentinel fixture.
 * Outputs: No value; assertions establish safe relative-path and opaque-path outcomes.
 * Does not handle: Realpath/symlink containment or filesystem access.
 * Side effects: Constructs a factory, calls `safePath`, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();

  assert.equal(
    factory.safePath({ approvedRoot: "/workspace", canonicalPath: "/workspace/src/index.ts" }),
    "src/index.ts",
  );
  assert.equal(
    factory.safePath({
      approvedRoot: "/workspace",
      canonicalPath: `/workspace/src/${SENTINEL}.ts`,
    }),
    OPAQUE_PATH,
  );
  assert.equal(
    factory.safePath({ approvedRoot: "/workspace", canonicalPath: "/outside/index.ts" }),
    OPAQUE_PATH,
  );
});

test("source fact materialization cannot carry an unsafe literal into a normalized key", /**
 * Verifies that materializing a reference replaces an unsafe literal key with the opaque identifier before serialization.
 *
 * Inputs: No parameters; uses shared safe location and a sentinel as the raw environment name.
 * Outputs: No value; assertions establish successful materialization with no raw sentinel leakage.
 * Does not handle: Parsing source text or testing diagnostic failure branches.
 * Side effects: Constructs a factory/materialized record, serializes it, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();
  const result = factory.materializeSecretReference({
    id: "ref-1",
    requested: { namespace: "env", name: SENTINEL },
    demand: "direct-read",
    operation: "read",
    resolution: "literal",
    confidence: "high",
    location,
    exposure: "server",
    evidenceChain: [],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.requested.name, OPAQUE_IDENTIFIER);
  }
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("dynamic source fact materialization preserves scoped unbounded evidence and rejects duplicate finite keys", /**
 * Verifies that legitimate unbounded user-controlled evidence is retained while duplicate finite key evidence is rejected.
 *
 * Inputs: No parameters; materializes one unbounded and one duplicate finite dynamic-edge fixture.
 * Outputs: No value; assertions establish the accepted uncertainty and rejected duplicate cases.
 * Does not handle: Pattern-domain matching or execution-scope overlap.
 * Side effects: Constructs a factory, materializes two inputs, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();
  const unbounded = factory.materializeDynamicLookupEdge({
    id: "lookup-1",
    referenceId: "ref-1",
    scope,
    domain: { kind: "unbounded", reason: "user-controlled" },
    origin: "user-controlled",
    likelyKeys: [],
    evidenceChain: [],
  });

  assert.equal(unbounded.ok, true);
  if (unbounded.ok) {
    assert.equal(unbounded.value.domain.kind, "unbounded");
    assert.deepEqual(unbounded.value.likelyKeys, []);
  }

  const duplicateFinite = factory.materializeDynamicLookupEdge({
    id: "lookup-2",
    referenceId: "ref-1",
    scope,
    domain: { kind: "finite", keys: ["DATABASE_URL", "DATABASE_URL"] },
    origin: "lexical",
    likelyKeys: [
      { namespace: "env", name: "DATABASE_URL" },
      { namespace: "env", name: "DATABASE_URL" },
    ],
    evidenceChain: [],
  });

  assert.equal(duplicateFinite.ok, false);
});

test("binding facts are materialized only with exact safe scope and resource identifiers", /**
 * Verifies that a fully specified binding fixture crosses the safety boundary with its exact environment destination retained.
 *
 * Inputs: No parameters; uses shared safe scope/selector and a complete binding record.
 * Outputs: No value; assertions establish the success branch and destination name.
 * Does not handle: Provider lookup, precedence resolution, or malformed-binding variants.
 * Side effects: Constructs a factory, materializes one binding, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();
  const result = factory.materializeBindingCandidate({
    id: "binding-1",
    adapterId: "manifest-adapter",
    scope,
    destination: { namespace: "env", name: "DATABASE_URL" },
    sourceKind: "secret-manager",
    providerResourceId: { authorityId: "aws-prod", canonicalId: "aws:prod/database-url" },
    appliesWhen: selector,
    precedence: { source: "manifest", rank: 1, comparable: true },
    resolution: "exact",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.destination.name, "DATABASE_URL");
  }
});

test("closed models retain coverage metadata but never promote unproven dynamic domains", /**
 * Verifies that closed-model coverage metadata survives materialization while declared dynamic domains produce uncertainty rather than finite promotion.
 *
 * Inputs: No parameters; builds a local closed-model fixture then clones a malformed variant.
 * Outputs: No value; assertions establish retained coverage, fixed uncertainty, and missing-ID rejection.
 * Does not handle: Core graph conclusions or runtime provisioning coverage.
 * Side effects: Creates/clones fixtures, materializes a model, maps diagnostics, mutates the clone, and performs assertions.
 */
() => {
  const factory = new SafeFactFactory();
  const closedModel = {
    schemaVersion: "closed-provisioning-model/v1",
    inputId: "model-1",
    maxFiniteKeyDomain: 10,
    scopes: [
      {
        scope,
        declaredStages: ["production"],
        closed: true,
        approvedFirstPartyRoots: ["apps/api"],
        bindingRoots: ["infra"],
        expectedAdapterInputs: [
          {
            inputId: "manifest-api",
            domain: "binding",
            adapterId: "manifest-adapter",
            extensions: [".json"],
          },
        ],
        permittedExclusions: [],
        inventoryAuthorities: [{ authorityId: "aws-prod", inventoryInputId: "inventory-prod" }],
        allowedExternalMechanisms: [],
        outsideRootImports: "out-of-scope",
      },
    ],
    dynamicDomains: [
      { patternId: "pattern-1", selector, keys: ["DATABASE_URL"] },
    ],
  };

  const result = factory.materializeClosedModel(closedModel);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.finitePatternDomains, undefined);
    assert.equal(result.value.scopes[0]?.coverage?.expectedInputs[0]?.inputId, "manifest-api");
  }
  assert.deepEqual(factory.closedModelDiagnostics(closedModel).map(/**
 * Projects each closed-model diagnostic to its code for an exact expected-code comparison.
 *
 * Inputs: One sanitized Core diagnostic from the factory result.
 * Outputs: That diagnostic's `code` string.
 * Does not handle: Inspecting diagnostic locations or validating the code vocabulary.
 * Side effects: Reads `diagnostic.code` during `.map`.
 */
(diagnostic) => diagnostic.code), [
    "UNPROVEN_DYNAMIC_DOMAIN",
  ]);

  const missingInputId = structuredClone(closedModel);
  delete (missingInputId.scopes[0]!.expectedAdapterInputs[0] as { inputId?: string }).inputId;
  assert.equal(factory.materializeClosedModel(missingInputId).ok, false);
});

test("public provisioning materializers reject an oversized sparse inventory before getters run", /**
 * Verifies that an oversized sparse inventory is rejected before its hostile indexed getter is observed.
 *
 * Inputs: No parameters; allocates an oversized sparse array with a deliberately throwing terminal getter.
 * Outputs: No value; assertions establish early rejection and absence of the sentinel from serialized failure data.
 * Does not handle: Getter behavior for in-budget arrays or global memory exhaustion.
 * Side effects: Allocates the sparse array, defines an accessor, materializes an inventory fixture, serializes output, and performs assertions.
 */
() => {
  const items = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(items, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
    /**
     * Throws if the oversized-array preflight incorrectly reads the out-of-budget indexed element.
     *
     * Inputs: No parameters; invoked only by property access at the terminal sparse index.
     * Outputs: Never returns normally.
     * Does not handle: Tracking getter invocation count or asserting the thrown error.
     * Side effects: Throws a local `Error` when accessed.
     */
get() {
      throw new Error("must not materialize an out-of-budget inventory item");
    },
  });
  const factory = new SafeFactFactory();
  const result = factory.materializeInventorySnapshot({
    inputId: "oversized-inventory-input",
    authorityId: "aws-prod",
    asOf: "2026-07-12T00:00:00Z",
    items,
  });

  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("SafeFactFactory never accepts a finite-domain cap above the provisioning maximum", /**
 * Verifies that factory configuration cannot admit a finite-domain cap above the provisioning hard maximum.
 *
 * Inputs: No parameters.
 * Outputs: No value; the assertion establishes the invalid-cap error class.
 * Does not handle: Boundary acceptance at the exact maximum or extractor-specific limits.
 * Side effects: Invokes `assert.throws` and attempts local factory construction.
 */
() => {
  assert.throws(
    /**
     * Attempts factory construction with a cap one greater than the closed-model maximum.
     *
     * Inputs: No parameters.
     * Outputs: No normal value because the constructor is expected to throw.
     * Does not handle: Testing trusted-key configuration.
     * Side effects: Invokes the failing constructor for `assert.throws`.
     */
() => new SafeFactFactory({ maxFiniteKeyDomain: 101 }),
    /**
     * Narrows the captured exception to the dedicated safety-configuration error class.
     *
     * Inputs: The error captured by `assert.throws`.
     * Outputs: True only for `SafetyConfigurationError`.
     * Does not handle: Verifying its fixed failure code.
     * Side effects: Performs an `instanceof` check during assertion matching.
     */
(error: unknown) => error instanceof SafetyConfigurationError,
  );
});
