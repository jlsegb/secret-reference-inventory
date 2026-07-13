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

const id = /**
 * Brands a fixture-only string as a safe identifier for controlled test data.
 *
 * Inputs: A literal fixture identifier string.
 * Outputs: The same value cast to SafeIdentifier.
 * Does not handle: Runtime identifier validation or production safety checks.
 * Side effects: None.
 */ (value: string): SafeIdentifier => value as SafeIdentifier;
const code = /**
 * Brands a fixture-only diagnostic string for controlled test data.
 *
 * Inputs: A literal fixture diagnostic code.
 * Outputs: The same value cast to SafeDiagnosticCode.
 * Does not handle: Runtime diagnostic validation or production safety checks.
 * Side effects: None.
 */ (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;
const path = /**
 * Brands a fixture-only relative path for controlled reporter input.
 *
 * Inputs: A literal safe fixture path.
 * Outputs: The same value cast to SafePath.
 * Does not handle: Filesystem validation, traversal checks, or production path safety.
 * Side effects: None.
 */ (value: string): SafePath => value as SafePath;
const timestamp = /**
 * Brands a fixture timestamp for controlled inventory-snapshot data.
 *
 * Inputs: A literal ISO-like fixture timestamp.
 * Outputs: The same value cast to SafeTimestamp.
 * Does not handle: Timestamp parsing, timezone conversion, or production validation.
 * Side effects: None.
 */ (value: string): SafeTimestamp => value as SafeTimestamp;

/**
 * Creates an environment logical-key fixture with a branded name.
 *
 * Inputs: A test key name.
 * Outputs: An env-namespace LogicalKey using the fixture id helper.
 * Does not handle: Namespace variants, key validation, or value lookup.
 * Side effects: None.
 */
function key(name: string): LogicalKey {
  return { namespace: "env", name: id(name) };
}

/**
 * Creates a runtime environment execution-scope fixture for one named consumer.
 *
 * Inputs: A test scope name.
 * Outputs: An exact-production runtime environment scope whose id and component id share that name.
 * Does not handle: Build/test scopes, nonenvironment delivery channels, or scope validation.
 * Side effects: None.
 */
function scope(name: string): ExecutionScope {
  return {
    id: id(name),
    componentId: id(name),
    phase: "runtime",
    stage: { kind: "exact", values: [id("production")] },
    channel: "environment",
  };
}

/**
 * Creates an always-applicable binding selector for the provided fixture scope.
 *
 * Inputs: One execution scope fixture.
 * Outputs: A binding appliesWhen predicate matching that scope's unit, phase, stage, and channel.
 * Does not handle: Conditional selectors, precedence, or multiple target scopes.
 * Side effects: None.
 */
function selector(target: ExecutionScope): BindingCandidate["appliesWhen"] {
  return {
    executionUnitIds: [target.id],
    phases: [target.phase],
    stage: target.stage,
    channels: [target.channel],
    condition: { kind: "always" },
  };
}

/**
 * Builds an exact secret-manager binding fixture for a scope/key/resource combination.
 *
 * Inputs: A target scope, logical destination key, and canonical provider resource suffix.
 * Outputs: One comparable exact BindingCandidate with fixed fixture authority and precedence.
 * Does not handle: Binding resolution, inventory snapshots, or conditional delivery.
 * Side effects: None.
 */
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

/**
 * Builds a direct-read source-reference fixture with one safe location and evidence entry.
 *
 * Inputs: Reference id, requested logical key, and relative source filename.
 * Outputs: A server-exposure literal SecretReference with fixed read semantics.
 * Does not handle: Dynamic references, multiple locations, or source parsing.
 * Side effects: None.
 */
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

/**
 * Creates a direct demand-edge fixture connecting a source reference to one scope.
 *
 * Inputs: Target execution scope and referenced source id.
 * Outputs: A direct DemandEdge with an empty fixture evidence chain.
 * Does not handle: Indirect demand, evidence construction, or source-reference validation.
 * Side effects: None.
 */
function demand(target: ExecutionScope, referenceId: string): DemandEdge {
  return {
    id: id(`demand-${target.id}-${referenceId}`),
    referenceId: id(referenceId),
    scope: target,
    origin: "direct",
    evidenceChain: [],
  };
}

/**
 * Assembles the common reconciliation fixture used by reporter rendering assertions.
 *
 * Inputs: None.
 * Outputs: ReportingInput containing shared, inventory-only, and dynamic lookup scenarios.
 * Does not handle: Filesystem discovery, adapter parsing, or provider access.
 * Side effects: Invokes the pure reconcile and binding-resolution helpers in memory.
 */
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
    items: candidates.flatMap(/**
     * Converts each fixture binding with a resource id into its inventory item.
     *
     * Inputs: One binding candidate from the fixture collection.
     * Outputs: A singleton declared-scope item or an empty array for resource-less bindings.
     * Does not handle: Snapshot validation, provider lookup, or duplicate resources.
     * Side effects: None.
     */ (candidate) =>
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

test("terminal and versioned JSON group sources deterministically and mark shared use", /**
 * Asserts stable source grouping, shared-consumer markers, and readable terminal evidence.
 *
 * Inputs: None; builds the common reporting fixture.
 * Outputs: A completed synchronous test after JSON and terminal assertions pass.
 * Does not handle: Dynamic lookup behavior, malformed values, or SARIF schema coverage.
 * Side effects: Invokes in-memory reconciliation and renderers only.
 */ () => {
  const input = fixture();
  const first = renderJson(input);
  const second = renderJson(input);
  assert.equal(first, second);

  const parsed = JSON.parse(first) as {
    schemaVersion: string;
    groups: Array<{ key: { name: string }; shared: boolean; consumers: unknown[]; sources: unknown[] }>;
  };
  assert.equal(parsed.schemaVersion, "secret-reference-inventory/report/v1");
  const database = parsed.groups.find(/**
   * Locates the shared database group in parsed fixture output.
   *
   * Inputs: One parsed JSON group.
   * Outputs: True when the group has the expected database key name.
   * Does not handle: Shared-use verification or source counting.
   * Side effects: None.
   */ (group) => group.key.name === "DATABASE_URL");
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

test("dynamic output distinguishes finite/pattern likely keys from unbounded user-controlled lookups", /**
 * Asserts that report formats distinguish bounded candidate keys from unbounded user-selected lookup state.
 *
 * Inputs: None; builds the common reporting fixture.
 * Outputs: A completed synchronous test after JSON, terminal, and SARIF assertions pass.
 * Does not handle: Binding precedence, inventory-only reporting, or malformed report input.
 * Side effects: Invokes in-memory reconciliation and renderers only.
 */ () => {
  const input = fixture();
  const parsed = JSON.parse(renderJson(input)) as {
    dynamicLookups: Array<{
      id: string;
      domain: { kind: string };
      likelyKeys: Array<{ name: string }>;
      origin: string;
    }>;
  };
  const finite = parsed.dynamicLookups.find(/**
   * Finds the finite dynamic fixture entry.
   *
   * Inputs: One parsed dynamic lookup.
   * Outputs: True for the fixture's finite lookup id.
   * Does not handle: Likely-key comparison or domain validation.
   * Side effects: None.
   */ (lookup) => lookup.id === "dynamic-finite");
  assert.deepEqual(finite?.likelyKeys.map(/**
   * Extracts a likely key name for sequence comparison.
   *
   * Inputs: One parsed likely-key object.
   * Outputs: Its name field.
   * Does not handle: Key sanitization or ordering.
   * Side effects: None.
   */ (item) => item.name), ["FINITE_A", "FINITE_B"]);
  const pattern = parsed.dynamicLookups.find(/**
   * Finds the pattern dynamic fixture entry.
   *
   * Inputs: One parsed dynamic lookup.
   * Outputs: True for the fixture's pattern lookup id.
   * Does not handle: Pattern-format validation or likely-key comparison.
   * Side effects: None.
   */ (lookup) => lookup.id === "dynamic-pattern");
  assert.deepEqual(pattern?.likelyKeys.map(/**
   * Extracts a pattern likely-key name for sequence comparison.
   *
   * Inputs: One parsed likely-key object.
   * Outputs: Its name field.
   * Does not handle: Key sanitization or ordering.
   * Side effects: None.
   */ (item) => item.name), ["SERVICE_US"]);
  const unbounded = parsed.dynamicLookups.find(/**
   * Finds the unbounded user-controlled dynamic fixture entry.
   *
   * Inputs: One parsed dynamic lookup.
   * Outputs: True for the fixture's unbounded lookup id.
   * Does not handle: Domain reason validation or source evidence inspection.
   * Side effects: None.
   */ (lookup) => lookup.id === "dynamic-unbounded");
  assert.equal(unbounded?.domain.kind, "unbounded");
  assert.deepEqual(unbounded?.likelyKeys, []);

  const terminal = renderTerminal(input);
  assert.match(terminal, /no key names inferred/);
  assert.doesNotMatch(terminal, /UNBOUNDED_INPUT_KEY/);

  const sarif = buildSarif(input);
  assert.equal(sarif.version, "2.1.0");
  const userControlled = sarif.runs[0]?.results.find(/**
   * Locates the SARIF result reserved for user-controlled dynamic lookups.
   *
   * Inputs: One SARIF result emitted by the fixture renderer.
   * Outputs: True for rule SRI005.
   * Does not handle: Severity, message, or location validation.
   * Side effects: None.
   */ (result) => result.ruleId === "SRI005");
  assert.match(userControlled?.message.text ?? "", /no key name is inferred/);
  assert.doesNotMatch(JSON.stringify(userControlled), /UNBOUNDED_INPUT_KEY/);
});

test("SARIF and explain output retain typed axes and safe evidence chains", /**
 * Asserts typed axes and safe evidence survive SARIF and explain rendering.
 *
 * Inputs: None; builds the common reporting fixture.
 * Outputs: A completed synchronous test after format-specific assertions pass.
 * Does not handle: Terminal grouping, redaction of malformed brands, or output file writes.
 * Side effects: Invokes in-memory reconciliation and renderers only.
 */ () => {
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

test("reporters redact malformed branded identifiers and paths rather than leaking sentinel text", /**
 * Verifies renderers recheck maliciously branded data before any textual serialization.
 *
 * Inputs: None; constructs an in-memory result containing credential-like and high-entropy strings.
 * Outputs: A completed synchronous test after all formats omit sentinels and include opaque markers.
 * Does not handle: File-output redaction or arbitrary secret-pattern coverage.
 * Side effects: Invokes in-memory report renderers only.
 */ () => {
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
