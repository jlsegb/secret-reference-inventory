import { isAbsolute, relative, sep } from "node:path";

import type {
  BindingCandidate,
  ClosedModelCoverageContract,
  ClosedProvisioningModel,
  ClosedScope,
  ConditionPredicate,
  CoreDiagnostic,
  CoverageDomain,
  DemandEdge,
  DemandKind,
  DynamicKeyDomain,
  DynamicKeyOrigin,
  DynamicLookupEdge,
  Evidence,
  FullCoreFactBuilder,
  CoverageGap,
  DeliveryChannel,
  ExecutionScope,
  ExpectedCoverageInput,
  FactMaterialization,
  InventoryItem,
  InventoryAuthority,
  InventorySnapshot,
  LogicalKey,
  LogicalNamespace,
  Phase,
  PermittedExclusion,
  ProviderResourceId,
  ScopeSelector,
  SecretReference,
  SafeKeyPattern,
  StagePredicate,
  AllowedExternalMechanism,
} from "../core/types.js";

import {
  OPAQUE_IDENTIFIER,
  OPAQUE_PATH,
  type Identifier,
  type OpaqueIdentifier,
  type SafeDiagnosticCode,
  type SafeIdentifier,
  type SafeLocation,
  type SafePath,
  type SafePosition,
  type SafeTimestamp,
  type SanitizedDiagnostic,
} from "./types.js";
import {
  MAX_CLOSED_MODEL_FINITE_KEYS,
  provisioningInputFitsBudget,
} from "./provisioning-budget.js";

/**
 * Version included by callers in cache identity.  Changes to a grammar,
 * redaction classifier, or normalization algorithm must advance this value.
 */
export const SAFE_FACT_POLICY_REVISION = "safe-fact-factory-v1";

export const DEFAULT_ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,255}$/;
export const TRUSTED_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
export const SAFE_DISPLAY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GENERIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ROOT_RELATIVE_PATH = "<root>" as SafePath;

/**
 * The classifier is deliberately conservative. It is a safety filter, not a
 * secret detector; an opaque result is preferable to printing a token-shaped
 * file segment or identifier.
 */
const SECRET_LIKE_PREFIXES: readonly RegExp[] = [
  /^sk_(?:live|test)_/i,
  /^rk_(?:live|test)_/i,
  /^pk_(?:live|test)_/i,
  /^gh[pousr]_/, // GitHub classic tokens
  /^github_pat_/i,
  /^glpat-/i,
  /^xox[abprs]-/i,
  /^AKIA[0-9A-Z]{16}$/,
  /^ASIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /^ya29\.[0-9A-Za-z_-]{10,}$/,
  /^npm_[0-9A-Za-z]{20,}$/,
  /^eyJ[0-9A-Za-z_-]{10,}\./,
];

export interface SafeFactFactoryOptions {
  /**
   * Exact, schema-validated project keys allowed in addition to the default
   * uppercase environment-key grammar. They are intentionally an allowlist,
   * never a caller-provided regular expression.
   */
  readonly trustedEnvironmentKeys?: Iterable<string>;
  /** Maximum exact keys that can be materialized for one dynamic lookup. */
  readonly maxFiniteKeyDomain?: number;
}

export interface SafePathInput {
  readonly approvedRoot: string;
  readonly canonicalPath: string;
}

/**
 * The sole conversion boundary for untrusted text that may reach facts,
 * diagnostics, caches, or reporters. Raw input never appears in an error.
 */
export class SafeFactFactory implements FullCoreFactBuilder {
  readonly policyRevision = SAFE_FACT_POLICY_REVISION;

  readonly #trustedEnvironmentKeys: ReadonlySet<string>;
  readonly #maxFiniteKeyDomain: number;

  public constructor(options: SafeFactFactoryOptions = {}) {
    const trusted = new Set<string>();

    for (const key of options.trustedEnvironmentKeys ?? []) {
      if (
        typeof key !== "string" ||
        !TRUSTED_ENVIRONMENT_KEY_PATTERN.test(key) ||
        isSecretLikeToken(key)
      ) {
        throw new SafetyConfigurationError("INVALID_TRUSTED_ENVIRONMENT_KEY");
      }

      trusted.add(key);
    }

    const maxFiniteKeyDomain = options.maxFiniteKeyDomain ?? 100;
    if (
      !Number.isSafeInteger(maxFiniteKeyDomain) ||
      maxFiniteKeyDomain < 1 ||
      maxFiniteKeyDomain > MAX_CLOSED_MODEL_FINITE_KEYS
    ) {
      throw new SafetyConfigurationError("INVALID_MAX_FINITE_KEY_DOMAIN");
    }

    this.#trustedEnvironmentKeys = trusted;
    this.#maxFiniteKeyDomain = maxFiniteKeyDomain;
  }

  /** Converts every source-derived environment-key spelling through one rule. */
  public environmentKey(value: unknown): Identifier {
    if (typeof value !== "string") {
      return OPAQUE_IDENTIFIER;
    }

    if (
      (DEFAULT_ENVIRONMENT_KEY_PATTERN.test(value) && !isSecretLikeToken(value)) ||
      this.#trustedEnvironmentKeys.has(value)
    ) {
      return asSafeIdentifier(value);
    }

    return OPAQUE_IDENTIFIER;
  }

  /** For tool/config identifiers that have their own non-secret grammar. */
  public genericIdentifier(value: unknown): Identifier {
    if (
      typeof value !== "string" ||
      !GENERIC_IDENTIFIER_PATTERN.test(value) ||
      isSecretLikeToken(value)
    ) {
      return OPAQUE_IDENTIFIER;
    }

    return asSafeIdentifier(value);
  }

