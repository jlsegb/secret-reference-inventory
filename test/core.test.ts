import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcile,
  resolveBindingCandidates,
  type BindingCandidate,
  type ClosedProvisioningModel,
  type CoverageGap,
  type CoverageInputStatus,
  type DemandEdge,
  type DynamicLookupEdge,
  type ExecutionScope,
  type InventorySnapshot,
  type LogicalKey,
  type SafeIdentifier,
  type SafeDiagnosticCode,
  type SafePath,
  type SafeTimestamp,
  type SecretReference,
} from "../src/core/index.js";

const id = (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnosticCode = (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const path = (value: string): SafePath => value as SafePath;
const timestamp = (value: string): SafeTimestamp => value as SafeTimestamp;

function key(name: string): LogicalKey {
  return { namespace: "env", name: id(name) };
}

function scope(name = "api"): ExecutionScope {
  return {
    id: id(name),
    componentId: id(name),
    phase: "runtime",
    stage: { kind: "exact", values: [id("production")] },
    channel: "environment",
  };
}

function selector(target: ExecutionScope): BindingCandidate["appliesWhen"] {
  return {
    executionUnitIds: [target.id],
    phases: [target.phase],
    stage: target.stage,
    channels: [target.channel],
    condition: { kind: "always" },
  };
}

function candidate(
  target: ExecutionScope,
  destination: LogicalKey,
  resource = String(destination.name),
  rank = 1,
): BindingCandidate {
  return {
    id: id(`binding-${target.id}-${String(destination.name)}-${rank}`),
    adapterId: id("fixture"),
    scope: target,
    destination,
    sourceKind: "secret-manager",
    providerResourceId: {
      authorityId: id("authority-a"),
      canonicalId: id(resource),
    },
    appliesWhen: selector(target),
    precedence: { source: id("fixture"), rank, comparable: true },
    resolution: "exact",
  };
}

function reference(name: string, referenceId = `reference-${name}`): SecretReference {
  return {
    id: id(referenceId),
    requested: key(name),
    demand: "direct-read",
    operation: "read",
    resolution: "literal",
    confidence: "high",
    location: {
      file: path("src/app.ts"),
      start: { line: 1, column: 0 },
      end: { line: 1, column: 10 },
    },
    exposure: "server",
    evidenceChain: [],
  };
}

function demand(target: ExecutionScope, referenceId: string): DemandEdge {
  return {
    id: id(`demand-${target.id}-${referenceId}`),
    referenceId: id(referenceId),
    scope: target,
    origin: "direct",
    evidenceChain: [],
  };
}

function inventory(...candidates: readonly BindingCandidate[]): InventorySnapshot {
  return {
    authorityId: id("authority-a"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: candidates.flatMap((item) =>
      item.providerResourceId === undefined
        ? []
        : [{ providerResourceId: item.providerResourceId, declaredScopes: [item.scope] }],
    ),
  };
}

function reconcileFacts(input: {
  readonly references?: readonly SecretReference[];
  readonly demandEdges?: readonly DemandEdge[];
  readonly dynamicLookupEdges?: readonly DynamicLookupEdge[];
  readonly candidates: readonly BindingCandidate[];
  readonly snapshots?: readonly InventorySnapshot[];
  readonly coverageGaps?: readonly CoverageGap[];
  readonly coverageInputs?: readonly CoverageInputStatus[];
  readonly closedModel?: ClosedProvisioningModel;
}) {
  return reconcile({
    references: input.references ?? [],
    demandEdges: input.demandEdges ?? [],
    ...(input.dynamicLookupEdges === undefined
      ? {}
      : { dynamicLookupEdges: input.dynamicLookupEdges }),
    bindingCandidates: input.candidates,
    bindingResolutions: resolveBindingCandidates(input.candidates),
    inventorySnapshots: input.snapshots ?? [],
    ...(input.coverageGaps === undefined ? {} : { coverageGaps: input.coverageGaps }),
    ...(input.coverageInputs === undefined ? {} : { coverageInputs: input.coverageInputs }),
    ...(input.closedModel === undefined ? {} : { closedModel: input.closedModel }),
  });
}

test("typed demand/binding/inventory joins preserve provisioned-but-unread resources", () => {
  const api = scope();
  const database = candidate(api, key("DATABASE_URL"));
  const legacy = candidate(api, key("LEGACY_API_KEY"));
  const databaseReference = reference("DATABASE_URL");

  const result = reconcileFacts({
    references: [databaseReference],
    demandEdges: [demand(api, "reference-DATABASE_URL")],
    candidates: [database, legacy],
    snapshots: [inventory(database, legacy)],
  });

  const databaseDemand = result.records.find(
    (record) => record.kind === "demand" && record.key.name === "DATABASE_URL",
  );
  assert.equal(databaseDemand?.binding, "exact-declared");
  assert.equal(databaseDemand?.inventory, "bound");
  assert.equal(
    databaseDemand?.kind === "demand" && "items" in databaseDemand.inventorySnapshot!,
    false,
  );

  const legacyInventory = result.records.find(
    (record) =>
      record.kind === "inventory" &&
      record.providerResourceId.canonicalId === "LEGACY_API_KEY",
  );
  assert.equal(legacyInventory?.inventory, "inventory-listed-no-static-read");
  assert.equal(legacyInventory?.disposition, "review");
});

test("Core indexes 10k distinct slots and matching/nonmatching inventory without pairwise scans", () => {
  const api = scope();
  const count = 10_000;
  const matching = Array.from({ length: count / 2 }, (_, index) =>
    candidate(api, key("MATCHING_KEY_" + String(index)), "matching-resource-" + String(index)),
  );
  const legacy = Array.from({ length: count / 2 }, (_, index) =>
    candidate(api, key("LEGACY_KEY_" + String(index)), "legacy-resource-" + String(index)),
  );
  const references = matching.map((entry, index) =>
    reference(String(entry.destination.name), "reference-matching-" + String(index)),
  );
  const demandEdges = references.map((entry) => demand(api, String(entry.id)));
  const started = Date.now();
  const result = reconcileFacts({
    references,
    demandEdges,
    candidates: [...matching, ...legacy],
    snapshots: [inventory(...matching, ...legacy)],
  });
  const elapsed = Date.now() - started;

  assert.equal(
    result.records.filter((record) => record.kind === "demand").length,
    matching.length,
  );
  assert.equal(
    result.records.filter((record) => record.kind === "inventory").length,
    count,
  );
  const firstMatchingDemand = result.records.find(
    (record) => record.kind === "demand" && record.key.name === "MATCHING_KEY_0",
  );
  assert.equal(firstMatchingDemand?.binding, "exact-declared");
  assert.equal(firstMatchingDemand?.inventory, "bound");
  const firstLegacyInventory = result.records.find(
    (record) =>
      record.kind === "inventory" &&
      record.providerResourceId.canonicalId === "legacy-resource-0",
  );
  assert.equal(firstLegacyInventory?.inventory, "inventory-listed-no-static-read");
  // This catches a regression to the former 10k × 10k candidate/item walk
  // without making timing the source of correctness.
  assert.ok(elapsed < 5_000, "expected indexed reconciliation, received " + String(elapsed) + "ms");
});

test("finite dynamic keys block only their own inventory candidates", () => {
  const api = scope();
  const first = candidate(api, key("FIRST_KEY"));
  const second = candidate(api, key("SECOND_KEY"));
  const legacy = candidate(api, key("LEGACY_KEY"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-finite"),
    referenceId: id("reference-dynamic-finite"),
    scope: api,
    domain: { kind: "finite", keys: [id("FIRST_KEY"), id("SECOND_KEY")] },
    origin: "lexical",
    likelyKeys: [key("FIRST_KEY"), key("SECOND_KEY")],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [first, second, legacy],
    snapshots: [inventory(first, second, legacy)],
  });

  const firstDemand = result.records.find(
    (record) => record.kind === "demand" && record.key.name === "FIRST_KEY",
  );
  assert.equal(firstDemand?.demand, "finite-dynamic");
  assert.equal(firstDemand?.inventory, "bound");

  const legacyInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "LEGACY_KEY",
  );
  assert.equal(legacyInventory?.inventory, "inventory-listed-no-static-read");
});

test("pattern dynamic keys only affect matching binding destinations", () => {
  const worker = scope("worker");
  const service = candidate(worker, key("SERVICE_US"));
  const unrelated = candidate(worker, key("DATABASE_URL"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-service"),
    referenceId: id("reference-dynamic-service"),
    scope: worker,
    domain: {
      kind: "pattern",
      pattern: { kind: "prefix", patternId: id("pattern-service"), prefix: id("SERVICE_") },
    },
    origin: "user-controlled",
    patternConstraint: "not-proven",
    likelyKeys: [],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [service, unrelated],
    snapshots: [inventory(service, unrelated)],
  });

  const serviceInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "SERVICE_US",
  );
  assert.equal(serviceInventory?.inventory, "bound");

  const unrelatedInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "DATABASE_URL",
  );
  assert.equal(unrelatedInventory?.inventory, "inventory-listed-no-static-read");
});

