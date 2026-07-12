import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_MANIFEST_SCHEMA_VERSION,
  CLOSED_MODEL_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_SCHEMA_VERSION,
  type BindingAdapterFactBuilder,
  type RawBindingCandidate,
  type RawClosedProvisioningModel,
  type RawCoverageGap,
  type RawInventorySnapshot,
} from "../src/binding-adapters/contracts.js";
import {
  adaptCoreFactBuilder,
  coreBindingResolutionPort,
} from "../src/binding-adapters/core-bridge.js";
import type { BindingCandidate } from "../src/core/types.js";
import { SafeFactFactory } from "../src/safety/factory.js";
import {
  parseBindingManifest,
  parseClosedProvisioningModel,
  parseInventorySnapshot,
} from "../src/binding-adapters/parser.js";
import { MAX_PROVISIONING_RAW_ENTRIES } from "../src/safety/provisioning-budget.js";
import { resolveParsedBindingCandidates } from "../src/binding-adapters/resolution-port.js";

interface CapturedFacts {
  readonly candidates: RawBindingCandidate[];
  readonly snapshots: RawInventorySnapshot[];
  readonly models: RawClosedProvisioningModel[];
  readonly gaps: RawCoverageGap[];
}

function createBuilder(): {
  readonly builder: BindingAdapterFactBuilder<
    RawBindingCandidate,
    RawInventorySnapshot,
    RawClosedProvisioningModel,
    RawCoverageGap
  >;
  readonly captured: CapturedFacts;
} {
  const captured: CapturedFacts = {
    candidates: [],
    snapshots: [],
    models: [],
    gaps: [],
  };
  return {
    captured,
    builder: {
      bindingCandidate(input) {
        captured.candidates.push(input);
        return { ok: true, value: input };
      },
      inventorySnapshot(input) {
        captured.snapshots.push(input);
        return { ok: true, value: input };
      },
      closedModel(input) {
        captured.models.push(input);
        return { ok: true, value: input };
      },
      coverageGap(input) {
        captured.gaps.push(input);
        return { ok: true, value: input };
      },
    },
  };
}

function runtimeScope(): object {
  return {
    id: "api-main",
    componentId: "api",
    phase: "runtime",
    stage: { kind: "exact", values: ["production"] },
    channel: "environment",
  };
}

function runtimeSelector(): object {
  return {
    executionUnitIds: ["api-main"],
    phases: ["runtime"],
    stage: { kind: "exact", values: ["production"] },
    channels: ["environment"],
    condition: {
      kind: "all",
      clauses: [{ key: "BRANCH", operator: "equals", value: "main" }],
    },
  };
}

function validCandidate(): object {
  return {
    id: "api-production-database-url",
    adapterId: "kubernetes",
    scope: runtimeScope(),
    destination: { namespace: "env", name: "DATABASE_URL" },
    sourceKind: "secret-manager",
    providerResourceId: {
      authorityId: "aws-account-123-us-east-1",
      canonicalId: "payments-database-url-current",
    },
    appliesWhen: runtimeSelector(),
    precedence: { source: "container-env", rank: 20, comparable: true },
    resolution: "exact",
  };
}

function closedModelWithExpectedInputs(expectedAdapterInputs: readonly object[]): object {
  return {
    schemaVersion: CLOSED_MODEL_SCHEMA_VERSION,
    inputId: "provisioning-model",
    maxFiniteKeyDomain: 8,
    scopes: [
      {
        scope: runtimeScope(),
        declaredStages: ["production"],
        closed: true,
        approvedFirstPartyRoots: ["apps-api"],
        bindingRoots: ["deploy"],
        expectedAdapterInputs,
        permittedExclusions: [],
        inventoryAuthorities: [
          { authorityId: "aws-account-123-us-east-1", inventoryInputId: "aws-production-export" },
        ],
        allowedExternalMechanisms: [],
        outsideRootImports: "out-of-scope",
      },
    ],
  };
}

test("binding manifest preserves typed mapping, scope, condition, and precedence for Core selection", () => {
  const { builder, captured } = createBuilder();
  const result = parseBindingManifest(
    {
      schemaVersion: BINDING_MANIFEST_SCHEMA_VERSION,
      inputId: "local-kubernetes-bindings",
      adapterId: "kubernetes",
      candidates: [validCandidate()],
    },
    builder,
  );

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.coverageGaps.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(captured.candidates[0], {
    ...validCandidate(),
  });

  const selection = resolveParsedBindingCandidates(result, {
    resolve(candidates) {
      assert.equal(candidates.length, 1);
      return [{ outcome: "delegated-to-core" }];
    },
  });
  assert.deepEqual(selection, [{ outcome: "delegated-to-core" }]);
});