  /**
   * Adapters can use this for a provider-defined structured grammar. The
   * matcher is adapter-owned code, not repository configuration or a plugin.
   */
  public structuredIdentifier(value: unknown, matcher: RegExp): Identifier {
    // Adapters must not get stateful results from a global/sticky expression.
    matcher.lastIndex = 0;
    const matches = typeof value === "string" && matcher.test(value);
    matcher.lastIndex = 0;
    if (
      typeof value !== "string" ||
      value.length > 512 ||
      !matches ||
      isSecretLikeToken(value)
    ) {
      return OPAQUE_IDENTIFIER;
    }

    return asSafeIdentifier(value);
  }

  /**
   * Produces a root-relative report path. PathGuard must establish real-path
   * containment before calling this method; this method prevents raw paths
   * from crossing the reporting boundary.
   */
  public safePath(input: SafePathInput): SafePath {
    if (
      typeof input.approvedRoot !== "string" ||
      typeof input.canonicalPath !== "string"
    ) {
      return OPAQUE_PATH;
    }

    const relativePath = relative(input.approvedRoot, input.canonicalPath);
    if (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      return OPAQUE_PATH;
    }

    const segments = relativePath.split(sep);
    if (
      segments.length === 0 ||
      segments.some((segment) => !isSafeDisplaySegment(segment))
    ) {
      return OPAQUE_PATH;
    }

    return segments.join("/") as SafePath;
  }

  public diagnosticCode(value: unknown): SafeDiagnosticCode {
    if (typeof value !== "string" || !DIAGNOSTIC_CODE_PATTERN.test(value)) {
      return "UNSAFE_DIAGNOSTIC" as SafeDiagnosticCode;
    }

    return value as SafeDiagnosticCode;
  }

  /** Returns undefined rather than retaining an invalid untrusted timestamp. */
  public timestamp(value: unknown): SafeTimestamp | undefined {
    if (typeof value !== "string" || !ISO_8601_UTC_PATTERN.test(value)) {
      return undefined;
    }

    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return new Date(parsed).toISOString() as SafeTimestamp;
  }

  public location(
    file: SafePath,
    start: SafePosition,
    end: SafePosition,
  ): SafeLocation {
    return {
      file,
      start: normalizePosition(start),
      end: normalizePosition(end),
    };
  }

  /**
   * Parser implementations may retain rich parser errors privately, but only a
   * fixed code and a pre-sanitized location can leave their worker.
   */
  public diagnostic(
    code: unknown,
    location?: SafeLocation,
  ): SanitizedDiagnostic {
    const sanitizedCode = this.diagnosticCode(code);
    return location === undefined
      ? { code: sanitizedCode }
      : { code: sanitizedCode, location };
  }

