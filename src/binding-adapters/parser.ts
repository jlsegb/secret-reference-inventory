import {
  BINDING_MANIFEST_SCHEMA_VERSION,
  CLOSED_MODEL_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_SCHEMA_VERSION,
  type BindingAdapterDiagnostic,
  type BindingAdapterDiagnosticCode,
  type BindingAdapterFactBuilder,
  type BindingAdapterPath,
  type BindingManifestParseResult,
  type ClosedModelParseResult,
  type InventorySnapshotParseResult,
  type RawBindingCandidate,
  type RawBindingManifest,
  type RawClosedModelDomain,
  type RawClosedModelScope,
  type RawClosedProvisioningModel,
  type RawConditionClause,
  type RawConditionPredicate,
  type RawCoverageGap,
  type RawDeliveryChannel,
  type RawExecutionScope,
  type RawExpectedAdapterInput,
  type RawExternalMechanism,
  type RawInventoryAuthority,
  type RawInventoryItem,
  type RawInventorySnapshot,
  type RawLogicalKey,
  type RawLogicalNamespace,
  type RawPermittedExclusion,
  type RawPhase,
  type RawProviderResourceId,
  type RawScopeSelector,
  type RawStagePredicate,
} from "./contracts.js";
import { isSecretLikeToken } from "../safety/factory.js";
import {
  MAX_CLOSED_MODEL_FINITE_KEYS,
  createProvisioningBudget,
  reserveProvisioningArray,
  reserveProvisioningNormalizedEntries,
  reserveProvisioningRawEntries,
  type ProvisioningBudget,
} from "../safety/provisioning-budget.js";

type JsonRecord = Record<string, unknown>;

interface ParseState {
  readonly diagnostics: BindingAdapterDiagnostic[];
  readonly budget: ProvisioningBudget;
}

interface CandidateAttempt {
  readonly candidate?: RawBindingCandidate;
  readonly selector: RawScopeSelector;
}

const PHASES = new Set<RawPhase>(["runtime", "build", "test", "dev", "ci", "unknown"]);
const DELIVERY_CHANNELS = new Set<RawDeliveryChannel>([
  "environment",
  "build-substitution",
  "mounted-file",
  "provider-sdk",
  "unknown",
]);
const LOGICAL_NAMESPACES = new Set<RawLogicalNamespace>(["env", "config", "secret-manager"]);
const SOURCE_KINDS = new Set<RawBindingCandidate["sourceKind"]>([
  "manifest",
  "secret-manager",
  "external",
]);
const RESOLUTIONS = new Set<RawBindingCandidate["resolution"]>(["exact", "dynamic"]);
const CONDITION_OPERATORS = new Set<RawConditionClause["operator"]>([
  "equals",
  "not-equals",
]);
const COVERAGE_DOMAINS = new Set<RawExpectedAdapterInput["domain"]>([
  "demand",
  "binding",
  "inventory",
]);
const SAFE_COVERAGE_INPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const OVERFLOW_INPUT_ID = "provisioning-input-overflow";
const OVERFLOW_ADAPTER_ID = "provisioning-parser";

const UNKNOWN_SELECTOR: RawScopeSelector = Object.freeze({
  stage: Object.freeze({ kind: "unknown" }),
  condition: Object.freeze({ kind: "unknown" }),
});

/**
 * Parse a local binding manifest without evaluating a repository file, shell,
 * IaC expression, or provider.  Raw strings are handed only to `builder` and
 * never returned in this function's result.
 */
export function parseBindingManifest<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  input: unknown,
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): BindingManifestParseResult<TBindingCandidate, TCoverageGap> {
  const state = createState();
  const root = parseRootObject(input, state);
  const inputId = readStringOrFallback(root, "inputId", "binding-manifest", [], state);
  const adapterId = readStringOrFallback(root, "adapterId", "binding-manifest", [], state);
  const coverageGaps: TCoverageGap[] = [];
  const candidates: TBindingCandidate[] = [];

  if (isOverflowed(state)) {
    return bindingOverflowResult(builder);
  }

  if (
    root === undefined ||
    !validateObjectFields(
      root,
      ["schemaVersion", "inputId", "adapterId", "candidates"],
      ["schemaVersion", "inputId", "adapterId", "candidates"],
      [],
      state,
    ) ||
    !hasSchemaVersion(root, BINDING_MANIFEST_SCHEMA_VERSION, [], state)
  ) {
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, adapterId, "binding", "invalid-input-shape", 0),
      [],
    );
    return isOverflowed(state)
      ? bindingOverflowResult(builder)
      : { candidates, coverageGaps, diagnostics: state.diagnostics };
  }

  const rawCandidates = readArray(root, "candidates", ["candidates"], state);
  if (rawCandidates === undefined) {
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, adapterId, "binding", "invalid-array", 0),
      ["candidates"],
    );
    return isOverflowed(state)
      ? bindingOverflowResult(builder)
      : { candidates, coverageGaps, diagnostics: state.diagnostics };
  }

  const ids = new Set<string>();
  for (let index = 0; index < rawCandidates.length; index += 1) {
    if (isOverflowed(state)) {
      return bindingOverflowResult(builder);
    }
    const rawCandidate = rawCandidates[index];
    const path: BindingAdapterPath = ["candidates", index];
    const attempt = parseBindingCandidate(rawCandidate, path, state);
    if (isOverflowed(state)) {
      return bindingOverflowResult(builder);
    }
    const candidate = attempt.candidate;

    if (candidate === undefined) {
      appendCoverageGap(
        builder,
        coverageGaps,
        state,
        fallbackGap(inputId, adapterId, "binding", "invalid-input-shape", index + 1, attempt.selector),
        path,
      );
      if (isOverflowed(state)) {
        return bindingOverflowResult(builder);
      }
      continue;
    }

    if (ids.has(candidate.id)) {
      diagnostic(state, "duplicate-candidate", path);
      appendCoverageGap(
        builder,
        coverageGaps,
        state,
        fallbackGap(inputId, adapterId, "binding", "duplicate-candidate", index + 1, attempt.selector),
        path,
      );
      if (isOverflowed(state)) {
        return bindingOverflowResult(builder);
      }
      continue;
    }
    ids.add(candidate.id);

    if (!reserveNormalized(state)) {
      return bindingOverflowResult(builder);
    }
    const materialized = builder.bindingCandidate(candidate);
    if (materialized.ok) {
      candidates.push(materialized.value);
      continue;
    }

    diagnostic(state, materialized.code, path);
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, adapterId, "binding", materialized.code, index + 1, attempt.selector),
      path,
    );
    if (isOverflowed(state)) {
      return bindingOverflowResult(builder);
    }
  }

  return { candidates, coverageGaps, diagnostics: state.diagnostics };
}

