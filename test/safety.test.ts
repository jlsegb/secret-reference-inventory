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

test("SafeFactFactory accepts conventional keys and makes secret-shaped source keys opaque", () => {
  const factory = new SafeFactFactory();

  assert.equal(factory.environmentKey("DATABASE_URL"), "DATABASE_URL");
  assert.deepEqual(factory.environmentKey(SENTINEL), OPAQUE_IDENTIFIER);
  assert.equal(JSON.stringify(factory.environmentKey(SENTINEL)).includes(SENTINEL), false);
});

test("SafeFactFactory permits only exact trusted lower-case environment keys", () => {
  const factory = new SafeFactFactory({ trustedEnvironmentKeys: ["legacy_config_key"] });

  assert.equal(factory.environmentKey("legacy_config_key"), "legacy_config_key");
  assert.deepEqual(factory.environmentKey("other_lowercase_key"), OPAQUE_IDENTIFIER);
  assert.throws(
    () => new SafeFactFactory({ trustedEnvironmentKeys: [SENTINEL] }),
    (error: unknown) => error instanceof SafetyConfigurationError && !error.message.includes(SENTINEL),
  );
});

test("SafeFactFactory makes credential-like source path segments opaque", () => {
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

test("source fact materialization cannot carry an unsafe literal into a normalized key", () => {
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

test("dynamic source fact materialization preserves scoped unbounded evidence and rejects duplicate finite keys", () => {
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

test("binding facts are materialized only with exact safe scope and resource identifiers", () => {
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

test("closed models retain coverage metadata but never promote unproven dynamic domains", () => {
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
  assert.deepEqual(factory.closedModelDiagnostics(closedModel).map((diagnostic) => diagnostic.code), [
    "UNPROVEN_DYNAMIC_DOMAIN",
  ]);

  const missingInputId = structuredClone(closedModel);
  delete (missingInputId.scopes[0]!.expectedAdapterInputs[0] as { inputId?: string }).inputId;
  assert.equal(factory.materializeClosedModel(missingInputId).ok, false);
});

test("public provisioning materializers reject an oversized sparse inventory before getters run", () => {
  const items = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(items, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
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

test("SafeFactFactory never accepts a finite-domain cap above the provisioning maximum", () => {
  assert.throws(
    () => new SafeFactFactory({ maxFiniteKeyDomain: 101 }),
    (error: unknown) => error instanceof SafetyConfigurationError,
  );
});