  /** Materializes data-only binding input without preserving unsafe strings. */
  public materializeBindingCandidate(
    input: unknown,
  ): FactMaterialization<BindingCandidate> {
    if (!provisioningInputFitsBudget(input)) {
      return materializationFailure(this, "PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
    }
    const record = asRecord(input);
    if (record === undefined) {
      return materializationFailure(this, "INVALID_BINDING_CANDIDATE");
    }

    const id = this.requiredGenericIdentifier(record.id);
    const adapterId = this.requiredGenericIdentifier(record.adapterId);
    const scope = this.materializeExecutionScope(record.scope);
    const destination = this.materializeLogicalKey(record.destination, true);
    const sourceKind = record.sourceKind;
    const appliesWhen = this.materializeScopeSelector(record.appliesWhen);
    const precedence = asRecord(record.precedence);
    const resolution = record.resolution;

    if (
      id === undefined ||
      adapterId === undefined ||
      scope === undefined ||
      destination === undefined ||
      !isBindingSourceKind(sourceKind) ||
      appliesWhen === undefined ||
      precedence === undefined ||
      !isBindingResolution(resolution)
    ) {
      return materializationFailure(this, "INVALID_BINDING_CANDIDATE");
    }

    const precedenceSource = this.requiredGenericIdentifier(precedence.source);
    const rank = precedence.rank;
    if (
      precedenceSource === undefined ||
      typeof precedence.comparable !== "boolean" ||
      (rank !== undefined && (typeof rank !== "number" || !Number.isSafeInteger(rank)))
    ) {
      return materializationFailure(this, "INVALID_PRECEDENCE");
    }

    const providerResourceId =
      record.providerResourceId === undefined
        ? undefined
        : this.materializeProviderResourceId(record.providerResourceId);
    if (record.providerResourceId !== undefined && providerResourceId === undefined) {
      return materializationFailure(this, "INVALID_PROVIDER_RESOURCE");
    }

    const value: BindingCandidate = {
      id,
      adapterId,
      scope,
      destination,
      sourceKind,
      ...(providerResourceId === undefined ? {} : { providerResourceId }),
      appliesWhen,
      precedence: {
        source: precedenceSource,
        ...(rank === undefined ? {} : { rank }),
        comparable: precedence.comparable,
      },
      resolution,
    };
    return { ok: true, value };
  }

  /** Materializes a local inventory export; it never reads provider values. */
  public materializeInventorySnapshot(
    input: unknown,
  ): FactMaterialization<InventorySnapshot> {
    if (!provisioningInputFitsBudget(input)) {
      return materializationFailure(this, "PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
    }
    const record = asRecord(input);
    if (record === undefined || !Array.isArray(record.items)) {
      return materializationFailure(this, "INVALID_INVENTORY_SNAPSHOT");
    }

    const inputId = this.requiredGenericIdentifier(record.inputId);
    const authorityId = this.requiredGenericIdentifier(record.authorityId);
    const asOf = this.timestamp(record.asOf);
    if (inputId === undefined || authorityId === undefined || asOf === undefined) {
      return materializationFailure(this, "INVALID_INVENTORY_SNAPSHOT");
    }

    const items: InventoryItem[] = [];
    for (let index = 0; index < record.items.length; index += 1) {
      const itemInput = record.items[index];
      const item = asRecord(itemInput);
      const providerResourceId = item === undefined
        ? undefined
        : this.materializeProviderResourceId(item.providerResourceId);
      if (item === undefined || providerResourceId === undefined || providerResourceId.authorityId !== authorityId) {
        return materializationFailure(this, "INVALID_PROVIDER_RESOURCE");
      }

      const declaredScopes = this.materializeOptionalExecutionScopes(item.declaredScopes);
      if (declaredScopes === null) {
        return materializationFailure(this, "INVALID_EXECUTION_SCOPE");
      }

      items.push({
        providerResourceId,
        ...(declaredScopes === undefined ? {} : { declaredScopes }),
      });
    }

    return {
      ok: true,
      value: {
        inputId,
        authorityId,
        asOf,
        items,
      },
    };
  }

  /**
   * `model` gaps are conservatively represented as binding gaps because Core
   * intentionally has only demand/binding/inventory coverage domains.
   */
  public materializeCoverageGap(input: unknown): FactMaterialization<CoverageGap> {
    if (!provisioningInputFitsBudget(input)) {
      return materializationFailure(this, "PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
    }
    const record = asRecord(input);
    if (record === undefined) {
      return materializationFailure(this, "INVALID_COVERAGE_GAP");
    }

    const id = this.requiredGenericIdentifier(record.idHint ?? record.id);
    const inputId = this.requiredGenericIdentifier(record.inputId);
    const pathOrAdapterId = this.requiredGenericIdentifier(record.pathOrAdapterId);
    const selector = this.materializeScopeSelector(record.potentiallyAffects);
    const rawDomain = record.domain;
    const domain = rawDomain === "model" ? "binding" : rawDomain;

    if (
      id === undefined ||
      inputId === undefined ||
      pathOrAdapterId === undefined ||
      selector === undefined ||
      !isCoverageDomain(domain)
    ) {
      return materializationFailure(this, "INVALID_COVERAGE_GAP");
    }

    const reason = rawDomain === "model"
      ? this.diagnosticCode("UNPROVEN_MODEL_DOMAIN")
      : this.bindingDiagnosticCode(record.reason);

    return {
      ok: true,
      value: {
        id,
        domain,
        inputId,
        pathOrAdapterId,
        potentiallyAffects: selector,
        reason,
      },
    };
  }

  /**
   * Closed-model dynamic-domain declarations have no adapter proof by
   * themselves. Valid static scopes are retained; finitePatternDomains is
   * deliberately omitted so no expansion can occur.
   */
  public materializeClosedModel(
    input: unknown,
  ): FactMaterialization<ClosedProvisioningModel> {
    if (!provisioningInputFitsBudget(input)) {
      return materializationFailure(this, "PROVISIONING_INPUT_ENTRY_LIMIT_EXCEEDED");
    }
    const record = asRecord(input);
    if (record === undefined || !Array.isArray(record.scopes)) {
      return materializationFailure(this, "INVALID_CLOSED_MODEL");
    }
    if (record.dynamicDomains !== undefined && !Array.isArray(record.dynamicDomains)) {
      return materializationFailure(this, "INVALID_CLOSED_MODEL");
    }

    const schemaVersion = this.requiredGenericIdentifier(record.schemaVersion);
    const modelInputId = this.requiredGenericIdentifier(record.inputId);
    const maxFiniteKeyDomain = record.maxFiniteKeyDomain;
    if (
      schemaVersion === undefined ||
      modelInputId === undefined ||
      typeof maxFiniteKeyDomain !== "number" ||
      !Number.isSafeInteger(maxFiniteKeyDomain) ||
      maxFiniteKeyDomain < 1 ||
      maxFiniteKeyDomain > this.#maxFiniteKeyDomain
    ) {
      return materializationFailure(this, "INVALID_CLOSED_MODEL");
    }

    const scopes: ClosedScope[] = [];
    for (let index = 0; index < record.scopes.length; index += 1) {
      const scopeInput = record.scopes[index];
      const scopeRecord = asRecord(scopeInput);
      if (
        scopeRecord === undefined ||
        typeof scopeRecord.closed !== "boolean" ||
        !Array.isArray(scopeRecord.declaredStages) ||
        !Array.isArray(scopeRecord.approvedFirstPartyRoots) ||
        !Array.isArray(scopeRecord.bindingRoots) ||
        !Array.isArray(scopeRecord.expectedAdapterInputs) ||
        !Array.isArray(scopeRecord.permittedExclusions) ||
        !Array.isArray(scopeRecord.inventoryAuthorities) ||
        !Array.isArray(scopeRecord.allowedExternalMechanisms) ||
        !isOutsideRootImportsPolicy(scopeRecord.outsideRootImports)
      ) {
        return materializationFailure(this, "INVALID_CLOSED_MODEL");
      }
      const scope = this.materializeExecutionScope(scopeRecord.scope);
      if (scope === undefined) {
        return materializationFailure(this, "INVALID_EXECUTION_SCOPE");
      }

      const declaredStages = this.materializeRequiredIdentifierArray(scopeRecord.declaredStages);
      const approvedFirstPartyRoots = this.materializeRootRelativePaths(scopeRecord.approvedFirstPartyRoots);
      const bindingRoots = this.materializeRootRelativePaths(scopeRecord.bindingRoots);
      const expectedInputs = this.materializeExpectedCoverageInputs(scopeRecord.expectedAdapterInputs);
      const permittedExclusions = this.materializePermittedExclusions(scopeRecord.permittedExclusions);
      const inventoryAuthorities = this.materializeInventoryAuthorities(scopeRecord.inventoryAuthorities);
      const allowedExternalMechanisms = this.materializeAllowedExternalMechanisms(
        scopeRecord.allowedExternalMechanisms,
      );

      if (
        declaredStages === undefined ||
        approvedFirstPartyRoots === undefined ||
        bindingRoots === undefined ||
        expectedInputs === undefined ||
        permittedExclusions === undefined ||
        inventoryAuthorities === undefined ||
        allowedExternalMechanisms === undefined
      ) {
        return materializationFailure(this, "INVALID_CLOSED_MODEL");
      }

      const selector = selectorFromClosedModelScope(scope, declaredStages);
      if (selector === undefined) {
        return materializationFailure(this, "INVALID_CLOSED_MODEL");
      }

      const coverage: ClosedModelCoverageContract = {
        modelInputId,
        maxFiniteKeyDomain,
        approvedFirstPartyRoots,
        bindingRoots,
        expectedInputs,
        permittedExclusions,
        inventoryAuthorities,
        allowedExternalMechanisms,
        outsideRootImports: scopeRecord.outsideRootImports,
      };

      scopes.push({
        selector,
        closed: scopeRecord.closed,
        coverage,
      });
    }

    return {
      ok: true,
      value: {
        schemaVersion,
        scopes,
      },
    };
  }

  /** A non-coverage warning W3 may surface for an unproven model domain. */
  public closedModelDiagnostics(input: unknown): readonly CoreDiagnostic[] {
    const record = asRecord(input);
    if (record !== undefined && Array.isArray(record.dynamicDomains) && record.dynamicDomains.length > 0) {
      return Object.freeze([
        { code: this.diagnosticCode("UNPROVEN_DYNAMIC_DOMAIN") },
      ]);
    }
    return Object.freeze([]);
  }

  /** Materializes a source-adapter reference after all text has crossed safety. */
  public materializeSecretReference(
    input: unknown,
  ): FactMaterialization<SecretReference> {
    const record = asRecord(input);
    if (record === undefined) {
      return materializationFailure(this, "INVALID_SECRET_REFERENCE");
    }

    const id = this.requiredGenericIdentifier(record.id);
    const requested = this.materializeLogicalKey(record.requested, false);
    const location = this.materializeLocation(record.location);
    const evidenceChain = this.materializeEvidenceChain(record.evidenceChain);

    if (
      id === undefined ||
      requested === undefined ||
      location === undefined ||
      evidenceChain === undefined ||
      !isDemandKind(record.demand) ||
      !isReferenceOperation(record.operation) ||
      !isReferenceResolution(record.resolution) ||
      !isConfidence(record.confidence) ||
      !isExposure(record.exposure)
    ) {
      return materializationFailure(this, "INVALID_SECRET_REFERENCE");
    }

    return {
      ok: true,
      value: {
        id,
        requested,
        demand: record.demand,
        operation: record.operation,
        resolution: record.resolution,
        confidence: record.confidence,
        location,
        exposure: record.exposure,
        evidenceChain,
      },
    };
  }

  /** Materializes one source-to-execution-scope edge, never an import string. */
  public materializeDemandEdge(input: unknown): FactMaterialization<DemandEdge> {
    const record = asRecord(input);
    if (record === undefined) {
      return materializationFailure(this, "INVALID_DEMAND_EDGE");
    }

    const id = this.requiredGenericIdentifier(record.id);
    const referenceId = this.requiredGenericIdentifier(record.referenceId);
    const scope = this.materializeExecutionScope(record.scope);
    const evidenceChain = this.materializeEvidenceChain(record.evidenceChain);

    if (
      id === undefined ||
      referenceId === undefined ||
      scope === undefined ||
      evidenceChain === undefined ||
      (record.origin !== "direct" && record.origin !== "consumer-derived")
    ) {
      return materializationFailure(this, "INVALID_DEMAND_EDGE");
    }

    return {
      ok: true,
      value: {
        id,
        referenceId,
        scope,
        origin: record.origin,
        evidenceChain,
      },
    };
  }

  /**
   * Materializes finite/pattern/unbounded dynamic evidence. Invalid finite or
   * pattern input is rejected so callers must retain scoped uncertainty rather
   * than serializing a fabricated key list.
   */
  public materializeDynamicLookupEdge(
    input: unknown,
  ): FactMaterialization<DynamicLookupEdge> {
    const record = asRecord(input);
    if (record === undefined) {
      return materializationFailure(this, "INVALID_DYNAMIC_LOOKUP");
    }

    const id = this.requiredGenericIdentifier(record.id);
    const referenceId = this.requiredGenericIdentifier(record.referenceId);
    const scope = this.materializeExecutionScope(record.scope);
    const domain = id === undefined ? undefined : this.materializeDynamicDomain(record.domain, id);
    const likelyKeys = this.materializeLogicalKeyArray(record.likelyKeys, true);
    const evidenceChain = this.materializeEvidenceChain(record.evidenceChain);

    if (
      id === undefined ||
      referenceId === undefined ||
      scope === undefined ||
      domain === undefined ||
      likelyKeys === undefined ||
      evidenceChain === undefined ||
      !isDynamicOrigin(record.origin) ||
      !isOptionalPatternConstraint(record.patternConstraint) ||
      !this.isDynamicLikelyKeysValid(domain, likelyKeys)
    ) {
      return materializationFailure(this, "INVALID_DYNAMIC_LOOKUP");
    }

    return {
      ok: true,
      value: {
        id,
        referenceId,
        scope,
        domain,
        origin: record.origin,
        ...(record.patternConstraint === undefined
          ? {}
          : { patternConstraint: record.patternConstraint }),
        likelyKeys,
        evidenceChain,
      },
    };
  }

  /** Deterministic, value-free pattern identity derived only from safe location. */
  public patternId(location: SafeLocation, kind: SafeKeyPattern["kind"]): SafeIdentifier {
    return asSafeIdentifier(
      `pattern-${location.start.line}-${location.start.column}-${kind}`,
    );
  }

  private requiredGenericIdentifier(value: unknown): SafeIdentifier | undefined {
    const identifier = this.genericIdentifier(value);
    return typeof identifier === "string" ? identifier : undefined;
  }

  private materializeLogicalKey(
    input: unknown,
    requireExact: boolean,
  ): LogicalKey | undefined {
    const record = asRecord(input);
    if (record === undefined || !isLogicalNamespace(record.namespace)) {
      return undefined;
    }

    const name = record.namespace === "env"
      ? this.environmentKey(record.name)
      : this.genericIdentifier(record.name);
    if (requireExact && typeof name !== "string") {
      return undefined;
    }

    return { namespace: record.namespace, name };
  }

  private materializeExecutionScope(input: unknown): ExecutionScope | undefined {
    const record = asRecord(input);
    if (record === undefined) {
      return undefined;
    }
    const id = this.requiredGenericIdentifier(record.id);
    const componentId = this.requiredGenericIdentifier(record.componentId);
    const stage = this.materializeStagePredicate(record.stage);

    if (
      id === undefined ||
      componentId === undefined ||
      stage === undefined ||
      !isPhase(record.phase) ||
      !isDeliveryChannel(record.channel)
    ) {
      return undefined;
    }

    return {
      id,
      componentId,
      phase: record.phase,
      stage,
      channel: record.channel,
    };
  }

  private materializeOptionalExecutionScopes(
    input: unknown,
  ): readonly ExecutionScope[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input)) {
      return null;
    }

    const scopes: ExecutionScope[] = [];
    for (const scopeInput of input) {
      const scope = this.materializeExecutionScope(scopeInput);
      if (scope === undefined) {
        return null;
      }
      scopes.push(scope);
    }
    return scopes;
  }

  private materializeScopeSelector(input: unknown): ScopeSelector | undefined {
    const record = asRecord(input);
    if (record === undefined) {
      return undefined;
    }

    const executionUnitIds = this.materializeOptionalIdentifierArray(record.executionUnitIds);
    const phases = this.materializeOptionalPhases(record.phases);
    const channels = this.materializeOptionalChannels(record.channels);
    const stage = this.materializeStagePredicate(record.stage);
    const condition = this.materializeConditionPredicate(record.condition);

    if (
      executionUnitIds === null ||
      phases === null ||
      channels === null ||
      stage === undefined ||
      condition === undefined
    ) {
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

  private materializeOptionalIdentifierArray(
    input: unknown,
  ): readonly SafeIdentifier[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0) {
      return null;
    }
    const values: SafeIdentifier[] = [];
    for (const value of input) {
      const identifier = this.requiredGenericIdentifier(value);
      if (identifier === undefined) {
        return null;
      }
      values.push(identifier);
    }
    return values;
  }

  private materializeOptionalPhases(input: unknown): readonly Phase[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0 || !input.every(isPhase)) {
      return null;
    }
    return input;
  }

  private materializeOptionalChannels(
    input: unknown,
  ): readonly DeliveryChannel[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0 || !input.every(isDeliveryChannel)) {
      return null;
    }
    return input;
  }

