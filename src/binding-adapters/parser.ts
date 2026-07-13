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
 * Parses one local binding-manifest object into Core-materialized candidates and coverage gaps.
 *
 * Inputs: Untrusted in-memory manifest data and a safe fact builder.
 * Outputs: When each executed fact-builder call returns its result union, materialized candidates, diagnostics only while normalized-entry budget permits, and gap facts only while that budget and the fact builder permit. An overflow result replaces partial output.
 * Does not handle: Reading files, evaluating IaC or shell expressions, querying a provider, returning raw input strings, or catching/sanitizing injected fact-builder exceptions.
 * Side effects: Calls the fact builder and advances a per-parse provisioning budget; an exception from the builder propagates unchanged.
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

/**
 * Parses a local provider-inventory export while preserving authority-qualified resource identity.
 *
 * Inputs: Untrusted snapshot data and a safe fact builder.
 * Outputs: When each executed fact-builder call returns its result union, one materialized snapshot when valid, diagnostics only while normalized-entry budget permits, and coverage gaps only while that budget and the fact builder permit. An overflow result replaces partial output.
 * Does not handle: Contacting providers, dereferencing resource values, matching resources to code keys, or catching/sanitizing injected fact-builder exceptions.
 * Side effects: Calls the fact builder and consumes the local provisioning-entry budget; an exception from the builder propagates unchanged.
 */
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
 * Parses declared scope closure evidence without converting manifest dynamic domains into proven code domains.
 *
 * Inputs: Untrusted closed-model data and a safe fact builder.
 * Outputs: When each executed fact-builder call returns its result union, a materialized model only for valid scopes, diagnostics only while normalized-entry budget permits, and gaps for malformed model materialization only while that budget and the fact builder permit. A manifest-only dynamic domain that stays within the entry budget adds an `unproven-dynamic-domain` diagnostic but no dynamic-domain gap; an oversized domain array instead returns the fixed `input-entry-limit-exceeded` diagnostic and generic binding coverage gap. An overflow result replaces partial output.
 * Does not handle: Proving source-side dynamic lookup finiteness, expanding declared dynamic keys into Core facts, or catching/sanitizing injected fact-builder exceptions.
 * Side effects: Calls the fact builder and consumes the local provisioning-entry budget; an exception from the builder propagates unchanged.
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
  const modelGap =
    /**
     * Adds one closed-model coverage gap using the current model input identity.
     *
     * Inputs: A fixed diagnostic reason and ordinal used only to distinguish the gap hint.
     * Outputs: Nothing after attempting gap materialization when the fact builder returns normally.
     * Does not handle: Retaining invalid raw model data, deciding whether Core may conclude absence, or catching/sanitizing fact-builder exceptions.
     * Side effects: Calls the fact builder through the gap helper and may mutate local gaps or diagnostics while normalized-entry budget remains; an exception from it propagates unchanged.
     */
    (reason: BindingAdapterDiagnosticCode, suffix: number): void => {
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

/**
 * Validates one candidate object and retains a conservative selector even when the candidate fails.
 *
 * Inputs: One raw candidate value, its safe structural path, and mutable parser state.
 * Outputs: A normalized candidate plus selector, or only an unknown/parsed selector on rejection.
 * Does not handle: Materializing Core facts, comparing candidates, or exposing untrusted field spellings.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and consumes parser budget through nested readers.
 */
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

/**
 * Validates one inventory resource and its optional declared execution scopes.
 *
 * Inputs: One raw item, its safe path, and mutable parser state.
 * Outputs: A normalized inventory item or undefined after a validation failure, whose diagnostic is recorded only while normalized-entry budget remains.
 * Does not handle: Authority-to-snapshot consistency, duplicate detection, or Core materialization.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and consumes parser budget through nested readers.
 */
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

/**
 * Validates the scoped evidence required before a provisioning model can describe closure.
 *
 * Inputs: One raw scope record, its safe path, and mutable parser state.
 * Outputs: A normalized closed-model scope or undefined if any prerequisite or scope invariant fails.
 * Does not handle: Proving that declared exclusions are observed by downstream conclusion logic.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and consumes parser budget through nested readers.
 */
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
      scope.stage.values.some(
        /**
         * Detects an exact scope stage omitted from the enclosing declared-stage set.
         *
         * Inputs: One exact stage string from the parsed execution scope.
         * Outputs: True when that stage has no declaration in the enclosing closed-model scope.
         * Does not handle: Comparing wildcard or unknown stage predicates.
         * Side effects: None.
         */
        (stage) => !declaredStages.includes(stage)
      ))
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