/** Parse a provider inventory export supplied locally; no provider is queried. */
export function parseInventorySnapshot<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  input: unknown,
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): InventorySnapshotParseResult<TInventorySnapshot, TCoverageGap> {
  const state = createState();
  const root = parseRootObject(input, state);
  const inputId = readStringOrFallback(root, "inputId", "inventory-snapshot", [], state);
  const authorityId = readStringOrFallback(root, "authorityId", "inventory-authority", [], state);
  const coverageGaps: TCoverageGap[] = [];

  if (isOverflowed(state)) {
    return inventoryOverflowResult(builder);
  }

  if (
    root === undefined ||
    !validateObjectFields(
      root,
      ["schemaVersion", "inputId", "authorityId", "asOf", "items"],
      ["schemaVersion", "inputId", "authorityId", "asOf", "items"],
      [],
      state,
    ) ||
    !hasSchemaVersion(root, INVENTORY_SNAPSHOT_SCHEMA_VERSION, [], state)
  ) {
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, authorityId, "inventory", "invalid-input-shape", 0),
      [],
    );
    return isOverflowed(state)
      ? inventoryOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  const asOf = readString(root, "asOf", ["asOf"], state);
  if (asOf === undefined || !isIsoTimestamp(asOf)) {
    if (asOf !== undefined) {
      diagnostic(state, "invalid-timestamp", ["asOf"]);
    }
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, authorityId, "inventory", "invalid-timestamp", 0),
      ["asOf"],
    );
    return isOverflowed(state)
      ? inventoryOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  const rawItems = readArray(root, "items", ["items"], state);
  if (rawItems === undefined) {
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, authorityId, "inventory", "invalid-array", 0),
      ["items"],
    );
    return isOverflowed(state)
      ? inventoryOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  const items: RawInventoryItem[] = [];
  const resourceIds = new Set<string>();
  for (let index = 0; index < rawItems.length; index += 1) {
    if (isOverflowed(state)) {
      return inventoryOverflowResult(builder);
    }
    const rawItem = rawItems[index];
    const path: BindingAdapterPath = ["items", index];
    const item = parseInventoryItem(rawItem, path, state);
    if (isOverflowed(state)) {
      return inventoryOverflowResult(builder);
    }
    if (item === undefined) {
      appendCoverageGap(
        builder,
        coverageGaps,
        state,
        fallbackGap(inputId, authorityId, "inventory", "invalid-input-shape", index + 1),
        path,
      );
      if (isOverflowed(state)) {
        return inventoryOverflowResult(builder);
      }
      continue;
    }

    if (item.providerResourceId.authorityId !== authorityId) {
      diagnostic(state, "invalid-provider-resource", path);
      appendCoverageGap(
        builder,
        coverageGaps,
        state,
        fallbackGap(inputId, authorityId, "inventory", "invalid-provider-resource", index + 1),
        path,
      );
      if (isOverflowed(state)) {
        return inventoryOverflowResult(builder);
      }
      continue;
    }

    const resourceKey = `${item.providerResourceId.authorityId}\u0000${item.providerResourceId.canonicalId}`;
    if (resourceIds.has(resourceKey)) {
      diagnostic(state, "duplicate-candidate", path);
      appendCoverageGap(
        builder,
        coverageGaps,
        state,
        fallbackGap(inputId, authorityId, "inventory", "duplicate-candidate", index + 1),
        path,
      );
      if (isOverflowed(state)) {
        return inventoryOverflowResult(builder);
      }
      continue;
    }
    resourceIds.add(resourceKey);
    if (!reserveNormalized(state)) {
      return inventoryOverflowResult(builder);
    }
    items.push(item);
  }

  const rawSnapshot: RawInventorySnapshot = {
    schemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
    inputId,
    authorityId,
    asOf,
    items,
  };
  const materialized = builder.inventorySnapshot(rawSnapshot);
  if (!materialized.ok) {
    diagnostic(state, materialized.code, []);
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, authorityId, "inventory", materialized.code, 0),
      [],
    );
    return isOverflowed(state)
      ? inventoryOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  return { snapshot: materialized.value, coverageGaps, diagnostics: state.diagnostics };
}

/**
 * Parse an explicit closed provisioning model. A manifest declaration never
 * turns a dynamic source into a proven finite Core domain; that proof belongs
 * to a trusted code adapter.
 */