  private materializeStagePredicate(input: unknown): StagePredicate | undefined {
    const record = asRecord(input);
    if (record === undefined || typeof record.kind !== "string") {
      return undefined;
    }
    if (record.kind === "all" || record.kind === "unknown") {
      return { kind: record.kind };
    }
    if (record.kind !== "exact" || !Array.isArray(record.values) || record.values.length === 0) {
      return undefined;
    }
    const values = this.materializeOptionalIdentifierArray(record.values);
    if (values === undefined || values === null) {
      return undefined;
    }
    return { kind: "exact", values };
  }

  private materializeConditionPredicate(input: unknown): ConditionPredicate | undefined {
    const record = asRecord(input);
    if (record === undefined || typeof record.kind !== "string") {
      return undefined;
    }
    if (record.kind === "always" || record.kind === "unknown") {
      return { kind: record.kind };
    }
    if (record.kind !== "all" || !Array.isArray(record.clauses) || record.clauses.length === 0) {
      return undefined;
    }

    const clauses: { key: SafeIdentifier; operator: "equals" | "not-equals"; value: SafeIdentifier }[] = [];
    for (const clauseInput of record.clauses) {
      const clause = asRecord(clauseInput);
      const key = clause === undefined ? undefined : this.requiredGenericIdentifier(clause.key);
      const value = clause === undefined ? undefined : this.requiredGenericIdentifier(clause.value);
      if (
        clause === undefined ||
        key === undefined ||
        value === undefined ||
        (clause.operator !== "equals" && clause.operator !== "not-equals")
      ) {
        return undefined;
      }
      clauses.push({ key, operator: clause.operator, value });
    }
    return { kind: "all", clauses };
  }

