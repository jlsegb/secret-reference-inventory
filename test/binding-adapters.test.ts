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

/**
 * Creates a permissive test builder that captures every raw fact handed to it.
 *
 * Inputs: None.
 * Outputs: A builder returning inputs unchanged and mutable capture arrays for assertions.
 * Does not handle: Core materialization validation, redaction, or selection.
 * Side effects: Allocates mutable test-only capture collections.
 */
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
      /**
       * Captures a raw binding candidate passed by the parser.
       *
       * Inputs: One raw binding candidate.
       * Outputs: A successful materialization result containing the same candidate.
       * Does not handle: Safety validation, precedence, or copying the candidate.
       * Side effects: Pushes into the test candidate capture array.
       */
      bindingCandidate(input) {
        captured.candidates.push(input);
        return { ok: true, value: input };
      },
      /**
       * Captures a raw inventory snapshot passed by the parser.
       *
       * Inputs: One raw inventory snapshot.
       * Outputs: A successful materialization result containing the same snapshot.
       * Does not handle: Provider validation, copying, or resource matching.
       * Side effects: Pushes into the test snapshot capture array.
       */
      inventorySnapshot(input) {
        captured.snapshots.push(input);
        return { ok: true, value: input };
      },
      /**
       * Captures a raw closed model passed by the parser.
       *
       * Inputs: One raw closed provisioning model.
       * Outputs: A successful materialization result containing the same model.
       * Does not handle: Closure proof, dynamic-domain expansion, or copying.
       * Side effects: Pushes into the test model capture array.
       */
      closedModel(input) {
        captured.models.push(input);
        return { ok: true, value: input };
      },
      /**
       * Captures a raw coverage gap passed by the parser.
       *
       * Inputs: One raw coverage-gap object.
       * Outputs: A successful materialization result containing the same gap.
       * Does not handle: Gap deduplication, resolution, or copying.
       * Side effects: Pushes into the test gap capture array.
       */
      coverageGap(input) {
        captured.gaps.push(input);
        return { ok: true, value: input };
      },
    },
  };
}

/**
 * Builds the shared production runtime execution-scope fixture.
 *
 * Inputs: None.
 * Outputs: A mutable object describing the API runtime environment channel.
 * Does not handle: Environment discovery or scope compatibility checks.
 * Side effects: Allocates a new fixture object and nested stage values.
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

/**
 * Builds the shared conditional runtime-selector fixture.
 *
 * Inputs: None.
 * Outputs: A mutable selector object constrained to API production and main branch.
 * Does not handle: Evaluating the branch predicate or matching bindings.
 * Side effects: Allocates new fixture objects and arrays.
 */
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

/**
 * Builds one well-formed secret-manager binding-candidate fixture.
 *
 * Inputs: None.
 * Outputs: A mutable candidate object with scope, destination, resource, condition, and precedence fields.
 * Does not handle: Core materialization or effective-binding resolution.
 * Side effects: Allocates a new fixture and nested scope/selector objects.
 */
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

/**
 * Builds a valid closed-model fixture whose expected adapter inputs are caller controlled.
 *
 * Inputs: The expected-input fixture records for its sole runtime scope.
 * Outputs: A mutable closed-model object with fixed authority, roots, and external-mechanism settings.
 * Does not handle: Validating the supplied input records or materializing the model.
 * Side effects: Allocates the enclosing model fixture and nested arrays.
 */
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

test("binding manifest preserves typed mapping, scope, condition, and precedence for Core selection",
  /**
   * Exercises successful binding parsing and the explicit handoff to the selection port.
   *
   * Inputs: Node's test runner with local fixture data.
   * Outputs: Assertions pass when typed mapping and Core delegation are preserved.
   * Does not handle: Provider access or end-to-end report assembly.
   * Side effects: Materializes local fixture facts and performs assertions.
   */
  () => {
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
    /**
     * Asserts that the resolution port receives the parsed candidate and returns a sentinel result.
     *
     * Inputs: Candidate values forwarded by the resolution helper.
     * Outputs: One local delegated-to-core sentinel resolution.
     * Does not handle: Real Core precedence selection.
     * Side effects: Performs a test assertion.
     */
    resolve(candidates) {
      assert.equal(candidates.length, 1);
      return [{ outcome: "delegated-to-core" }];
    },
  });
  assert.deepEqual(selection, [{ outcome: "delegated-to-core" }]);
});