export function parseClosedProvisioningModel<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  input: unknown,
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): ClosedModelParseResult<TClosedModel, TCoverageGap> {
  const state = createState();
  const root = parseRootObject(input, state);
  const inputId = readStringOrFallback(root, "inputId", "closed-provisioning-model", [], state);
  const coverageGaps: TCoverageGap[] = [];
  const modelGap = (reason: BindingAdapterDiagnosticCode, suffix: number): void => {
    appendCoverageGap(
      builder,
      coverageGaps,
      state,
      fallbackGap(inputId, "closed-model", "binding", reason, suffix),
      [],
    );
  };

  if (isOverflowed(state)) {
    return closedModelOverflowResult(builder);
  }

  if (
    root === undefined ||
    !validateObjectFields(
      root,
      ["schemaVersion", "inputId", "maxFiniteKeyDomain", "scopes", "dynamicDomains"],
      ["schemaVersion", "inputId", "maxFiniteKeyDomain", "scopes"],
      [],
      state,
    ) ||
    !hasSchemaVersion(root, CLOSED_MODEL_SCHEMA_VERSION, [], state)
  ) {
    modelGap("invalid-closed-model", 0);
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  const maxFiniteKeyDomain = readPositiveSafeInteger(
    root,
    "maxFiniteKeyDomain",
    ["maxFiniteKeyDomain"],
    state,
  );
  const rawScopes = readArray(root, "scopes", ["scopes"], state);
  const rawDomains = root.dynamicDomains === undefined
    ? []
    : readArray(root, "dynamicDomains", ["dynamicDomains"], state);

  if (maxFiniteKeyDomain === undefined || rawScopes === undefined) {
    modelGap("invalid-closed-model", 0);
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }
  if (maxFiniteKeyDomain > MAX_CLOSED_MODEL_FINITE_KEYS) {
    diagnostic(state, "model-domain-over-budget", ["maxFiniteKeyDomain"]);
    modelGap("model-domain-over-budget", 0);
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }
  if (rawScopes.length === 0) {
    diagnostic(state, "invalid-closed-model", ["scopes"]);
    modelGap("invalid-closed-model", 0);
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  const scopes: RawClosedModelScope[] = [];
  const scopeIds = new Set<string>();
  for (let index = 0; index < rawScopes.length; index += 1) {
    if (isOverflowed(state)) {
      return closedModelOverflowResult(builder);
    }
    const rawScope = rawScopes[index];
    const path: BindingAdapterPath = ["scopes", index];
    const scope = parseClosedModelScope(rawScope, path, state);
    if (isOverflowed(state)) {
      return closedModelOverflowResult(builder);
    }
    if (scope === undefined) {
      modelGap("invalid-closed-model", index + 1);
      if (isOverflowed(state)) {
        return closedModelOverflowResult(builder);
      }
      continue;
    }
    const scopeKey = closedScopeKey(scope);
    if (scopeIds.has(scopeKey)) {
      diagnostic(state, "invalid-closed-model", path);
      modelGap("invalid-closed-model", index + 1);
      if (isOverflowed(state)) {
        return closedModelOverflowResult(builder);
      }
      continue;
    }
    scopeIds.add(scopeKey);
    if (!reserveNormalized(state)) {
      return closedModelOverflowResult(builder);
    }
    scopes.push(scope);
  }

  if (scopes.length !== rawScopes.length) {
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  // A closed model names a potential domain but cannot prove the code-side
  // selector constraint. Preserve the valid static scopes, emit a fixed
  // diagnostic for each declaration, and deliberately pass no expansion to
  // Core. A DynamicLookupEdge from a trusted code adapter owns the real
  // uncertainty/expansion decision.
  if (rawDomains === undefined) {
    diagnostic(state, "unproven-dynamic-domain", ["dynamicDomains"]);
  } else {
    const patternIds = new Set<string>();
    for (let index = 0; index < rawDomains.length; index += 1) {
      if (isOverflowed(state)) {
        return closedModelOverflowResult(builder);
      }
      const rawDomain = rawDomains[index];
      const path: BindingAdapterPath = ["dynamicDomains", index];
      const domain = parseClosedModelDomain(rawDomain, maxFiniteKeyDomain, path, state);
      if (isOverflowed(state)) {
        return closedModelOverflowResult(builder);
      }
      if (domain === undefined || patternIds.has(domain.patternId)) {
        if (domain !== undefined) {
          diagnostic(state, "invalid-closed-model", path);
        }
        diagnostic(state, "unproven-dynamic-domain", path);
        if (isOverflowed(state)) {
          return closedModelOverflowResult(builder);
        }
        continue;
      }
      patternIds.add(domain.patternId);
      diagnostic(state, "unproven-dynamic-domain", path);
      if (isOverflowed(state)) {
        return closedModelOverflowResult(builder);
      }
    }
  }

  const rawModel: RawClosedProvisioningModel = {
    schemaVersion: CLOSED_MODEL_SCHEMA_VERSION,
    inputId,
    maxFiniteKeyDomain,
    scopes,
    // Manifest-only declarations never become Core finite expansions.
    dynamicDomains: [],
  };
  const materialized = builder.closedModel(rawModel);
  if (!materialized.ok) {
    diagnostic(state, materialized.code, []);
    modelGap(materialized.code, 0);
    return isOverflowed(state)
      ? closedModelOverflowResult(builder)
      : { coverageGaps, diagnostics: state.diagnostics };
  }

  return { model: materialized.value, coverageGaps, diagnostics: state.diagnostics };
}

function parseBindingCandidate(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): CandidateAttempt {
  const record = objectAt(input, path, state);
  if (record === undefined) {
    return { selector: UNKNOWN_SELECTOR };
  }
  const validFields = validateObjectFields(
    record,
    [
      "id",
      "adapterId",
      "scope",
      "destination",
      "sourceKind",
      "providerResourceId",
      "appliesWhen",
      "precedence",
      "resolution",
    ],
    ["id", "adapterId", "scope", "destination", "sourceKind", "appliesWhen", "precedence", "resolution"],
    path,
    state,
  );

  const scope = parseExecutionScope(record.scope, [...path, "scope"], state);
  const selector = scope === undefined ? UNKNOWN_SELECTOR : selectorForScope(scope);
  const id = readString(record, "id", [...path, "id"], state);
  const adapterId = readString(record, "adapterId", [...path, "adapterId"], state);
  const destination = parseLogicalKey(record.destination, [...path, "destination"], state);
  const sourceKind = readEnum(record, "sourceKind", SOURCE_KINDS, [...path, "sourceKind"], state);
  const appliesWhen = parseScopeSelector(record.appliesWhen, [...path, "appliesWhen"], state);
  const precedence = parsePrecedence(record.precedence, [...path, "precedence"], state);
  const resolution = readEnum(record, "resolution", RESOLUTIONS, [...path, "resolution"], state);
  const providerResourceId = record.providerResourceId === undefined
    ? undefined
    : parseProviderResource(record.providerResourceId, [...path, "providerResourceId"], state);

  if (
    !validFields ||
    scope === undefined ||
    id === undefined ||
    adapterId === undefined ||
    destination === undefined ||
    sourceKind === undefined ||
    appliesWhen === undefined ||
    precedence === undefined ||
    resolution === undefined ||
    (record.providerResourceId !== undefined && providerResourceId === undefined) ||
    (sourceKind === "secret-manager" && providerResourceId === undefined)
  ) {
    if (sourceKind === "secret-manager" && providerResourceId === undefined) {
      diagnostic(state, "invalid-provider-resource", [...path, "providerResourceId"]);
    }
    return { selector };
  }

  return {
    selector,
    candidate: {
      id,
      adapterId,
      scope,
      destination,
      sourceKind,
      ...(providerResourceId === undefined ? {} : { providerResourceId }),
      appliesWhen,
      precedence,
      resolution,
    },
  };
}

function parseInventoryItem(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawInventoryItem | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["providerResourceId", "declaredScopes"], ["providerResourceId"], path, state)
  ) {
    return undefined;
  }
  const providerResourceId = parseProviderResource(
    record.providerResourceId,
    [...path, "providerResourceId"],
    state,
  );
  if (providerResourceId === undefined) {
    return undefined;
  }

  let declaredScopes: RawExecutionScope[] | undefined;
  if (record.declaredScopes !== undefined) {
    const rawScopes = readArray(record, "declaredScopes", [...path, "declaredScopes"], state);
    if (rawScopes === undefined) {
      return undefined;
    }
    declaredScopes = [];
    for (let index = 0; index < rawScopes.length; index += 1) {
      if (isOverflowed(state)) {
        return undefined;
      }
      const rawScope = rawScopes[index];
      const scope = parseExecutionScope(rawScope, [...path, "declaredScopes", index], state);
      if (isOverflowed(state) || scope === undefined) {
        return undefined;
      }
      declaredScopes.push(scope);
    }
  }

  return {
    providerResourceId,
    ...(declaredScopes === undefined ? {} : { declaredScopes }),
  };
}

function parseClosedModelScope(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawClosedModelScope | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(
      record,
      [
        "scope",
        "declaredStages",
        "closed",
        "approvedFirstPartyRoots",
        "bindingRoots",
        "expectedAdapterInputs",
        "permittedExclusions",
        "inventoryAuthorities",
        "allowedExternalMechanisms",
        "outsideRootImports",
      ],
      [
        "scope",
        "declaredStages",
        "closed",
        "approvedFirstPartyRoots",
        "bindingRoots",
        "expectedAdapterInputs",
        "permittedExclusions",
        "inventoryAuthorities",
        "allowedExternalMechanisms",
        "outsideRootImports",
      ],
      path,
      state,
    )
  ) {
    return undefined;
  }

  const scope = parseExecutionScope(record.scope, [...path, "scope"], state);
  const declaredStages = parseNonEmptyUniqueStrings(record, "declaredStages", [...path, "declaredStages"], state);
  const closed = readBoolean(record, "closed", [...path, "closed"], state);
  const approvedFirstPartyRoots = parseNonEmptyUniqueStrings(
    record,
    "approvedFirstPartyRoots",
    [...path, "approvedFirstPartyRoots"],
    state,
  );
  const bindingRoots = parseNonEmptyUniqueStrings(record, "bindingRoots", [...path, "bindingRoots"], state);
  const expectedAdapterInputs = parseExpectedAdapterInputs(
    record.expectedAdapterInputs,
    [...path, "expectedAdapterInputs"],
    state,
  );
  const permittedExclusions = parsePermittedExclusions(
    record.permittedExclusions,
    [...path, "permittedExclusions"],
    state,
  );
  const inventoryAuthorities = parseInventoryAuthorities(
    record.inventoryAuthorities,
    [...path, "inventoryAuthorities"],
    state,
  );
  const allowedExternalMechanisms = parseExternalMechanisms(
    record.allowedExternalMechanisms,
    [...path, "allowedExternalMechanisms"],
    state,
  );
  const outsideRootImports = readEnum(
    record,
    "outsideRootImports",
    new Set(["out-of-scope", "included"] as const),
    [...path, "outsideRootImports"],
    state,
  );

  if (
    scope === undefined ||
    declaredStages === undefined ||
    closed === undefined ||
    approvedFirstPartyRoots === undefined ||
    bindingRoots === undefined ||
    expectedAdapterInputs === undefined ||
    permittedExclusions === undefined ||
    inventoryAuthorities === undefined ||
    allowedExternalMechanisms === undefined ||
    outsideRootImports === undefined
  ) {
    return undefined;
  }

  if (
    scope.phase === "unknown" ||
    scope.channel === "unknown" ||
    scope.stage.kind === "unknown" ||
    (scope.stage.kind === "exact" &&
      scope.stage.values.some((stage) => !declaredStages.includes(stage)))
  ) {
    diagnostic(state, "invalid-closed-model", [...path, "scope"]);
    return undefined;
  }

  return {
    scope,
    declaredStages,
    closed,
    approvedFirstPartyRoots,
    bindingRoots,
    expectedAdapterInputs,
    permittedExclusions,
    inventoryAuthorities,
    allowedExternalMechanisms,
    outsideRootImports,
  };
}