/**
 * Validates a declared finite dynamic-domain record without treating it as Core expansion proof.
 *
 * Inputs: One raw domain record, the enclosing finite-key limit, its path, and parser state.
 * Outputs: A normalized declaration or undefined for malformed or over-budget keys.
 * Does not handle: Emitting the later unproven-domain diagnostic or creating a Core dynamic edge.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and consumes nested-reader budget.
 */
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

/**
 * Validates the closed model's declared adapter-input coverage inventory.
 *
 * Inputs: A raw expected-input array, its path, and mutable parser state.
 * Outputs: Distinct normalized expected-input records or undefined on the first invalid entry.
 * Does not handle: Opening those inputs, checking adapter availability, or making coverage conclusions.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves raw and normalized budget entries.
 */
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

/**
 * Validates scoped permitted-exclusion declarations attached to a closed-model scope.
 *
 * Inputs: A raw exclusions array, its path, and mutable parser state.
 * Outputs: Normalized selector/rationale records or undefined for malformed input.
 * Does not handle: Applying exclusions to final absence conclusions or validating rationale policy. Current Core conclusion logic never applies these declarations, so even a matching exclusion can still produce `missing-under-declared-model`; do not rely on strong absence from that result.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves parser budget entries.
 */
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

/**
 * Validates the authority-to-inventory-input declarations required by a closed model.
 *
 * Inputs: A raw authority array, its path, and mutable parser state.
 * Outputs: Normalized authority/input pairs or undefined for an empty or invalid list.
 * Does not handle: Loading the inventory snapshot or proving authority completeness.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves parser budget entries.
 */
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

/**
 * Validates declared external secret-delivery mechanisms and their affected selectors.
 *
 * Inputs: A raw mechanisms array, its path, and mutable parser state.
 * Outputs: Normalized selector/mechanism records or undefined for malformed input.
 * Does not handle: Inspecting the external mechanism or treating it as code demand.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves parser budget entries.
 */
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

/**
 * Parses one execution unit's component, phase, stage predicate, and delivery channel.
 *
 * Inputs: A raw scope record, its safe path, and mutable parser state.
 * Outputs: A normalized execution scope or undefined on validation/budget failure.
 * Does not handle: Runtime process discovery, scope overlap, or binding precedence.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves a normalized budget entry.
 */
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

/**
 * Parses an optional-dimension selector with required stage and condition predicates.
 *
 * Inputs: A raw selector record, its safe path, and mutable parser state.
 * Outputs: A normalized selector or undefined on invalid dimensions or exhausted budget.
 * Does not handle: Determining whether a selector covers a runtime scope.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves nested and normalized budget entries.
 */
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

/**
 * Parses all, unknown, or exact declared-stage predicates.
 *
 * Inputs: A raw stage predicate, its safe path, and mutable parser state.
 * Outputs: A normalized stage predicate or undefined for invalid discriminants or values.
 * Does not handle: Checking the predicate against a known deployment stage.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and may consume nested-reader budget.
 */
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

/**
 * Parses an always, unknown, or conjunction-of-clauses condition predicate.
 *
 * Inputs: A raw condition predicate, its safe path, and mutable parser state.
 * Outputs: A normalized predicate or undefined for malformed, empty, duplicate, or over-budget clauses.
 * Does not handle: Evaluating conditions against environment values or process state.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves entries while parsing clauses.
 */
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