test("the Core resolution port retains an effective binding and its shadowed candidate", () => {
  const winner = {
    ...validCandidate(),
    id: "api-production-database-url-explicit",
    precedence: { source: "container-env", rank: 30, comparable: true },
  } as BindingCandidate;
  const shadowed = {
    ...validCandidate(),
    id: "api-production-database-url-env-file",
    precedence: { source: "env-file", rank: 10, comparable: true },
  } as BindingCandidate;

  const resolutions = coreBindingResolutionPort.resolve([winner, shadowed]);
  const partition = resolutions[0]?.partitions[0];
  assert.equal(partition?.outcome, "effective");
  assert.deepEqual(partition?.selections, [
    { candidateId: "api-production-database-url-explicit", status: "effective" },
    { candidateId: "api-production-database-url-env-file", status: "shadowed" },
  ]);
});

test("malformed binding input creates scoped uncertainty without retaining an unknown secret-shaped field", () => {
  const { builder } = createBuilder();
  const sentinel = "test only unknown field no leak";
  const candidate = {
    ...validCandidate(),
    [sentinel]: "not-a-permitted-field",
  };
  const result = parseBindingManifest(
    {
      schemaVersion: BINDING_MANIFEST_SCHEMA_VERSION,
      inputId: "local-kubernetes-bindings",
      adapterId: "kubernetes",
      candidates: [candidate],
    },
    builder,
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverageGaps.length, 1);
  assert.equal(result.coverageGaps[0]?.domain, "binding");
  assert.deepEqual(result.coverageGaps[0]?.potentiallyAffects.executionUnitIds, ["api-main"]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(result.diagnostics.some(({ code }) => code === "unknown-field"), true);
});

test("inventory authority is part of the identity boundary and cannot be mixed inside a snapshot", () => {
  const { builder } = createBuilder();
  const result = parseInventorySnapshot(
    {
      schemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
      inputId: "aws-production-export",
      authorityId: "aws-account-a-us-east-1",
      asOf: "2026-07-12T00:00:00Z",
      items: [
        {
          providerResourceId: {
            authorityId: "aws-account-b-us-east-1",
            canonicalId: "payments-database-url-current",
          },
        },
      ],
    },
    builder,
  );

  assert.equal(result.coverageGaps.length, 1);
  assert.equal(result.coverageGaps[0]?.domain, "inventory");
  assert.equal(result.diagnostics.some(({ code }) => code === "invalid-provider-resource"), true);
  assert.equal(result.snapshot?.items.length, 0);
});

test("materialized inventory snapshots retain their declared local input identity", () => {
  const factory = new SafeFactFactory();
  const result = parseInventorySnapshot(
    {
      schemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
      inputId: "aws-production-export",
      authorityId: "aws-account-123-us-east-1",
      asOf: "2026-07-12T00:00:00Z",
      items: [],
    },
    adaptCoreFactBuilder(factory),
  );

  assert.equal(result.coverageGaps.length, 0);
  assert.equal(result.snapshot?.inputId, "aws-production-export");
});

test("closed models retain valid static scopes but never expand a manifest-only dynamic domain", () => {
  const { builder, captured } = createBuilder();
  const result = parseClosedProvisioningModel(
    {
      schemaVersion: CLOSED_MODEL_SCHEMA_VERSION,
      inputId: "provisioning-model",
      maxFiniteKeyDomain: 8,
      scopes: [
        {
          scope: runtimeScope(),
          declaredStages: ["production"],
          closed: true,
          approvedFirstPartyRoots: ["apps-api"],
          bindingRoots: ["deploy"],
          expectedAdapterInputs: [
            {
              inputId: "kubernetes-production-binding-input",
              domain: "binding",
              adapterId: "kubernetes",
              extensions: [".yaml"],
            },
          ],
          permittedExclusions: [],
          inventoryAuthorities: [
            { authorityId: "aws-account-123-us-east-1", inventoryInputId: "aws-production-export" },
          ],
          allowedExternalMechanisms: [],
          outsideRootImports: "out-of-scope",
        },
      ],
      dynamicDomains: [
        {
          patternId: "service-region-pattern-1",
          selector: runtimeSelector(),
          keys: ["SERVICE_US"],
        },
      ],
    },
    builder,
  );

  assert.equal(result.model === undefined, false);
  assert.equal(result.coverageGaps.length, 0);
  assert.equal(captured.models.length, 1);
  assert.deepEqual(captured.models[0]?.dynamicDomains, []);
  assert.equal(result.diagnostics.some(({ code }) => code === "unproven-dynamic-domain"), true);
});

test("an invalid closed scope blocks the model with a binding-domain coverage gap", () => {
  const { builder } = createBuilder();
  const result = parseClosedProvisioningModel(
    {
      schemaVersion: CLOSED_MODEL_SCHEMA_VERSION,
      inputId: "provisioning-model",
      maxFiniteKeyDomain: 8,
      scopes: [
        {
          scope: { ...runtimeScope(), channel: "unknown" },
          declaredStages: ["production"],
          closed: true,
          approvedFirstPartyRoots: ["apps-api"],
          bindingRoots: ["deploy"],
          expectedAdapterInputs: [
            {
              inputId: "kubernetes-production-binding-input",
              domain: "binding",
              adapterId: "kubernetes",
              extensions: [".yaml"],
            },
          ],
          permittedExclusions: [],
          inventoryAuthorities: [
            { authorityId: "aws-account-123-us-east-1", inventoryInputId: "aws-production-export" },
          ],
          allowedExternalMechanisms: [],
          outsideRootImports: "out-of-scope",
        },
      ],
    },
    builder,
  );

  assert.equal(result.model, undefined);
  assert.equal(result.coverageGaps.length, 1);
  assert.equal(result.coverageGaps[0]?.domain, "binding");
  assert.equal(result.diagnostics.some(({ code }) => code === "invalid-closed-model"), true);
});

test("expected coverage inputs require an explicit unique safe ID without leaking rejected text", () => {
  const missingInputId = parseClosedProvisioningModel(
    closedModelWithExpectedInputs([
      { domain: "binding", adapterId: "kubernetes", extensions: [".yaml"] },
    ]),
    createBuilder().builder,
  );
  assert.equal(missingInputId.model, undefined);
  assert.equal(missingInputId.coverageGaps.length, 1);

  const sentinel = "test only invalid input id";
  const unsafeInputId = parseClosedProvisioningModel(
    closedModelWithExpectedInputs([
      { inputId: sentinel, domain: "binding", adapterId: "kubernetes", extensions: [".yaml"] },
    ]),
    createBuilder().builder,
  );
  assert.equal(unsafeInputId.model, undefined);
  assert.equal(unsafeInputId.diagnostics.some(({ code }) => code === "unsafe-identifier"), true);
  assert.equal(JSON.stringify(unsafeInputId).includes(sentinel), false);

  const duplicateInputId = parseClosedProvisioningModel(
    closedModelWithExpectedInputs([
      { inputId: "shared-input", domain: "binding", adapterId: "kubernetes", extensions: [".yaml"] },
      { inputId: "shared-input", domain: "demand", adapterId: "typescript", extensions: [".ts"] },
    ]),
    createBuilder().builder,
  );
  assert.equal(duplicateInputId.model, undefined);
  assert.equal(duplicateInputId.diagnostics.some(({ code }) => code === "duplicate-candidate"), true);
});

test("Core bridge preserves expected coverage input IDs for closed-model completion", () => {
  const result = parseClosedProvisioningModel(
    closedModelWithExpectedInputs([
      {
        inputId: "kubernetes-production-binding-input",
        domain: "binding",
        adapterId: "kubernetes",
        extensions: [".yaml"],
      },
    ]),
    adaptCoreFactBuilder(new SafeFactFactory()),
  );

  const expectedInput = result.model?.scopes[0]?.coverage?.expectedInputs[0];
  assert.equal(expectedInput?.inputId, "kubernetes-production-binding-input");
  assert.equal(expectedInput?.domain, "binding");
  assert.deepEqual(expectedInput?.extensions, ["extension-yaml"]);
});

test("oversized binding candidates stop before indexed entries and retain one unknown-scope gap", () => {
  const candidates = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(candidates, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
    get() {
      throw new Error("must not read an out-of-budget candidate");
    },
  });
  const { builder, captured } = createBuilder();

  const result = parseBindingManifest(
    {
      schemaVersion: BINDING_MANIFEST_SCHEMA_VERSION,
      inputId: "oversized-binding-input",
      adapterId: "manifest-adapter",
      candidates,
    },
    builder,
  );

  assert.deepEqual(result.diagnostics, [{ code: "input-entry-limit-exceeded", path: [] }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverageGaps.length, 1);
  assert.deepEqual(result.coverageGaps[0]?.potentiallyAffects, {
    stage: { kind: "unknown" },
    condition: { kind: "unknown" },
  });
  assert.equal(captured.candidates.length, 0);
  assert.equal(captured.gaps.length, 1);
});

test("oversized inventory items retain no snapshot and emit one fixed incomplete gap", () => {
  const { builder, captured } = createBuilder();
  const result = parseInventorySnapshot(
    {
      schemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
      inputId: "oversized-inventory-input",
      authorityId: "aws-account-123-us-east-1",
      asOf: "2026-07-12T00:00:00Z",
      items: new Array(MAX_PROVISIONING_RAW_ENTRIES + 1),
    },
    builder,
  );

  assert.equal(result.snapshot, undefined);
  assert.deepEqual(result.diagnostics, [{ code: "input-entry-limit-exceeded", path: [] }]);
  assert.equal(result.coverageGaps.length, 1);
  assert.equal(result.coverageGaps[0]?.domain, "inventory");
  assert.equal(captured.snapshots.length, 0);
});

test("a nested closed-model selector flood is discarded before any model materialization", () => {
  const { builder, captured } = createBuilder();
  const oversizedStages = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(oversizedStages, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
    get() {
      throw new Error("must not read an out-of-budget nested selector entry");
    },
  });
  const result = parseClosedProvisioningModel(
    {
      ...closedModelWithExpectedInputs([]),
      scopes: [
        {
          scope: {
            ...runtimeScope(),
            stage: { kind: "exact", values: oversizedStages },
          },
          declaredStages: ["production"],
          closed: true,
          approvedFirstPartyRoots: ["apps-api"],
          bindingRoots: ["deploy"],
          expectedAdapterInputs: [],
          permittedExclusions: [],
          inventoryAuthorities: [
            { authorityId: "aws-account-123-us-east-1", inventoryInputId: "aws-production-export" },
          ],
          allowedExternalMechanisms: [],
          outsideRootImports: "out-of-scope",
        },
      ],
    },
    builder,
  );

  assert.equal(result.model, undefined);
  assert.deepEqual(result.diagnostics, [{ code: "input-entry-limit-exceeded", path: [] }]);
  assert.equal(result.coverageGaps.length, 1);
  assert.equal(captured.models.length, 0);
});