test("the Core resolution port retains an effective binding and its shadowed candidate",
  /**
   * Verifies Core selection retains both effective and shadowed candidates.
   *
   * Inputs: Node's test runner and two comparable local candidates.
   * Outputs: Assertions over Core's partition selections.
   * Does not handle: Conditional or incomparable precedence cases.
   * Side effects: Calls the local Core resolution port and asserts results.
   */
  () => {
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

test("malformed binding input creates scoped uncertainty without retaining an unknown secret-shaped field",
  /**
   * Verifies unknown candidate fields become scoped uncertainty without leaking the field spelling.
   *
   * Inputs: Node's test runner and one malformed candidate fixture.
   * Outputs: Assertions over gaps, diagnostics, and serialized output.
   * Does not handle: Actual secret values or provider inventory.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
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
  assert.equal(result.diagnostics.some(
    /**
     * Detects the fixed unknown-field diagnostic without reading any raw field name.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True when its code equals the expected fixed code.
     * Does not handle: Matching diagnostic paths or raw source text.
     * Side effects: None.
     */
    ({ code }) => code === "unknown-field"
  ), true);
});

test("inventory authority is part of the identity boundary and cannot be mixed inside a snapshot",
  /**
   * Verifies an item from a different authority is rejected as inventory uncertainty.
   *
   * Inputs: Node's test runner and one mismatched-authority snapshot fixture.
   * Outputs: Assertions over the fixed provider-resource diagnostic and omitted item.
   * Does not handle: Cross-account inventory aggregation.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
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
  assert.equal(result.diagnostics.some(
    /**
     * Recognizes the fixed cross-authority diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True only for invalid-provider-resource.
     * Does not handle: Inspecting resource IDs.
     * Side effects: None.
     */
    ({ code }) => code === "invalid-provider-resource"
  ), true);
  assert.equal(result.snapshot?.items.length, 0);
});

test("materialized inventory snapshots retain their declared local input identity",
  /**
   * Verifies Core materialization preserves the local inventory input identity.
   *
   * Inputs: Node's test runner and an empty valid inventory fixture.
   * Outputs: Assertions over the materialized snapshot.
   * Does not handle: Provider fetches or nonempty item normalization.
   * Side effects: Instantiates a local fact factory and performs assertions.
   */
  () => {
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

test("closed models retain valid static scopes but never expand a manifest-only dynamic domain",
  /**
   * Verifies a declared dynamic domain remains diagnostic-only while static scope materializes.
   *
   * Inputs: Node's test runner and a closed-model fixture containing one dynamic declaration.
   * Outputs: Assertions over the model, captured dynamic domains, and fixed diagnostic.
   * Does not handle: Trusted code-adapter dynamic expansion.
   * Side effects: Parses fixtures, captures builder input, and performs assertions.
   */
  () => {
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
  assert.equal(result.diagnostics.some(
    /**
     * Recognizes the fixed dynamic-domain uncertainty diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True for unproven-dynamic-domain.
     * Does not handle: Inspecting declared keys.
     * Side effects: None.
     */
    ({ code }) => code === "unproven-dynamic-domain"
  ), true);
});

test("an invalid closed scope blocks the model with a binding-domain coverage gap",
  /**
   * Verifies unknown channel evidence prevents closed-model materialization.
   *
   * Inputs: Node's test runner and a closed scope with an unknown channel.
   * Outputs: Assertions over omitted model, gap domain, and fixed diagnostic.
   * Does not handle: Other closure invariant failures.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
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
  assert.equal(result.diagnostics.some(
    /**
     * Recognizes the fixed invalid-closed-model diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True for the expected model failure code.
     * Does not handle: Classifying the precise invalid field.
     * Side effects: None.
     */
    ({ code }) => code === "invalid-closed-model"
  ), true);
});

test("expected coverage inputs require an explicit unique safe ID without leaking rejected text",
  /**
   * Verifies missing, unsafe, and duplicated expected-input IDs block model creation without raw leakage.
   *
   * Inputs: Node's test runner and three closed-model fixture variations.
   * Outputs: Assertions over model omission, fixed diagnostics, and serialized absence of a sentinel.
   * Does not handle: Successful multi-input completion joins.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
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
  assert.equal(unsafeInputId.diagnostics.some(
    /**
     * Recognizes a fixed unsafe-identifier diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True for unsafe-identifier.
     * Does not handle: Inspecting rejected ID text.
     * Side effects: None.
     */
    ({ code }) => code === "unsafe-identifier"
  ), true);
  assert.equal(JSON.stringify(unsafeInputId).includes(sentinel), false);

  const duplicateInputId = parseClosedProvisioningModel(
    closedModelWithExpectedInputs([
      { inputId: "shared-input", domain: "binding", adapterId: "kubernetes", extensions: [".yaml"] },
      { inputId: "shared-input", domain: "demand", adapterId: "typescript", extensions: [".ts"] },
    ]),
    createBuilder().builder,
  );
  assert.equal(duplicateInputId.model, undefined);
  assert.equal(duplicateInputId.diagnostics.some(
    /**
     * Recognizes the fixed duplicate-candidate diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True for duplicate-candidate.
     * Does not handle: Comparing the duplicate values themselves.
     * Side effects: None.
     */
    ({ code }) => code === "duplicate-candidate"
  ), true);
});