/**
 * Parses one equality or inequality condition clause without evaluating it.
 *
 * Inputs: A raw clause object, its safe path, and mutable parser state.
 * Outputs: A normalized key/operator/value clause or undefined on structural failure.
 * Does not handle: Evaluating the clause or redacting its string values for other consumers.
 * Side effects: May append fixed diagnostics through nested readers while normalized-entry budget remains.
 */
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

/**
 * Parses a destination key in the supported logical namespaces.
 *
 * Inputs: A raw logical-key object, its safe path, and mutable parser state.
 * Outputs: A namespace/name pair or undefined on invalid fields.
 * Does not handle: Looking up the key, checking source reads, or applying identifier safety policy beyond string shape.
 * Side effects: May append fixed diagnostics through nested readers while normalized-entry budget remains.
 */
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

/**
 * Parses an authority-qualified provider resource identifier.
 *
 * Inputs: A raw provider-resource object, its safe path, and mutable parser state.
 * Outputs: An authority ID and canonical ID pair or undefined on invalid fields.
 * Does not handle: Provider access, account/region resolution, or resource existence checks.
 * Side effects: May append fixed diagnostics through nested readers while normalized-entry budget remains.
 */
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

/**
 * Parses source precedence metadata while requiring a rank when comparison is declared possible.
 *
 * Inputs: A raw precedence record, its safe path, and mutable parser state.
 * Outputs: A normalized precedence object or undefined for invalid rank/comparability combinations.
 * Does not handle: Ranking candidate pairs or resolving conditional overrides.
 * Side effects: May append fixed diagnostics through nested readers while normalized-entry budget remains.
 */
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

/**
 * Field-copies one execution scope into an always-condition selector without interpreting its dimensions.
 *
 * Inputs: A normalized execution scope.
 * Outputs: A newly allocated selector containing the scope's unit ID, phase, stage, and channel verbatim, including unknown values, plus an always condition.
 * Does not handle: Proving selector exactness or coverage, resolving conditional overrides, or matching wider selector coverage.
 * Side effects: Allocates a selector and its small nested arrays.
 */
function selectorForScope(scope: RawExecutionScope): RawScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

/**
 * Builds a value-free coverage-gap hint for an adapter parse failure.
 *
 * Inputs: Input/adapter identities inherited from raw parser data or safe fallbacks, a domain, a fixed reason, ordinal, and optional selector.
 * Outputs: One raw gap object suitable for fact-builder materialization; its inherited identities are not safety-proven until Core materializes the fact.
 * Does not handle: Materializing the gap, validating inherited identities, or exposing an untrusted structural path.
 * Side effects: Allocates the returned object and identifier hint.
 */
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

/**
 * Materializes and appends a coverage gap only while the normalized-entry budget permits it.
 *
 * Inputs: A fact builder, mutable gap/parse state, one raw gap, and its safe parser path.
 * Outputs: If the builder returns a result union, nothing after attempting materialization; the gap is appended only on builder success, and a builder-failure diagnostic is attempted only while budget remains.
 * Does not handle: Retrying builder failures, returning raw gap data, catching/sanitizing builder exceptions, or preserving incomplete coverage when a rejected gap also has no diagnostic budget. That P1 path drops both facts, can let the application classify malformed input as complete, and makes any resulting strong-absence conclusion unsafe.
 * Side effects: Calls the builder, may mutate gaps or diagnostics, and advances the budget; it becomes a no-op after a failed normalized reservation. An exception from the builder propagates unchanged.
 */
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

/**
 * Creates isolated diagnostics and a fresh shared provisioning budget for one parse entry point.
 *
 * Inputs: None.
 * Outputs: Mutable parser state with an empty diagnostics list and new budget.
 * Does not handle: Sharing budget across separate manifest, inventory, or model parses.
 * Side effects: Allocates local state and a provisioning budget.
 */
function createState(): ParseState {
  return { diagnostics: [], budget: createProvisioningBudget() };
}

/**
 * Records one fixed diagnostic only if doing so remains inside the normalized-entry budget.
 *
 * Inputs: Mutable state, a fixed diagnostic code, and a safe structural path.
 * Outputs: Nothing.
 * Does not handle: Formatting diagnostics, exposing raw field names, or recording after budget exhaustion.
 * Side effects: May append the fixed diagnostic and consume a normalized-entry reservation only while capacity remains; otherwise it is a no-op after marking overflow.
 */
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