  private materializeProviderResourceId(input: unknown): ProviderResourceId | undefined {
    const record = asRecord(input);
    if (record === undefined) {
      return undefined;
    }
    const authorityId = this.requiredGenericIdentifier(record.authorityId);
    const canonicalId = this.requiredGenericIdentifier(record.canonicalId);
    return authorityId === undefined || canonicalId === undefined
      ? undefined
      : { authorityId, canonicalId };
  }

  private materializeLocation(input: unknown): SafeLocation | undefined {
    const record = asRecord(input);
    if (record === undefined || !isSafePathValue(record.file)) {
      return undefined;
    }
    const start = materializePosition(record.start);
    const end = materializePosition(record.end);
    if (start === undefined || end === undefined) {
      return undefined;
    }
    return this.location(record.file as SafePath, start, end);
  }

  private materializeEvidenceChain(input: unknown): readonly Evidence[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const evidence: Evidence[] = [];
    for (const entryInput of input) {
      const entry = asRecord(entryInput);
      if (entry === undefined || !Array.isArray(entry.locations)) {
        return undefined;
      }
      const ruleId = this.requiredGenericIdentifier(entry.ruleId);
      if (ruleId === undefined) {
        return undefined;
      }
      const locations: SafeLocation[] = [];
      for (const locationInput of entry.locations) {
        const location = this.materializeLocation(locationInput);
        if (location === undefined) {
          return undefined;
        }
        locations.push(location);
      }
      evidence.push({
        ruleId,
        diagnosticCode: this.diagnosticCode(entry.diagnosticCode),
        locations,
      });
    }
    return evidence;
  }