function parseClosedModelDomain(
  input: unknown,
  maxFiniteKeyDomain: number,
  path: BindingAdapterPath,
  state: ParseState,
): RawClosedModelDomain | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["patternId", "selector", "keys"], ["patternId", "selector", "keys"], path, state)
  ) {
    return undefined;
  }
  const patternId = readString(record, "patternId", [...path, "patternId"], state);
  const selector = parseScopeSelector(record.selector, [...path, "selector"], state);
  const keys = parseNonEmptyUniqueStrings(record, "keys", [...path, "keys"], state);
  if (patternId === undefined || selector === undefined || keys === undefined) {
    return undefined;
  }
  if (keys.length > maxFiniteKeyDomain) {
    diagnostic(state, "model-domain-over-budget", [...path, "keys"]);
    return undefined;
  }
  return { patternId, selector, keys };
}

function parseExpectedAdapterInputs(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawExpectedAdapterInput[] | undefined {
  const values = arrayAt(input, path, state);
  if (values === undefined || values.length === 0) {
    if (values !== undefined) {
      diagnostic(state, "invalid-array", path);
    }
    return undefined;
  }
  const result: RawExpectedAdapterInput[] = [];
  const inputIds = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = values[index];
    const itemPath = [...path, index];
    const record = objectAt(value, itemPath, state);
    if (
      record === undefined ||
      !validateObjectFields(
        record,
        ["inputId", "domain", "adapterId", "extensions"],
        ["inputId", "domain"],
        itemPath,
        state,
      )
    ) {
      return undefined;
    }
    const inputId = readSafeCoverageInputId(record, "inputId", [...itemPath, "inputId"], state);
    const domain = readEnum(record, "domain", COVERAGE_DOMAINS, [...itemPath, "domain"], state);
    const adapterId = record.adapterId === undefined
      ? undefined
      : readString(record, "adapterId", [...itemPath, "adapterId"], state);
    const extensions = record.extensions === undefined
      ? undefined
      : parseNonEmptyUniqueStrings(record, "extensions", [...itemPath, "extensions"], state);
    if (
      inputId === undefined ||
      domain === undefined ||
      (record.adapterId !== undefined && adapterId === undefined) ||
      (record.extensions !== undefined && extensions === undefined)
    ) {
      return undefined;
    }
    if (inputIds.has(inputId)) {
      diagnostic(state, "duplicate-candidate", [...itemPath, "inputId"]);
      return undefined;
    }
    inputIds.add(inputId);
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push({
      inputId,
      domain,
      ...(adapterId === undefined ? {} : { adapterId }),
      ...(extensions === undefined ? {} : { extensions }),
    });
  }
  return result;
}