test("Core bridge preserves expected coverage input IDs for closed-model completion",
  /**
   * Verifies the Core bridge preserves expected-input identity and normalized extension detail.
   *
   * Inputs: Node's test runner and one valid expected-input fixture.
   * Outputs: Assertions over the Core materialized closed-model scope.
   * Does not handle: Adapter discovery or missing-input completion behavior.
   * Side effects: Instantiates a local fact factory, parses a fixture, and asserts results.
   */
  () => {
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

test("oversized binding candidates stop before indexed entries and retain one unknown-scope gap",
  /**
   * Verifies an oversized candidates array is rejected before its guarded final getter is read.
   *
   * Inputs: Node's test runner and an array one entry beyond the raw-entry budget.
   * Outputs: Assertions over the sole overflow diagnostic, unknown-scope gap, and absent captures.
   * Does not handle: Boundary behavior for normal-sized candidate arrays.
   * Side effects: Defines a test getter, parses local data, and performs assertions.
   */
  () => {
  const candidates = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(candidates, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
    /**
     * Fails the test if parser indexing crosses the configured raw-entry boundary.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Returning a candidate fixture.
     * Side effects: Throws a test-only error.
     */
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

test("oversized inventory items retain no snapshot and emit one fixed incomplete gap",
  /**
   * Verifies oversized inventory input fails closed before snapshot materialization.
   *
   * Inputs: Node's test runner and an inventory item array beyond the raw-entry limit.
   * Outputs: Assertions over omitted snapshot, fixed diagnostic, and one inventory gap.
   * Does not handle: Boundary behavior for valid inventory items.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
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

test("a nested closed-model selector flood is discarded before any model materialization",
  /**
   * Verifies a nested stage array flood aborts the whole closed-model parse before builder use.
   *
   * Inputs: Node's test runner and a model fixture with an oversized stage predicate.
   * Outputs: Assertions over absent model, fixed overflow diagnostic, and no captured models.
   * Does not handle: Independent top-level overflow paths.
   * Side effects: Defines a test getter, parses local data, and performs assertions.
   */
  () => {
  const { builder, captured } = createBuilder();
  const oversizedStages = new Array<unknown>(MAX_PROVISIONING_RAW_ENTRIES + 1);
  Object.defineProperty(oversizedStages, MAX_PROVISIONING_RAW_ENTRIES, {
    enumerable: true,
    /**
     * Fails the test if nested selector traversal reads beyond the raw-entry limit.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying a stage value.
     * Side effects: Throws a test-only error.
     */
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

test("raw entry accounting is shared across nested arrays and stops before the next getter",
  /**
   * Verifies shared raw-entry accounting carries from a stage array into selector unit IDs.
   *
   * Inputs: Node's test runner and nested arrays positioned at the remaining budget boundary.
   * Outputs: Assertions over fixed overflow and no materialized candidate.
   * Does not handle: Normal nested-array parsing below the boundary.
   * Side effects: Builds fixture arrays, defines a test getter, parses data, and asserts.
   */
  () => {
  const stages = Array.from(
    { length: MAX_PROVISIONING_RAW_ENTRIES - 1 },
    /**
     * Produces one deterministic stage fixture label from its index.
     *
     * Inputs: The ignored array element and its numeric index.
     * Outputs: A stage label string.
     * Does not handle: Stage grammar validation or deployment lookup.
     * Side effects: Allocates the returned string.
     */
    (_, index) => "stage" + String(index),
  );
  const executionUnitIds = new Array<unknown>(1);
  Object.defineProperty(executionUnitIds, 0, {
    enumerable: true,
    /**
     * Fails the test if shared budget accounting reads the next nested selector entry.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying a unit ID.
     * Side effects: Throws a test-only error.
     */
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

test("closed models cap finite key domains at 100 before Core materialization",
  /**
   * Verifies an excessive finite-key cap is rejected before the Core builder receives a model.
   *
   * Inputs: Node's test runner and a closed-model fixture with cap 101.
   * Outputs: Assertions over omitted model, fixed diagnostic, and absent captures.
   * Does not handle: Boundary acceptance at the maximum cap.
   * Side effects: Parses local fixtures and performs assertions.
   */
  () => {
  const { builder, captured } = createBuilder();
  const result = parseClosedProvisioningModel(
    { ...closedModelWithExpectedInputs([]), maxFiniteKeyDomain: 101 },
    builder,
  );

  assert.equal(result.model, undefined);
  assert.equal(result.diagnostics.some(
    /**
     * Recognizes the fixed maximum-domain diagnostic.
     *
     * Inputs: One safe diagnostic record.
     * Outputs: True for model-domain-over-budget.
     * Does not handle: Inspecting domain keys.
     * Side effects: None.
     */
    ({ code }) => code === "model-domain-over-budget"
  ), true);
  assert.equal(captured.models.length, 0);
});