/**
 * Reserves capacity for one normalized parser output or diagnostic.
 *
 * Inputs: Mutable parser state containing the shared provisioning budget.
 * Outputs: True when capacity was reserved.
 * Does not handle: Reserving raw array entries or undoing a reservation.
 * Side effects: Mutates the provisioning budget and may mark it overflowed.
 */
function reserveNormalized(state: ParseState): boolean {
  return reserveProvisioningNormalizedEntries(state.budget);
}

/**
 * Reads whether the shared provisioning budget has been exhausted.
 *
 * Inputs: Parser state containing the shared budget.
 * Outputs: True after any budget operation has overflowed.
 * Does not handle: Resetting or explaining the overflow.
 * Side effects: None.
 */
function isOverflowed(state: ParseState): boolean {
  return state.budget.overflowed;
}

/**
 * Produces the single fixed coverage gap used when input-entry limits stop a parse.
 *
 * Inputs: A fact builder and the affected coverage domain.
 * Outputs: If the fact builder returns a result union, a frozen singleton gap when materialization succeeds, otherwise a frozen empty list.
 * Does not handle: Retaining partial facts, exposing the oversized input, retrying the builder, or catching/sanitizing builder exceptions.
 * Side effects: Calls the supplied fact builder; an exception from it propagates unchanged.
 */
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

/**
 * Produces the fixed diagnostic list used for any provisioning-budget overflow result.
 *
 * Inputs: None.
 * Outputs: A frozen one-element diagnostic list with no untrusted path segments.
 * Does not handle: Distinguishing which raw array or nested field exceeded the budget.
 * Side effects: Allocates frozen diagnostic objects.
 */
function overflowDiagnostics(): readonly BindingAdapterDiagnostic[] {
  return Object.freeze([{ code: "input-entry-limit-exceeded", path: Object.freeze([]) }]);
}

/**
 * Builds the fail-closed binding-manifest result returned after parser budget exhaustion.
 *
 * Inputs: A fact builder used to materialize the fixed overflow gap.
 * Outputs: If the fact builder returns a result union, no candidates, a binding gap only when it materializes, and one fixed overflow diagnostic.
 * Does not handle: Returning candidates parsed before overflow, resuming the parse, or catching/sanitizing fact-builder exceptions.
 * Side effects: Calls the fact builder through overflow-gap creation; an exception from it propagates unchanged.
 */
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

/**
 * Builds the fail-closed inventory result returned after parser budget exhaustion.
 *
 * Inputs: A fact builder used to materialize the fixed overflow gap.
 * Outputs: If the fact builder returns a result union, no snapshot, an inventory gap only when it materializes, and one fixed overflow diagnostic.
 * Does not handle: Returning partially parsed items, resuming the parse, or catching/sanitizing fact-builder exceptions.
 * Side effects: Calls the fact builder through overflow-gap creation; an exception from it propagates unchanged.
 */
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

/**
 * Builds the fail-closed closed-model result returned after parser budget exhaustion.
 *
 * Inputs: A fact builder used to materialize the fixed overflow gap.
 * Outputs: If the fact builder returns a result union, no model, a binding-domain gap only when it materializes, and one fixed overflow diagnostic.
 * Does not handle: Returning partial scope evidence, resuming the parse, or catching/sanitizing fact-builder exceptions.
 * Side effects: Calls the fact builder through overflow-gap creation; an exception from it propagates unchanged.
 */
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

/**
 * Treats the top-level input as an object using the same fixed-shape validation as nested objects.
 *
 * Inputs: Raw entry-point data and mutable parser state.
 * Outputs: A JSON record or undefined after an invalid-shape diagnostic is attempted subject to normalized-entry budget.
 * Does not handle: Schema version validation or field validation.
 * Side effects: May append a diagnostic through the shared object reader while normalized-entry budget remains.
 */
function parseRootObject(input: unknown, state: ParseState): JsonRecord | undefined {
  return objectAt(input, [], state);
}