test("raw entry accounting is shared across nested arrays and stops before the next getter", () => {
  const stages = Array.from(
    { length: MAX_PROVISIONING_RAW_ENTRIES - 1 },
    (_, index) => "stage" + String(index),
  );
  const executionUnitIds = new Array<unknown>(1);
  Object.defineProperty(executionUnitIds, 0, {
    enumerable: true,
    get() {
      throw new Error("must not read beyond the shared raw-entry budget");
    },
  });
  const candidate = {
    ...validCandidate(),
    scope: { ...runtimeScope(), stage: { kind: "exact", values: stages } },
    appliesWhen: { ...runtimeSelector(), executionUnitIds },
  };
  const { builder, captured } = createBuilder();

  const result = parseBindingManifest(
    {
      schemaVersion: BINDING_MANIFEST_SCHEMA_VERSION,
      inputId: "nested-entry-budget-binding-input",
      adapterId: "manifest-adapter",
      candidates: [candidate],
    },
    builder,
  );

  assert.deepEqual(result.diagnostics, [{ code: "input-entry-limit-exceeded", path: [] }]);
  assert.equal(result.coverageGaps.length, 1);
  assert.equal(captured.candidates.length, 0);
});

test("closed models cap finite key domains at 100 before Core materialization", () => {
  const { builder, captured } = createBuilder();
  const result = parseClosedProvisioningModel(
    { ...closedModelWithExpectedInputs([]), maxFiniteKeyDomain: 101 },
    builder,
  );

  assert.equal(result.model, undefined);
  assert.equal(result.diagnostics.some(({ code }) => code === "model-domain-over-budget"), true);
  assert.equal(captured.models.length, 0);
});