  private materializeLogicalKeyArray(
    input: unknown,
    requireExact: boolean,
  ): readonly LogicalKey[] | undefined {
    if (!Array.isArray(input) || input.length > this.#maxFiniteKeyDomain) {
      return undefined;
    }
    const keys: LogicalKey[] = [];
    const seen = new Set<string>();
    for (const keyInput of input) {
      const key = this.materializeLogicalKey(keyInput, requireExact);
      if (key === undefined || typeof key.name !== "string") {
        return undefined;
      }
      const identity = `${key.namespace}:${key.name}`;
      if (seen.has(identity)) {
        return undefined;
      }
      seen.add(identity);
      keys.push(key);
    }
    return keys;
  }

  private materializeDynamicDomain(
    input: unknown,
    edgeId: SafeIdentifier,
  ): DynamicKeyDomain | undefined {
    const record = asRecord(input);
    if (record === undefined || typeof record.kind !== "string") {
      return undefined;
    }

    if (record.kind === "unbounded") {
      return isUnboundedReason(record.reason)
        ? { kind: "unbounded", reason: record.reason }
        : undefined;
    }

    if (record.kind === "finite") {
      if (!Array.isArray(record.keys) || record.keys.length === 0 || record.keys.length > this.#maxFiniteKeyDomain) {
        return undefined;
      }
      const keys: SafeIdentifier[] = [];
      const seen = new Set<string>();
      for (const rawKey of record.keys) {
        const key = this.environmentKey(rawKey);
        if (typeof key !== "string" || seen.has(key)) {
          return undefined;
        }
        seen.add(key);
        keys.push(key);
      }
      return { kind: "finite", keys };
    }

    if (record.kind !== "pattern") {
      return undefined;
    }
    const patternRecord = asRecord(record.pattern);
    if (patternRecord === undefined || typeof patternRecord.kind !== "string") {
      return undefined;
    }

    const patternId = this.patternIdForEdge(edgeId, patternRecord.kind);
    const prefix = this.safePatternSegment(patternRecord.prefix);
    const suffix = this.safePatternSegment(patternRecord.suffix);

    if (patternRecord.kind === "prefix" && prefix !== undefined) {
      return { kind: "pattern", pattern: { kind: "prefix", patternId, prefix } };
    }
    if (patternRecord.kind === "suffix" && suffix !== undefined) {
      return { kind: "pattern", pattern: { kind: "suffix", patternId, suffix } };
    }
    if (patternRecord.kind === "surrounded" && prefix !== undefined && suffix !== undefined) {
      return {
        kind: "pattern",
        pattern: { kind: "surrounded", patternId, prefix, suffix },
      };
    }
    return undefined;
  }

  private safePatternSegment(value: unknown): SafeIdentifier | undefined {
    const key = this.environmentKey(value);
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  private patternIdForEdge(edgeId: SafeIdentifier, kind: unknown): SafeIdentifier {
    const suffix = kind === "prefix" || kind === "suffix" || kind === "surrounded"
      ? kind
      : "unknown";
    const raw = `pattern-${edgeId}-${suffix}`;
    // `edgeId` already passed the generic safety boundary. Avoid silently
    // creating an overlong identifier if a caller supplied a maximal edge id.
    return raw.length <= 255
      ? asSafeIdentifier(raw)
      : asSafeIdentifier(`pattern-${suffix}`);
  }

  private isDynamicLikelyKeysValid(
    domain: DynamicKeyDomain,
    likelyKeys: readonly LogicalKey[],
  ): boolean {
    if (domain.kind === "unbounded") {
      return likelyKeys.length === 0;
    }
    if (domain.kind === "finite") {
      if (likelyKeys.length !== domain.keys.length) {
        return false;
      }
      const actual = new Set<string>();
      for (const key of likelyKeys) {
        if (key.namespace !== "env" || typeof key.name !== "string") {
          return false;
        }
        actual.add(key.name);
      }
      return actual.size === domain.keys.length && domain.keys.every((key) => actual.has(key));
    }

    return likelyKeys.every((key) =>
      key.namespace === "env" &&
      typeof key.name === "string" &&
      keyMatchesPattern(key.name, domain.pattern),
    );
  }

  private materializeRequiredIdentifierArray(
    input: unknown,
  ): readonly SafeIdentifier[] | undefined {
    if (!Array.isArray(input) || input.length === 0) {
      return undefined;
    }
    const values: SafeIdentifier[] = [];
    const seen = new Set<string>();
    for (const item of input) {
      const identifier = this.requiredGenericIdentifier(item);
      if (identifier === undefined || seen.has(identifier)) {
        return undefined;
      }
      seen.add(identifier);
      values.push(identifier);
    }
    return values;
  }

  private materializeRootRelativePaths(input: unknown): readonly SafePath[] | undefined {
    if (!Array.isArray(input) || input.length === 0) {
      return undefined;
    }
    const paths: SafePath[] = [];
    const seen = new Set<string>();
    for (const item of input) {
      const path = this.rootRelativePath(item);
      if (path === undefined || seen.has(path)) {
        return undefined;
      }
      seen.add(path);
      paths.push(path);
    }
    return paths;
  }

  /** Validates a model-declared root without resolving or opening it. */
  public rootRelativePath(value: unknown): SafePath | undefined {
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
      return undefined;
    }
    if (value === ".") {
      return ROOT_RELATIVE_PATH;
    }
    const segments = value.split(/[\\/]/u);
    if (segments.length === 0 || segments.some((segment) => !isSafeDisplaySegment(segment))) {
      return undefined;
    }
    return segments.join("/") as SafePath;
  }