/**
 * Narrows a raw value to a non-array object while reporting one fixed shape failure.
 *
 * Inputs: A raw value, its safe structural path, and mutable parser state.
 * Outputs: A JSON record or undefined when the value is not an object record.
 * Does not handle: Inspecting object fields, prototypes, or getter behavior.
 * Side effects: May append a fixed diagnostic on rejection while normalized-entry budget remains.
 */
function objectAt(input: unknown, path: BindingAdapterPath, state: ParseState): JsonRecord | undefined {
  if (!isRecord(input)) {
    diagnostic(state, "invalid-input-shape", path);
    return undefined;
  }
  return input;
}

/**
 * Narrows a raw value to a budget-reserved array before callers index its entries.
 *
 * Inputs: A raw value, its safe structural path, and mutable parser state.
 * Outputs: The input array or undefined for a non-array or raw-entry-budget failure.
 * Does not handle: Validating element types, copying array contents, or recovering overflow.
 * Side effects: May append a fixed shape diagnostic while normalized-entry budget remains or reserves raw array budget.
 */
function arrayAt(input: unknown, path: BindingAdapterPath, state: ParseState): unknown[] | undefined {
  if (!Array.isArray(input)) {
    diagnostic(state, "invalid-array", path);
    return undefined;
  }
  const array = reserveProvisioningArray(input, state.budget);
  return array === undefined ? undefined : array as unknown[];
}

/**
 * Rejects unknown own fields and detects missing required fields without placing an untrusted unknown field name in diagnostics.
 *
 * Inputs: A record, allowed/required field lists, its safe parent path, and mutable parser state.
 * Outputs: True only when all own fields are allowed and all required fields are present, including inherited required fields accepted by the `in` operator.
 * Does not handle: Type validation, own-property enforcement for required fields, inherited-field rejection, or schema-version comparison.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and may reserve diagnostic budget.
 */
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

/**
 * Checks a schema-version field against one exact accepted version.
 *
 * Inputs: A parsed record, expected version, safe path, and mutable parser state.
 * Outputs: True when the record has the exact expected version.
 * Does not handle: Version migration, compatibility ranges, or missing-field diagnosis beyond the fixed version error.
 * Side effects: May append a fixed schema-version diagnostic on mismatch while normalized-entry budget remains.
 */
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

/**
 * Reads one nonblank string field while reporting a fixed type/blankness failure.
 *
 * Inputs: A record, field name controlled by the parser, safe field path, and mutable state.
 * Outputs: The original string or undefined for non-string, empty, or whitespace-only values.
 * Does not handle: Identifier policy, length limits, redaction, or semantic interpretation.
 * Side effects: May append a fixed invalid-string diagnostic on rejection while normalized-entry budget remains.
 */
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
 * Reads an expected-input identity only when it fits the safe coverage grammar and is not secret-like.
 *
 * Inputs: A record, parser-controlled field name, safe field path, and mutable state.
 * Outputs: A safe coverage input ID or undefined after validation; any fixed diagnostics are appended only while normalized-entry budget remains.
 * Does not handle: Proving that the ID names a real file, adapter, or secret resource.
 * Side effects: Delegates string validation and may append an unsafe-identifier diagnostic while normalized-entry budget remains.
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

/**
 * Reads an optional nonblank string or keeps a parser-supplied safe fallback.
 *
 * Inputs: An optional record, field name, fallback text, base path, and mutable state.
 * Outputs: The valid field text or the fallback when absent or invalid.
 * Does not handle: Distinguishing an absent field from an invalid field in the returned value.
 * Side effects: May append a fixed invalid-string diagnostic for a present invalid field while normalized-entry budget remains.
 */
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

/**
 * Reads a named record field as a raw-entry-budget-reserved array.
 *
 * Inputs: A record, parser-controlled field name, safe field path, and mutable state.
 * Outputs: The array value or undefined from the array reader.
 * Does not handle: Validating items or accepting absent fields.
 * Side effects: May append diagnostics while normalized-entry budget remains and reserves raw array budget.
 */