function parsePermittedExclusions(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawPermittedExclusion[] | undefined {
  const values = arrayAt(input, path, state);
  if (values === undefined) {
    return undefined;
  }
  const result: RawPermittedExclusion[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = values[index];
    const itemPath = [...path, index];
    const record = objectAt(value, itemPath, state);
    if (
      record === undefined ||
      !validateObjectFields(record, ["selector", "rationaleCode"], ["selector", "rationaleCode"], itemPath, state)
    ) {
      return undefined;
    }
    const selector = parseScopeSelector(record.selector, [...itemPath, "selector"], state);
    const rationaleCode = readString(record, "rationaleCode", [...itemPath, "rationaleCode"], state);
    if (selector === undefined || rationaleCode === undefined) {
      return undefined;
    }
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push({ selector, rationaleCode });
  }
  return result;
}

function parseInventoryAuthorities(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawInventoryAuthority[] | undefined {
  const values = arrayAt(input, path, state);
  if (values === undefined || values.length === 0) {
    if (values !== undefined) {
      diagnostic(state, "invalid-array", path);
    }
    return undefined;
  }
  const result: RawInventoryAuthority[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = values[index];
    const itemPath = [...path, index];
    const record = objectAt(value, itemPath, state);
    if (
      record === undefined ||
      !validateObjectFields(record, ["authorityId", "inventoryInputId"], ["authorityId", "inventoryInputId"], itemPath, state)
    ) {
      return undefined;
    }
    const authorityId = readString(record, "authorityId", [...itemPath, "authorityId"], state);
    const inventoryInputId = readString(record, "inventoryInputId", [...itemPath, "inventoryInputId"], state);
    if (authorityId === undefined || inventoryInputId === undefined) {
      return undefined;
    }
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push({ authorityId, inventoryInputId });
  }
  return result;
}

function parseExternalMechanisms(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawExternalMechanism[] | undefined {
  const values = arrayAt(input, path, state);
  if (values === undefined) {
    return undefined;
  }
  const result: RawExternalMechanism[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = values[index];
    const itemPath = [...path, index];
    const record = objectAt(value, itemPath, state);
    if (
      record === undefined ||
      !validateObjectFields(record, ["selector", "mechanismId"], ["selector", "mechanismId"], itemPath, state)
    ) {
      return undefined;
    }
    const selector = parseScopeSelector(record.selector, [...itemPath, "selector"], state);
    const mechanismId = readString(record, "mechanismId", [...itemPath, "mechanismId"], state);
    if (selector === undefined || mechanismId === undefined) {
      return undefined;
    }
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push({ selector, mechanismId });
  }
  return result;
}

function parseExecutionScope(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawExecutionScope | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["id", "componentId", "phase", "stage", "channel"], ["id", "componentId", "phase", "stage", "channel"], path, state)
  ) {
    return undefined;
  }
  const id = readString(record, "id", [...path, "id"], state);
  const componentId = readString(record, "componentId", [...path, "componentId"], state);
  const phase = readEnum(record, "phase", PHASES, [...path, "phase"], state);
  const stage = parseStagePredicate(record.stage, [...path, "stage"], state);
  const channel = readEnum(record, "channel", DELIVERY_CHANNELS, [...path, "channel"], state);
  if (id === undefined || componentId === undefined || phase === undefined || stage === undefined || channel === undefined) {
    return undefined;
  }
  if (!reserveNormalized(state)) {
    return undefined;
  }
  return { id, componentId, phase, stage, channel };
}

function parseScopeSelector(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawScopeSelector | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(
      record,
      ["executionUnitIds", "phases", "stage", "channels", "condition"],
      ["stage", "condition"],
      path,
      state,
    )
  ) {
    return undefined;
  }
  const executionUnitIds = record.executionUnitIds === undefined
    ? undefined
    : parseNonEmptyUniqueStrings(record, "executionUnitIds", [...path, "executionUnitIds"], state);
  const phases = record.phases === undefined
    ? undefined
    : parseEnumArray(record, "phases", PHASES, [...path, "phases"], state);
  const stage = parseStagePredicate(record.stage, [...path, "stage"], state);
  const channels = record.channels === undefined
    ? undefined
    : parseEnumArray(record, "channels", DELIVERY_CHANNELS, [...path, "channels"], state);
  const condition = parseConditionPredicate(record.condition, [...path, "condition"], state);
  if (
    (record.executionUnitIds !== undefined && executionUnitIds === undefined) ||
    (record.phases !== undefined && phases === undefined) ||
    stage === undefined ||
    (record.channels !== undefined && channels === undefined) ||
    condition === undefined
  ) {
    return undefined;
  }
  if (!reserveNormalized(state)) {
    return undefined;
  }
  return {
    ...(executionUnitIds === undefined ? {} : { executionUnitIds }),
    ...(phases === undefined ? {} : { phases }),
    stage,
    ...(channels === undefined ? {} : { channels }),
    condition,
  };
}

