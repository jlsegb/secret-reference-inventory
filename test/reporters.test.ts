import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcile,
  resolveBindingCandidates,
  type BindingCandidate,
  type DemandEdge,
  type DynamicLookupEdge,
  type ExecutionScope,
  type InventorySnapshot,
  type LogicalKey,
  type ReconciliationResult,
  type SafeDiagnosticCode,
  type SafeIdentifier,
  type SafePath,
  type SafeTimestamp,
  type SecretReference,
} from "../src/core/index.js";
import {
  buildSarif,
  renderExplain,
  renderJson,
  renderSarif,
  renderTerminal,
  type ReportingInput,
} from "../src/reporters/index.js";

const id = (value: string): SafeIdentifier => value as SafeIdentifier;
const code = (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const path = (value: string): SafePath => value as SafePath;
const timestamp = (value: string): SafeTimestamp => value as SafeTimestamp;

function key(name: string): LogicalKey {
  return { namespace: "env", name: id(name) };
}

function scope(name: string): ExecutionScope {
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

function binding(target: ExecutionScope, destination: LogicalKey, resource: string): BindingCandidate {
  return {
    id: id(`binding-${target.id}-${destination.name}`),
    adapterId: id("fixture"),
    scope: target,
    destination,
    sourceKind: "secret-manager",
    providerResourceId: { authorityId: id("authority-a"), canonicalId: id(resource) },
    appliesWhen: selector(target),
    precedence: { source: id("fixture"), rank: 1, comparable: true },
    resolution: "exact",
  };
}

function reference(referenceId: string, destination: LogicalKey, file: string): SecretReference {
  return {
    id: id(referenceId),
    requested: destination,
    demand: "direct-read",
    operation: "read",
    resolution: "literal",
    confidence: "high",
    location: {
      file: path(file),
      start: { line: 0, column: 0 },
      end: { line: 0, column: 12 },
    },
    exposure: "server",
    evidenceChain: [
      {
        ruleId: id("ENV_READ"),
        diagnosticCode: code("CORE_ENV_READ"),
        locations: [
          {
            file: path(file),
            start: { line: 0, column: 0 },
            end: { line: 0, column: 12 },
          },
        ],
      },
    ],
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

function fixture(): ReportingInput {
  const api = scope("api");
  const worker = scope("worker");
  const database = key("DATABASE_URL");
  const patternKey = key("SERVICE_US");
  const legacyKey = key("LEGACY_TOKEN");
  const workerLegacyKey = key("WORKER_LEGACY_TOKEN");
  const candidates = [
    binding(api, database, "api-database"),
    binding(worker, database, "worker-database"),
    binding(worker, patternKey, "worker-service"),
    binding(api, legacyKey, "api-legacy"),
    binding(worker, workerLegacyKey, "worker-legacy"),
  ];
  const references = [
    reference("reference-api-database", database, "src/api.ts"),
    reference("reference-worker-database", database, "src/worker.ts"),
    reference("reference-finite", key("FINITE_A"), "src/dynamic.ts"),
    reference("reference-pattern", key("SERVICE_US"), "src/dynamic.ts"),
    reference("reference-unbounded", key("UNBOUNDED_INPUT_KEY"), "src/dynamic.ts"),
  ];
  const dynamic: DynamicLookupEdge[] = [
    {
      id: id("dynamic-finite"),
      referenceId: id("reference-finite"),
      scope: api,
      domain: { kind: "finite", keys: [id("FINITE_A"), id("FINITE_B")] },
      origin: "lexical",
      likelyKeys: [key("FINITE_A"), key("FINITE_B")],
      evidenceChain: [],
    },
    {
      id: id("dynamic-pattern"),
      referenceId: id("reference-pattern"),
      scope: worker,
      domain: {
        kind: "pattern",
        pattern: { kind: "prefix", patternId: id("pattern-service"), prefix: id("SERVICE_") },
      },
      origin: "lexical",
      patternConstraint: "not-proven",
      likelyKeys: [],
      evidenceChain: [],
    },
    {
      id: id("dynamic-unbounded"),
      referenceId: id("reference-unbounded"),
      scope: api,
      domain: { kind: "unbounded", reason: "user-controlled" },
      origin: "user-controlled",
      likelyKeys: [],
      evidenceChain: [],
    },
  ];
  const inventory: InventorySnapshot = {
    authorityId: id("authority-a"),
    asOf: timestamp("2026-07-12T00:00:00Z"),
    items: candidates.flatMap((candidate) =>
      candidate.providerResourceId === undefined
        ? []
        : [{ providerResourceId: candidate.providerResourceId, declaredScopes: [candidate.scope] }],
    ),
  };
  return {
    references,
    demandEdges: [
      demand(api, "reference-api-database"),
      demand(worker, "reference-worker-database"),
    ],
    result: reconcile({
      references,
      demandEdges: [
        demand(api, "reference-api-database"),
        demand(worker, "reference-worker-database"),
      ],
      dynamicLookupEdges: dynamic,
      bindingCandidates: candidates,
      bindingResolutions: resolveBindingCandidates(candidates),
      inventorySnapshots: [inventory],
    }),
  };
}

test("terminal and versioned JSON group sources deterministically and mark shared use", () => {
  const input = fixture();
  const first = renderJson(input);
  const second = renderJson(input);
  assert.equal(first, second);

  const parsed = JSON.parse(first) as {
    schemaVersion: string;
    groups: Array<{ key: { name: string }; shared: boolean; consumers: unknown[]; sources: unknown[] }>;
  };
  assert.equal(parsed.schemaVersion, "secret-reference-inventory/report/v1");
  const database = parsed.groups.find((group) => group.key.name === "DATABASE_URL");
  assert.equal(database?.shared, true);
  assert.equal(database?.consumers.length, 2);
  assert.equal(database?.sources.length, 2);

  const terminal = renderTerminal(input);
  assert.match(terminal, /Secret reference inventory/);
  assert.match(terminal, /DATABASE_URL/);
  assert.match(terminal, /shared/);
  assert.match(terminal, /Sources/);
  assert.match(terminal, /src\/api\.ts:1:1/);
});

test("dynamic output distinguishes finite/pattern likely keys from unbounded user-controlled lookups", () => {
  const input = fixture();
  const parsed = JSON.parse(renderJson(input)) as {
    dynamicLookups: Array<{
      id: string;
      domain: { kind: string };
      likelyKeys: Array<{ name: string }>;
      origin: string;
    }>;
  };
  const finite = parsed.dynamicLookups.find((lookup) => lookup.id === "dynamic-finite");
  assert.deepEqual(finite?.likelyKeys.map((item) => item.name), ["FINITE_A", "FINITE_B"]);
  const pattern = parsed.dynamicLookups.find((lookup) => lookup.id === "dynamic-pattern");
  assert.deepEqual(pattern?.likelyKeys.map((item) => item.name), ["SERVICE_US"]);
  const unbounded = parsed.dynamicLookups.find((lookup) => lookup.id === "dynamic-unbounded");
  assert.equal(unbounded?.domain.kind, "unbounded");
  assert.deepEqual(unbounded?.likelyKeys, []);

  const terminal = renderTerminal(input);
  assert.match(terminal, /no key names inferred/);
  assert.doesNotMatch(terminal, /UNBOUNDED_INPUT_KEY/);

  const sarif = buildSarif(input);
  assert.equal(sarif.version, "2.1.0");
  const userControlled = sarif.runs[0]?.results.find((result) => result.ruleId === "SRI005");
  assert.match(userControlled?.message.text ?? "", /no key name is inferred/);
  assert.doesNotMatch(JSON.stringify(userControlled), /UNBOUNDED_INPUT_KEY/);
});

test("SARIF and explain output retain typed axes and safe evidence chains", () => {
  const input = fixture();
  const sarifText = renderSarif(input);
  assert.match(sarifText, /SRI001/);
  assert.match(sarifText, /inventory-listed-no-static-read/);
  assert.match(sarifText, /"axes"/);
  assert.doesNotMatch(sarifText, /source snippets/i);

  const explain = renderExplain(input, { kind: "key", key: key("DATABASE_URL") });
  assert.match(explain, /Explain env:DATABASE_URL/);
  assert.match(explain, /Sources/);
  assert.match(explain, /ENV_READ/);

  const dynamicExplain = renderExplain(input, { kind: "dynamic", id: id("dynamic-unbounded") });
  assert.match(dynamicExplain, /unbounded environment lookup/);
  assert.doesNotMatch(dynamicExplain, /UNBOUNDED_INPUT_KEY/);
});

test("reporters redact malformed branded identifiers and paths rather than leaking sentinel text", () => {
  const sentinel = "sk_live_51Jf2QfZxR3AqVbC8NwY";
  const entropySentinel = "Q7mP2xR9vL4cN8aK5zT1wH6dB3yF0jS";
  const unsafeScope = {
    id: sentinel as SafeIdentifier,
    componentId: entropySentinel as SafeIdentifier,
    phase: "runtime" as const,
    stage: { kind: "exact" as const, values: [id("production")] },
    channel: "environment" as const,
  };
  const unsafeReference: SecretReference = {
    id: entropySentinel as SafeIdentifier,
    requested: { namespace: "env", name: entropySentinel as SafeIdentifier },
    demand: "direct-read",
    operation: "read",
    resolution: "literal",
    confidence: "high",
    location: {
      file: sentinel as SafePath,
      start: { line: 0, column: 0 },
      end: { line: 0, column: 1 },
    },
    exposure: "server",
    evidenceChain: [],
  };
  const result: ReconciliationResult = {
    records: [
      {
        kind: "demand",
        scope: unsafeScope,
        key: unsafeReference.requested,
        referenceIds: [unsafeReference.id],
        targetDiscovery: "deployable",
        demand: "present",
        binding: "no-static-evidence",
        inventory: "missing",
        coverage: "complete",
        constraint: "none",
        disposition: "review",
        reasons: [],
      },
    ],
    scopeCoverage: [],
  };
  const input: ReportingInput = { result, references: [unsafeReference] };
  const output = `${renderTerminal(input)}${renderJson(input)}${renderSarif(input)}${renderExplain(input, {
    kind: "key",
    key: { namespace: "env", name: entropySentinel as SafeIdentifier },
  })}`;
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.doesNotMatch(output, new RegExp(entropySentinel));
  assert.match(output, /<opaque>/);
  assert.match(output, /<opaque-path>/);
});