test("unbounded user-controlled lookup is scoped and never turns every key into demand", () => {
  const api = scope("api");
  const worker = scope("worker");
  const apiLegacy = candidate(api, key("API_LEGACY"));
  const workerLegacy = candidate(worker, key("WORKER_LEGACY"));
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-unbounded"),
    referenceId: id("reference-dynamic-unbounded"),
    scope: api,
    domain: { kind: "unbounded", reason: "user-controlled" },
    origin: "user-controlled",
    likelyKeys: [],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [apiLegacy, workerLegacy],
    snapshots: [inventory(apiLegacy, workerLegacy)],
  });

  const apiInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "API_LEGACY",
  );
  assert.equal(apiInventory?.inventory, "unknown");
  assert.equal(apiInventory?.disposition, "inconclusive");

  const workerInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "WORKER_LEGACY",
  );
  assert.equal(workerInventory?.inventory, "inventory-listed-no-static-read");
});

test("coverage gaps are scoped and prevent only affected absence conclusions", () => {
  const api = scope("api");
  const worker = scope("worker");
  const apiLegacy = candidate(api, key("API_LEGACY"));
  const workerLegacy = candidate(worker, key("WORKER_LEGACY"));
  const apiGap: CoverageGap = {
    id: id("gap-api-source"),
    domain: "demand",
    inputId: id("source-root"),
    pathOrAdapterId: path("apps/api/broken.ts"),
    potentiallyAffects: selector(api),
    keyDomain: { kind: "all-environment" },
    reason: diagnosticCode("CORE_PARSE_FAILURE"),
  };

  const result = reconcileFacts({
    candidates: [apiLegacy, workerLegacy],
    snapshots: [inventory(apiLegacy, workerLegacy)],
    coverageGaps: [apiGap],
  });

  const apiInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "API_LEGACY",
  );
  assert.equal(apiInventory?.inventory, "unknown");
  assert.equal(apiInventory?.disposition, "inconclusive");

  const workerInventory = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "WORKER_LEGACY",
  );
  assert.equal(workerInventory?.inventory, "inventory-listed-no-static-read");
});