  private materializeExpectedCoverageInputs(
    input: unknown,
  ): readonly ExpectedCoverageInput[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const values: ExpectedCoverageInput[] = [];
    const seen = new Set<string>();
    for (const itemInput of input) {
      const item = asRecord(itemInput);
      if (item === undefined || !isCoverageDomain(item.domain)) {
        return undefined;
      }
      // Never derive this from adapterId: collisions would create false closed coverage.
      const inputId = this.requiredGenericIdentifier(item.inputId);
      const adapterId = item.adapterId === undefined
        ? undefined
        : this.requiredGenericIdentifier(item.adapterId);
      const extensions = this.materializeOptionalExtensions(item.extensions);
      if (
        inputId === undefined ||
        (item.adapterId !== undefined && adapterId === undefined) ||
        extensions === null ||
        seen.has(`${item.domain}:${inputId}`)
      ) {
        return undefined;
      }
      seen.add(`${item.domain}:${inputId}`);
      values.push({
        inputId,
        domain: item.domain,
        ...(adapterId === undefined ? {} : { adapterId }),
        ...(extensions === undefined ? {} : { extensions }),
      });
    }
    return values;
  }

  private materializeOptionalExtensions(
    input: unknown,
  ): readonly SafeIdentifier[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0) {
      return null;
    }
    const values: SafeIdentifier[] = [];
    const seen = new Set<string>();
    for (const item of input) {
      if (typeof item !== "string" || !/^\.[A-Za-z0-9]{1,16}$/u.test(item)) {
        return null;
      }
      const extension = asSafeIdentifier(`extension-${item.slice(1).toLowerCase()}`);
      if (seen.has(extension)) {
        return null;
      }
      seen.add(extension);
      values.push(extension);
    }
    return values;
  }

  private materializePermittedExclusions(
    input: unknown,
  ): readonly PermittedExclusion[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const values: PermittedExclusion[] = [];
    for (const itemInput of input) {
      const item = asRecord(itemInput);
      const selector = item === undefined ? undefined : this.materializeScopeSelector(item.selector);
      if (item === undefined || selector === undefined) {
        return undefined;
      }
      values.push({
        selector,
        rationaleCode: this.diagnosticCode(item.rationaleCode),
      });
    }
    return values;
  }

  private materializeInventoryAuthorities(
    input: unknown,
  ): readonly InventoryAuthority[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const values: InventoryAuthority[] = [];
    const seen = new Set<string>();
    for (const itemInput of input) {
      const item = asRecord(itemInput);
      const authorityId = item === undefined ? undefined : this.requiredGenericIdentifier(item.authorityId);
      const inventoryInputId = item === undefined ? undefined : this.requiredGenericIdentifier(item.inventoryInputId);
      if (authorityId === undefined || inventoryInputId === undefined || seen.has(authorityId)) {
        return undefined;
      }
      seen.add(authorityId);
      values.push({ authorityId, inventoryInputId });
    }
    return values;
  }

  private materializeAllowedExternalMechanisms(
    input: unknown,
  ): readonly AllowedExternalMechanism[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const values: AllowedExternalMechanism[] = [];
    for (const itemInput of input) {
      const item = asRecord(itemInput);
      const selector = item === undefined ? undefined : this.materializeScopeSelector(item.selector);
      const mechanismId = item === undefined ? undefined : this.requiredGenericIdentifier(item.mechanismId);
      if (selector === undefined || mechanismId === undefined) {
        return undefined;
      }
      values.push({ selector, mechanismId });
    }
    return values;
  }

  private bindingDiagnosticCode(input: unknown): SafeDiagnosticCode {
    return this.diagnosticCode(
      typeof input === "string" ? rawDiagnosticCodeToSafeCode(input) : "INVALID_INPUT_SHAPE",
    );
  }
}

export class SafetyConfigurationError extends Error {
  public constructor(
    code: "INVALID_TRUSTED_ENVIRONMENT_KEY" | "INVALID_MAX_FINITE_KEY_DOMAIN",
  ) {
    super(code);
    this.name = "SafetyConfigurationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function materializationFailure<T>(
  factory: SafeFactFactory,
  code: string,
): FactMaterialization<T> {
  return { ok: false, diagnostic: { code: factory.diagnosticCode(code) } };
}

function selectorFromExecutionScope(scope: ExecutionScope): ScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

function selectorFromClosedModelScope(
  scope: ExecutionScope,
  declaredStages: readonly SafeIdentifier[],
): ScopeSelector | undefined {
  if (scope.stage.kind === "unknown") {
    return undefined;
  }
  const stage = scope.stage.kind === "all"
    ? { kind: "exact" as const, values: declaredStages }
    : scope.stage;

  if (
    stage.kind === "exact" &&
    !stage.values.every((value) => declaredStages.includes(value))
  ) {
    return undefined;
  }

  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

function materializePosition(value: unknown): SafePosition | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.line !== "number" ||
    typeof record.column !== "number" ||
    !Number.isSafeInteger(record.line) ||
    !Number.isSafeInteger(record.column) ||
    record.line < 0 ||
    record.column < 0
  ) {
    return undefined;
  }
  return { line: record.line, column: record.column };
}