function parseStagePredicate(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawStagePredicate | undefined {
  const record = objectAt(input, path, state);
  if (record === undefined) {
    return undefined;
  }
  const kind = readString(record, "kind", [...path, "kind"], state);
  if (kind === "exact") {
    if (!validateObjectFields(record, ["kind", "values"], ["kind", "values"], path, state)) {
      return undefined;
    }
    const values = parseNonEmptyUniqueStrings(record, "values", [...path, "values"], state);
    return values === undefined ? undefined : { kind, values };
  }
  if (kind === "all" || kind === "unknown") {
    if (!validateObjectFields(record, ["kind"], ["kind"], path, state)) {
      return undefined;
    }
    return { kind };
  }
  diagnostic(state, "invalid-stage-predicate", path);
  return undefined;
}

function parseConditionPredicate(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawConditionPredicate | undefined {
  const record = objectAt(input, path, state);
  if (record === undefined) {
    return undefined;
  }
  const kind = readString(record, "kind", [...path, "kind"], state);
  if (kind === "always" || kind === "unknown") {
    if (!validateObjectFields(record, ["kind"], ["kind"], path, state)) {
      return undefined;
    }
    return { kind };
  }
  if (kind !== "all" || !validateObjectFields(record, ["kind", "clauses"], ["kind", "clauses"], path, state)) {
    diagnostic(state, "invalid-condition-predicate", path);
    return undefined;
  }
  const rawClauses = readArray(record, "clauses", [...path, "clauses"], state);
  if (rawClauses === undefined || rawClauses.length === 0) {
    if (rawClauses !== undefined) {
      diagnostic(state, "invalid-condition-predicate", [...path, "clauses"]);
    }
    return undefined;
  }
  const clauses: RawConditionClause[] = [];
  const clauseIds = new Set<string>();
  for (let index = 0; index < rawClauses.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const rawClause = rawClauses[index];
    const clausePath = [...path, "clauses", index];
    const clause = parseConditionClause(rawClause, clausePath, state);
    if (clause === undefined) {
      return undefined;
    }
    const clauseKey = `${clause.key}\u0000${clause.operator}\u0000${clause.value}`;
    if (clauseIds.has(clauseKey)) {
      diagnostic(state, "invalid-condition-predicate", clausePath);
      return undefined;
    }
    clauseIds.add(clauseKey);
    if (!reserveNormalized(state)) {
      return undefined;
    }
    clauses.push(clause);
  }
  return { kind: "all", clauses };
}

function parseConditionClause(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawConditionClause | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["key", "operator", "value"], ["key", "operator", "value"], path, state)
  ) {
    return undefined;
  }
  const key = readString(record, "key", [...path, "key"], state);
  const operator = readEnum(record, "operator", CONDITION_OPERATORS, [...path, "operator"], state);
  const value = readString(record, "value", [...path, "value"], state);
  if (key === undefined || operator === undefined || value === undefined) {
    return undefined;
  }
  return { key, operator, value };
}