test("key-bounded coverage uncertainty does not suppress unrelated legacy candidates", () => {
  const api = scope();
  const affected = candidate(api, key("AFFECTED_KEY"));
  const unrelated = candidate(api, key("UNRELATED_KEY"));
  const gap: CoverageGap = {
    id: id("gap-one-key"),
    domain: "demand",
    inputId: id("source-root"),
    pathOrAdapterId: path("apps/api/dynamic.ts"),
    potentiallyAffects: selector(api),
    keyDomain: { kind: "keys", keys: [key("AFFECTED_KEY")] },
    reason: diagnosticCode("CORE_DYNAMIC_KEY"),
  };

  const result = reconcileFacts({
    candidates: [affected, unrelated],
    snapshots: [inventory(affected, unrelated)],
    coverageGaps: [gap],
  });
  const affectedRecord = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "AFFECTED_KEY",
  );
  assert.equal(affectedRecord?.inventory, "unknown");

  const unrelatedRecord = result.records.find(
    (record) => record.kind === "inventory" && record.providerResourceId.canonicalId === "UNRELATED_KEY",
  );
  assert.equal(unrelatedRecord?.inventory, "inventory-listed-no-static-read");
});

test("typed provider identity prevents same-name cross-authority inventory joins", () => {
  const api = scope();
  const database = candidate(api, key("DATABASE_URL"));
  const databaseReference = reference("DATABASE_URL");
  const differentAuthority: InventorySnapshot = {
    authorityId: id("authority-b"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: [
      {
        providerResourceId: {
          authorityId: id("authority-b"),
          canonicalId: id("DATABASE_URL"),
        },
      },
    ],
  };

  const result = reconcileFacts({
    references: [databaseReference],
    demandEdges: [demand(api, "reference-DATABASE_URL")],
    candidates: [database],
    snapshots: [differentAuthority],
  });

  const record = result.records.find((item) => item.kind === "demand");
  assert.equal(record?.binding, "exact-declared");
  assert.equal(record?.inventory, "missing");
});

test("an external binding without a provider identity stays inventory-unknown", () => {
  const api = scope();
  const mapped = candidate(api, key("EXTERNAL_TOKEN"));
  const { providerResourceId: _providerResourceId, ...withoutResource } = mapped;
  const external: BindingCandidate = {
    ...withoutResource,
    sourceKind: "external",
  };
  const externalReference = reference("EXTERNAL_TOKEN");

  const result = reconcileFacts({
    references: [externalReference],
    demandEdges: [demand(api, "reference-EXTERNAL_TOKEN")],
    candidates: [external],
  });
  const record = result.records.find((item) => item.kind === "demand");
  assert.equal(record?.binding, "exact-declared");
  assert.equal(record?.inventory, "unknown");
  assert.equal(record?.disposition, "inconclusive");
});

test("missing-under-declared-model requires explicit completed closed-model evidence", () => {
  const api = scope();
  const missingReference = reference("MISSING_KEY");
  const sourceInput = id("source-input");
  const bindingInput = id("binding-input");
  const inventoryInput = id("inventory-input");
  const complete = (inputId: SafeIdentifier, domain: CoverageInputStatus["domain"]): CoverageInputStatus => ({
    inputId,
    domain,
    state: "complete",
    selector: selector(api),
  });
  const closedModel: ClosedProvisioningModel = {
    schemaVersion: id("closed-model-v1"),
    scopes: [
      {
        selector: selector(api),
        closed: true,
        coverage: {
          modelInputId: id("model-input"),
          maxFiniteKeyDomain: 32,
          approvedFirstPartyRoots: [path("apps/api")],
          bindingRoots: [path("deploy")],
          expectedInputs: [
            { inputId: sourceInput, domain: "demand" },
            { inputId: bindingInput, domain: "binding" },
            { inputId: inventoryInput, domain: "inventory" },
          ],
          permittedExclusions: [],
          inventoryAuthorities: [
            { authorityId: id("authority-a"), inventoryInputId: inventoryInput },
          ],
          allowedExternalMechanisms: [],
          outsideRootImports: "out-of-scope",
        },
      },
    ],
  };
  const authoritativeEmptyInventory: InventorySnapshot = {
    inputId: inventoryInput,
    authorityId: id("authority-a"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: [],
  };

  const result = reconcileFacts({
    references: [missingReference],
    demandEdges: [demand(api, "reference-MISSING_KEY")],
    candidates: [],
    snapshots: [authoritativeEmptyInventory],
    coverageInputs: [
      complete(sourceInput, "demand"),
      complete(bindingInput, "binding"),
      complete(inventoryInput, "inventory"),
    ],
    closedModel,
  });
  const record = result.records.find((item) => item.kind === "demand");
  assert.equal(record?.inventory, "missing-under-declared-model");
});

test("precedence resolves a winner and keeps the lower-ranked source shadowed", () => {
  const api = scope();
  const lower = candidate(api, key("API_KEY"), "low-resource", 1);
  const higher = candidate(api, key("API_KEY"), "high-resource", 2);

  const [resolution] = resolveBindingCandidates([lower, higher]);
  assert.equal(resolution?.partitions[0]?.outcome, "effective");
  const selections = resolution?.partitions[0]?.selections ?? [];
  assert.equal(selections.find((item) => item.candidateId === higher.id)?.status, "effective");
  assert.equal(selections.find((item) => item.candidateId === lower.id)?.status, "shadowed");
});

test("finite conditional branches resolve their own precedence winners", () => {
  const api = scope();
  const fallback = candidate(api, key("API_KEY"), "fallback-resource", 10);
  const mainOverride: BindingCandidate = {
    ...candidate(api, key("API_KEY"), "main-resource", 20),
    appliesWhen: {
      ...selector(api),
      condition: {
        kind: "all",
        clauses: [{ key: id("BRANCH"), operator: "equals", value: id("main") }],
      },
    },
  };

  const [resolution] = resolveBindingCandidates([fallback, mainOverride]);
  const mainPartition = resolution?.partitions.find(
    (partition) =>
      partition.appliesWhen.condition.kind === "all" &&
      partition.appliesWhen.condition.clauses.some(
        (clause) => clause.operator === "equals" && clause.key === "BRANCH" && clause.value === "main",
      ),
  );
  const otherPartition = resolution?.partitions.find(
    (partition) =>
      partition.appliesWhen.condition.kind === "all" &&
      partition.appliesWhen.condition.clauses.some(
        (clause) => clause.operator === "not-equals" && clause.key === "BRANCH" && clause.value === "main",
      ),
  );

  assert.equal(mainPartition?.outcome, "effective");
  assert.equal(
    mainPartition?.selections.find((selection) => selection.candidateId === mainOverride.id)?.status,
    "effective",
  );
  assert.equal(
    mainPartition?.selections.find((selection) => selection.candidateId === fallback.id)?.status,
    "shadowed",
  );
  assert.equal(otherPartition?.outcome, "effective");
  assert.equal(
    otherPartition?.selections.find((selection) => selection.candidateId === fallback.id)?.status,
    "effective",
  );
  assert.equal(
    otherPartition?.selections.find((selection) => selection.candidateId === mainOverride.id)?.status,
    "inapplicable",
  );

  const apiKeyReference = reference("API_KEY");
  const result = reconcileFacts({
    references: [apiKeyReference],
    demandEdges: [demand(api, "reference-API_KEY")],
    candidates: [fallback, mainOverride],
    snapshots: [inventory(fallback, mainOverride)],
  });
  const demandRecord = result.records.find((record) => record.kind === "demand");
  assert.equal(demandRecord?.binding, "exact-declared");
  // The code read has no branch context, so two provider identities must not
  // collapse into a single claimed inventory relation.
  assert.equal(demandRecord?.inventory, "unknown");
});

test("malformed dynamic facts become conservative scoped uncertainty", () => {
  const api = scope();
  const candidateOne = candidate(api, key("A_KEY"));
  const invalid: DynamicLookupEdge = {
    id: id("dynamic-invalid"),
    referenceId: id("reference-dynamic-invalid"),
    scope: api,
    domain: { kind: "finite", keys: [id("A_KEY")] },
    origin: "lexical",
    likelyKeys: [key("OTHER_KEY")],
    evidenceChain: [],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [invalid],
    candidates: [candidateOne],
    snapshots: [inventory(candidateOne)],
  });
  const inventoryRecord = result.records.find((record) => record.kind === "inventory");
  assert.equal(inventoryRecord?.inventory, "unknown");
  assert.equal(inventoryRecord?.disposition, "inconclusive");
});

test("conflicting adapter-proven pattern domains downgrade to unbounded uncertainty", () => {
  const api = scope();
  const dynamic: DynamicLookupEdge = {
    id: id("dynamic-pattern-conflict"),
    referenceId: id("reference-pattern-conflict"),
    scope: api,
    domain: {
      kind: "pattern",
      pattern: { kind: "prefix", patternId: id("service-pattern"), prefix: id("SERVICE_") },
    },
    origin: "lexical",
    patternConstraint: "adapter-proven",
    likelyKeys: [key("SERVICE_BLUE")],
    evidenceChain: [],
  };
  const model: ClosedProvisioningModel = {
    schemaVersion: id("closed-model-v1"),
    scopes: [],
    finitePatternDomains: [
      {
        patternId: id("service-pattern"),
        scope: selector(api),
        keys: [key("SERVICE_BLUE")],
        constraint: "adapter-proven",
      },
      {
        patternId: id("service-pattern"),
        scope: selector(api),
        keys: [key("SERVICE_GREEN")],
        constraint: "adapter-proven",
      },
    ],
  };

  const result = reconcileFacts({
    dynamicLookupEdges: [dynamic],
    candidates: [],
    closedModel: model,
  });
  const record = result.records.find((candidate) => candidate.kind === "dynamic");
  assert.equal(record?.lookup.domain.kind, "unbounded");
  if (record?.lookup.domain.kind === "unbounded") {
    assert.equal(record.lookup.domain.reason, "opaque");
  }
  assert.equal(
    record?.reasons.some((reason) => reason.code === "CORE_DYNAMIC_PATTERN_DOMAIN_CONFLICT"),
    true,
  );
});