function isSafePathValue(value: unknown): value is SafePath {
  if (typeof value !== "string") {
    return false;
  }
  if (value === OPAQUE_PATH) {
    return true;
  }
  const segments = value.split("/");
  return segments.length > 0 && segments.every(isSafeDisplaySegment);
}

function isPhase(value: unknown): value is Phase {
  return value === "runtime" || value === "build" || value === "test" || value === "dev" || value === "ci" || value === "unknown";
}

function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return value === "environment" || value === "build-substitution" || value === "mounted-file" || value === "provider-sdk" || value === "unknown";
}

function isLogicalNamespace(value: unknown): value is LogicalNamespace {
  return value === "env" || value === "config" || value === "secret-manager";
}

function isBindingSourceKind(value: unknown): value is BindingCandidate["sourceKind"] {
  return value === "manifest" || value === "secret-manager" || value === "external";
}

function isBindingResolution(value: unknown): value is BindingCandidate["resolution"] {
  return value === "exact" || value === "dynamic";
}

function isCoverageDomain(value: unknown): value is CoverageGap["domain"] {
  return value === "demand" || value === "binding" || value === "inventory";
}

function isOutsideRootImportsPolicy(
  value: unknown,
): value is "out-of-scope" | "included" {
  return value === "out-of-scope" || value === "included";
}

function isDemandKind(value: unknown): value is DemandKind {
  return value === "direct-read" || value === "eager-validation" || value === "declaration-only" || value === "wrapper-definition" || value === "literal-indicator";
}

function isReferenceOperation(value: unknown): value is SecretReference["operation"] {
  return value === "read" || value === "validate" || value === "wrapper" || value === "literal";
}

function isReferenceResolution(value: unknown): value is SecretReference["resolution"] {
  return value === "literal" || value === "constant-folded" || value === "wrapper-resolved" || value === "dynamic";
}

function isConfidence(value: unknown): value is SecretReference["confidence"] {
  return value === "high" || value === "medium" || value === "review";
}

function isExposure(value: unknown): value is SecretReference["exposure"] {
  return value === "server" || value === "client" || value === "worker" || value === "tooling" || value === "unknown";
}

function isDynamicOrigin(value: unknown): value is DynamicKeyOrigin {
  return value === "lexical" || value === "user-controlled" || value === "opaque";
}

function isOptionalPatternConstraint(value: unknown): value is DynamicLookupEdge["patternConstraint"] | undefined {
  return value === undefined || value === "adapter-proven" || value === "not-proven";
}

function isUnboundedReason(value: unknown): value is Extract<DynamicKeyDomain, { readonly kind: "unbounded" }>["reason"] {
  return value === "user-controlled" || value === "opaque" || value === "over-budget";
}

function keyMatchesPattern(key: string, pattern: SafeKeyPattern): boolean {
  switch (pattern.kind) {
    case "prefix":
      return key.startsWith(pattern.prefix);
    case "suffix":
      return key.endsWith(pattern.suffix);
    case "surrounded":
      return key.startsWith(pattern.prefix) && key.endsWith(pattern.suffix);
  }
}

function rawDiagnosticCodeToSafeCode(value: string): string {
  const known: Readonly<Record<string, string>> = {
    "invalid-input-shape": "INVALID_INPUT_SHAPE",
    "invalid-schema-version": "INVALID_SCHEMA_VERSION",
    "unknown-field": "UNKNOWN_FIELD",
    "missing-field": "MISSING_FIELD",
    "invalid-string": "INVALID_STRING",
    "invalid-enum": "INVALID_ENUM",
    "invalid-array": "INVALID_ARRAY",
    "invalid-stage-predicate": "INVALID_STAGE_PREDICATE",
    "invalid-condition-predicate": "INVALID_CONDITION_PREDICATE",
    "invalid-scope-selector": "INVALID_SCOPE_SELECTOR",
    "invalid-provider-resource": "INVALID_PROVIDER_RESOURCE",
    "invalid-precedence": "INVALID_PRECEDENCE",
    "invalid-timestamp": "INVALID_TIMESTAMP",
    "duplicate-candidate": "DUPLICATE_CANDIDATE",
    "invalid-closed-model": "INVALID_CLOSED_MODEL",
    "model-domain-over-budget": "MODEL_DOMAIN_OVER_BUDGET",
    "unsafe-identifier": "UNSAFE_IDENTIFIER",
  };
  return known[value] ?? "INVALID_INPUT_SHAPE";
}

export function isOpaqueIdentifier(value: Identifier): value is OpaqueIdentifier {
  return typeof value !== "string";
}

export function isSafeDisplaySegment(segment: string): boolean {
  return (
    SAFE_DISPLAY_SEGMENT_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !isSecretLikeToken(segment)
  );
}

/** Exported for focused tests; callers must not retain a classifier score. */
export function isSecretLikeToken(value: string): boolean {
  if (SECRET_LIKE_PREFIXES.some((pattern) => pattern.test(value))) {
    return true;
  }

  const compact = value.replace(/[._:@/-]/g, "");
  if (compact.length < 24) {
    return false;
  }

  const categories = [
    /[a-z]/.test(compact),
    /[A-Z]/.test(compact),
    /\d/.test(compact),
  ].filter(Boolean).length;

  return categories >= 3 && shannonEntropy(compact) >= 3.5;
}

function asSafeIdentifier(value: string): SafeIdentifier {
  return value as SafeIdentifier;
}

function normalizePosition(position: SafePosition): SafePosition {
  return {
    line: normalizeCoordinate(position.line),
    column: normalizeCoordinate(position.column),
  };
}

function normalizeCoordinate(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}