function parseLogicalKey(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawLogicalKey | undefined {
  const record = objectAt(input, path, state);
  if (record === undefined || !validateObjectFields(record, ["namespace", "name"], ["namespace", "name"], path, state)) {
    return undefined;
  }
  const namespace = readEnum(record, "namespace", LOGICAL_NAMESPACES, [...path, "namespace"], state);
  const name = readString(record, "name", [...path, "name"], state);
  return namespace === undefined || name === undefined ? undefined : { namespace, name };
}

function parseProviderResource(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawProviderResourceId | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["authorityId", "canonicalId"], ["authorityId", "canonicalId"], path, state)
  ) {
    return undefined;
  }
  const authorityId = readString(record, "authorityId", [...path, "authorityId"], state);
  const canonicalId = readString(record, "canonicalId", [...path, "canonicalId"], state);
  return authorityId === undefined || canonicalId === undefined ? undefined : { authorityId, canonicalId };
}

function parsePrecedence(
  input: unknown,
  path: BindingAdapterPath,
  state: ParseState,
): RawBindingCandidate["precedence"] | undefined {
  const record = objectAt(input, path, state);
  if (
    record === undefined ||
    !validateObjectFields(record, ["source", "rank", "comparable"], ["source", "comparable"], path, state)
  ) {
    return undefined;
  }
  const source = readString(record, "source", [...path, "source"], state);
  const comparable = readBoolean(record, "comparable", [...path, "comparable"], state);
  const rank = record.rank === undefined ? undefined : readNonNegativeSafeInteger(record, "rank", [...path, "rank"], state);
  if (source === undefined || comparable === undefined || (record.rank !== undefined && rank === undefined)) {
    return undefined;
  }
  if (comparable && rank === undefined) {
    diagnostic(state, "invalid-precedence", path);
    return undefined;
  }
  return { source, comparable, ...(rank === undefined ? {} : { rank }) };
}

function selectorForScope(scope: RawExecutionScope): RawScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

function fallbackGap(
  inputId: string,
  adapterId: string,
  domain: RawCoverageGap["domain"],
  reason: BindingAdapterDiagnosticCode,
  ordinal: number,
  selector: RawScopeSelector = UNKNOWN_SELECTOR,
): RawCoverageGap {
  return {
    idHint: `${domain}-input-gap-${ordinal}`,
    domain,
    inputId,
    pathOrAdapterId: adapterId,
    potentiallyAffects: selector,
    reason,
  };
}

function appendCoverageGap<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
  coverageGaps: TCoverageGap[],
  state: ParseState,
  input: RawCoverageGap,
  path: BindingAdapterPath,
): void {
  if (!reserveNormalized(state)) {
    return;
  }
  const materialized = builder.coverageGap(input);
  if (materialized.ok) {
    coverageGaps.push(materialized.value);
    return;
  }
  diagnostic(state, materialized.code, path);
}

function createState(): ParseState {
  return { diagnostics: [], budget: createProvisioningBudget() };
}

function diagnostic(
  state: ParseState,
  code: BindingAdapterDiagnosticCode,
  path: BindingAdapterPath,
): void {
  if (!reserveNormalized(state)) {
    return;
  }
  state.diagnostics.push({ code, path });
}

function reserveNormalized(state: ParseState): boolean {
  return reserveProvisioningNormalizedEntries(state.budget);
}

function isOverflowed(state: ParseState): boolean {
  return state.budget.overflowed;
}

function overflowGap<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
  domain: RawCoverageGap["domain"],
): readonly TCoverageGap[] {
  const materialized = builder.coverageGap({
    idHint: "provisioning-input-entry-limit-exceeded",
    domain,
    inputId: OVERFLOW_INPUT_ID,
    pathOrAdapterId: OVERFLOW_ADAPTER_ID,
    potentiallyAffects: UNKNOWN_SELECTOR,
    reason: "input-entry-limit-exceeded",
  });
  return materialized.ok ? Object.freeze([materialized.value]) : Object.freeze([]);
}

function overflowDiagnostics(): readonly BindingAdapterDiagnostic[] {
  return Object.freeze([{ code: "input-entry-limit-exceeded", path: Object.freeze([]) }]);
}

function bindingOverflowResult<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): BindingManifestParseResult<TBindingCandidate, TCoverageGap> {
  return {
    candidates: Object.freeze([]),
    coverageGaps: overflowGap(builder, "binding"),
    diagnostics: overflowDiagnostics(),
  };
}

function inventoryOverflowResult<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): InventorySnapshotParseResult<TInventorySnapshot, TCoverageGap> {
  return {
    coverageGaps: overflowGap(builder, "inventory"),
    diagnostics: overflowDiagnostics(),
  };
}