function readArray(
  record: JsonRecord,
  field: string,
  path: BindingAdapterPath,
  state: ParseState,
): unknown[] | undefined {
  return arrayAt(record[field], path, state);
}

/**
 * Reads a boolean field and emits a fixed shape failure for every other type.
 *
 * Inputs: A record, parser-controlled field name, safe field path, and mutable state.
 * Outputs: The boolean value or undefined for a non-boolean.
 * Does not handle: Coercion from strings/numbers or semantic policy validation.
 * Side effects: May append a fixed invalid-input-shape diagnostic on rejection while normalized-entry budget remains.
 */
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

/**
 * Reads a positive JavaScript safe integer from one record field.
 *
 * Inputs: A record, parser-controlled field name, safe field path, and mutable state.
 * Outputs: The positive safe integer or undefined for another numeric shape.
 * Does not handle: Applying a caller-specific upper bound.
 * Side effects: May append a fixed invalid-input-shape diagnostic on rejection while normalized-entry budget remains.
 */
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

/**
 * Reads a nonnegative JavaScript safe integer used as a comparable precedence rank.
 *
 * Inputs: A record, parser-controlled field name, safe field path, and mutable state.
 * Outputs: The nonnegative safe integer or undefined for an invalid rank.
 * Does not handle: Requiring a rank when comparability is true; the precedence parser owns that rule.
 * Side effects: May append a fixed invalid-precedence diagnostic on rejection while normalized-entry budget remains.
 */
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

/**
 * Reads a string field only when it belongs to a parser-supplied finite enum.
 *
 * Inputs: A record, field name, allowed enum set, safe field path, and mutable state.
 * Outputs: A member of the supplied enum type or undefined on mismatch.
 * Does not handle: Normalization, aliases, or enum compatibility conversion.
 * Side effects: May append a fixed invalid-enum diagnostic on rejection while normalized-entry budget remains.
 */
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

/**
 * Parses a nonempty duplicate-free array whose members all belong to a supplied enum.
 *
 * Inputs: A record, field name, allowed enum set, safe field path, and mutable state.
 * Outputs: A normalized enum array or undefined after the first invalid member or budget failure.
 * Does not handle: Sorting values, accepting aliases, or preserving partial arrays.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves raw and normalized entries.
 */
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

/**
 * Parses a nonempty duplicate-free array of nonblank strings.
 *
 * Inputs: A record, field name, safe field path, and mutable parser state.
 * Outputs: A normalized string array or undefined after invalid content or budget exhaustion.
 * Does not handle: Identifier safety, sorting, or normalization beyond blankness and equality.
 * Side effects: May append fixed diagnostics while normalized-entry budget remains and reserves raw and normalized entries.
 */
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

/**
 * Determines whether a value is a non-null object that is not an array.
 *
 * Inputs: One arbitrary JavaScript value.
 * Outputs: A type predicate for object-record candidates.
 * Does not handle: Plain-object enforcement, prototype validation, or safe property access.
 * Side effects: None.
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the accepted UTC timestamp lexical form and that JavaScript can parse it finitely.
 *
 * Inputs: One already-read string.
 * Outputs: True for an accepted ISO-like UTC timestamp.
 * Does not handle: Date-range business policy, timezone conversion, or preserving the parsed date.
 * Side effects: None.
 */
function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * Produces a lossy internal duplicate-detection key for closed-model scopes from their scope dimensions.
 *
 * Inputs: A normalized closed-model scope.
 * Outputs: A delimiter-joined string covering scope ID, phase, channel, and stage predicate; distinct values containing its delimiter characters can collide.
 * Does not handle: Injective serialization, delimiter escaping, condition, roots, authorities, or semantic selector equivalence.
 * Side effects: Allocates the returned string.
 */
function closedScopeKey(scope: RawClosedModelScope): string {
  const stage = scope.scope.stage.kind === "exact"
    ? `exact:${scope.scope.stage.values.join("\u0000")}`
    : scope.scope.stage.kind;
  return [scope.scope.id, scope.scope.phase, scope.scope.channel, stage].join("\u0001");
}