function closedModelOverflowResult<
  TBindingCandidate,
  TInventorySnapshot,
  TClosedModel,
  TCoverageGap,
>(
  builder: BindingAdapterFactBuilder<
    TBindingCandidate,
    TInventorySnapshot,
    TClosedModel,
    TCoverageGap
  >,
): ClosedModelParseResult<TClosedModel, TCoverageGap> {
  return {
    coverageGaps: overflowGap(builder, "binding"),
    diagnostics: overflowDiagnostics(),
  };
}

function parseRootObject(input: unknown, state: ParseState): JsonRecord | undefined {
  return objectAt(input, [], state);
}

function objectAt(input: unknown, path: BindingAdapterPath, state: ParseState): JsonRecord | undefined {
  if (!isRecord(input)) {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  return input;
}

function arrayAt(input: unknown, path: BindingAdapterPath, state: ParseState): unknown[] | undefined {
  if (!Array.isArray(input)) {
    diagnostic(state, "invalid-array", path);
    return undefined;
  }
  const array = reserveProvisioningArray(input, state.budget);
  return array === undefined ? undefined : array as unknown[];
}

function validateObjectFields(
  record: JsonRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: BindingAdapterPath,
  state: ParseState,
): boolean {
  let valid = true;
  const allowedSet = new Set(allowed);
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    if (!allowedSet.has(key)) {
      // Never expose a user-controlled property spelling in a diagnostic path.
      diagnostic(state, "unknown-field", path);
      return false;
    }
  }
  if (isOverflowed(state)) {
    return false;
  }
  for (const field of required) {
    if (!(field in record)) {
      diagnostic(state, "missing-field", [...path, field]);
      valid = false;
    }
  }
  return valid;
}

function hasSchemaVersion(
  record: JsonRecord,
  expected: string,
  path: BindingAdapterPath,
  state: ParseState,
): boolean {
  if (record.schemaVersion !== expected) {
    diagnostic(state, "invalid-schema-version", [...path, "schemaVersion"]);
    return false;
  }
  return true;
}

function readString(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): string | undefined {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    diagnostic(state, "invalid-string", path);
    return undefined;
  }
  return value;
}

/**
 * Expected coverage identities participate in closed-model completion joins,
 * so reject unsafe spellings before they can reach a generic test builder or
 * Core materializer. Diagnostics retain only a fixed code and parser path.
 */
function readSafeCoverageInputId(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): string | undefined {
  const value = readString(record, field, path, state);
  if (
    value === undefined ||
    !SAFE_COVERAGE_INPUT_ID_PATTERN.test(value) ||
    isSecretLikeToken(value)
  ) {
    if (value !== undefined) {
      diagnostic(state, "unsafe-identifier", path);
    }
    return undefined;
  }
  return value;
}

function readStringOrFallback(
  record: JsonRecord | undefined,
  field: string,
  fallback: string,
  path: BindingAdapterPath,
  state: ParseState,
): string {
  if (record === undefined || !(field in record)) {
    return fallback;
  }
  return readString(record, field, [...path, field], state) ?? fallback;
}

function readArray(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): unknown[] | undefined {
  return arrayAt(record[field], path, state);
}

function readBoolean(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): boolean | undefined {
  const value = record[field];
  if (typeof value !== "boolean") {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  return value;
}

function readPositiveSafeInteger(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): number | undefined {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  return value;
}

function readNonNegativeSafeInteger(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): number | undefined {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    diagnostic(state, "invalid-precedence", path);
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  record: JsonRecord,
  field: string,
  values: ReadonlySet<T>,
  path: BindingAdapterPath,
  state: ParseState,
): T | undefined {
  const value = record[field];
  if (typeof value !== "string" || !values.has(value as T)) {
    diagnostic(state, "invalid-enum", path);
    return undefined;
  }
  return value as T;
}

function parseEnumArray<T extends string>(
  record: JsonRecord,
  field: string,
  values: ReadonlySet<T>,
  path: BindingAdapterPath,
  state: ParseState,
): T[] | undefined {
  const input = readArray(record, field, path, state);
  if (input === undefined || input.length === 0) {
    if (input !== undefined) {
      diagnostic(state, "invalid-array", path);
    }
    return undefined;
  }
  const result: T[] = [];
  const seen = new Set<T>();
  for (let index = 0; index < input.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = input[index];
    if (typeof value !== "string" || !values.has(value as T) || seen.has(value as T)) {
      diagnostic(state, "invalid-enum", [...path, index]);
      return undefined;
    }
    const parsed = value as T;
    seen.add(parsed);
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push(parsed);
  }
  return result;
}

function parseNonEmptyUniqueStrings(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): string[] | undefined {
  const input = readArray(record, field, path, state);
  if (input === undefined || input.length === 0) {
    if (input !== undefined) {
      diagnostic(state, "invalid-array", path);
    }
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    if (isOverflowed(state)) {
      return undefined;
    }
    const value = input[index];
    if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || seen.has(value)) {
      diagnostic(state, "invalid-array", [...path, index]);
      return undefined;
    }
    seen.add(value);
    if (!reserveNormalized(state)) {
      return undefined;
    }
    result.push(value);
  }
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function closedScopeKey(scope: RawClosedModelScope): string {
  const stage = scope.scope.stage.kind === "exact"
    ? `exact:${scope.scope.stage.values.join("\u0000")}`
    : scope.scope.stage.kind;
  return [scope.scope.id, scope.scope.phase, scope.scope.channel, stage].join("\u0001");
}
