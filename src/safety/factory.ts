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

  /**
   * Builds the single text-to-safe-fact boundary and validates its two local policy knobs.
   *
   * Inputs: Optional trusted environment-key iterable and optional finite-domain ceiling.
   * Outputs: A factory whose private allowlist and finite-key ceiling are ready for materializers.
   * Does not handle: Bounding or snapshotting an arbitrary iterable, fetching secrets, or checking filesystem paths.
   * Side effects: Iterates supplied keys (and can propagate iterator/getter errors), allocates a Set, and throws `SafetyConfigurationError` for an invalid observed key or limit.
   */
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

  /**
   * Admits a conventional or explicitly trusted environment-key spelling, otherwise replaces it with the opaque sentinel.
   *
   * Inputs: One unknown candidate name.
   * Outputs: A branded safe identifier for an allowed non-token-shaped string, or `OPAQUE_IDENTIFIER`.
   * Does not handle: Discovering aliases, confirming a key exists, or preserving rejected source text.
   * Side effects: Reads the factory allowlist and runs the local token classifier; it does not mutate the input.
   */
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

  /**
   * Admits a bounded generic identifier only when it passes the grammar and token-shape filter.
   *
   * Inputs: One unknown identifier candidate.
   * Outputs: A branded safe identifier or `OPAQUE_IDENTIFIER` without retaining rejected text.
   * Does not handle: Environment-key-specific allowlisting or semantic provider-ID validation.
   * Side effects: Classifies the provided string but does not mutate it or perform external access.
   */
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
   * Applies an adapter-owned identifier grammar while preventing stateful regular expressions from changing the decision.
   *
   * Inputs: An unknown candidate and the adapter's `RegExp` matcher.
   * Outputs: A safe identifier only for a matching string of at most 512 characters; otherwise the opaque sentinel.
   * Does not handle: Proving the matcher itself is safe, checking provider existence, or keeping rejected text.
   * Side effects: Mutates `matcher.lastIndex` to zero before and after `.test`, and invokes its matching behavior.
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
   * Converts an already canonical, in-root path pair into a display-safe relative path.
   *
   * Inputs: An approved root and canonical candidate path as strings.
   * Outputs: A slash-normalized safe relative path, or `OPAQUE_PATH` for root, escaping, malformed, or token-shaped segments.
   * Does not handle: Canonicalizing paths, resolving symlinks, or proving the root was approved.
   * Side effects: Calls Node path helpers and tests every segment; it does not read the filesystem.
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
      segments.some(/**
 * Rejects a relative-path segment that cannot safely appear in a report.
 *
 * Inputs: One segment split from the computed relative path.
 * Outputs: True when the segment fails `isSafeDisplaySegment`.
 * Does not handle: The other path segments or filesystem containment.
 * Side effects: Invokes the segment safety classifier for this array predicate.
 */
(segment) => !isSafeDisplaySegment(segment))
    ) {
      return OPAQUE_PATH;
    }

    return segments.join("/") as SafePath;
  }

  /**
   * Converts a potential diagnostic label to a bounded uppercase code, substituting one fixed fallback for anything else.
   *
   * Inputs: One unknown proposed code.
   * Outputs: A branded uppercase diagnostic code or `UNSAFE_DIAGNOSTIC`.
   * Does not handle: Mapping adapter-specific labels or retaining invalid code text.
   * Side effects: Tests the candidate against the bounded code grammar.
   */
   public diagnosticCode(value: unknown): SafeDiagnosticCode {
    if (typeof value !== "string" || !DIAGNOSTIC_CODE_PATTERN.test(value)) {
      return "UNSAFE_DIAGNOSTIC" as SafeDiagnosticCode;
    }

    return value as SafeDiagnosticCode;
  }

  /**
   * Accepts only a UTC timestamp spelling that parses and round-trips through the JavaScript date representation.
   *
   * Inputs: One unknown timestamp value.
   * Outputs: A canonical `SafeTimestamp`, or undefined when the grammar or parse is invalid.
   * Does not handle: Timezone conversion policy beyond ISO UTC or timestamp provenance.
   * Side effects: Calls `Date.parse` and allocates a `Date` for accepted strings.
   */
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

  /**
   * Constructs a source location while clamping invalid branded coordinates to zero.
   *
   * Inputs: A previously safe file path and start/end position objects.
   * Outputs: A new `SafeLocation` using normalized nonnegative integral positions.
   * Does not handle: Ordering start before end, re-validating the path brand, or locating source text.
   * Side effects: Allocates a location and two position objects; it does not modify supplied positions.
   */
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
   * Produces a diagnostic record whose code crosses the same safety boundary as other facts.
   *
   * Inputs: An unknown code and an optional already-safe location.
   * Outputs: A new diagnostic containing the sanitized code and, when supplied, the same location reference.
   * Does not handle: Validating a location supplied under its type brand or adding contextual text.
   * Side effects: Calls `diagnosticCode` and allocates the result record.
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

  /**
   * Validates one raw binding candidate and converts it into a safe, value-free Core binding fact.
   *
   * Inputs: An unknown adapter binding record, including scope, destination, precedence, and optional provider resource.
   * Outputs: `{ ok: true, value }` for a fully safe binding or `{ ok: false, diagnostic }` with a fixed code.
   * Does not handle: Reading a secret value, resolving precedence, proving a binding delivers to a live process, or guaranteeing whole-graph input bounds: its preflight has no cycle detection, global object-field quota, or bound on inherited enumerable-key traversal.
   * Side effects: Performs a budget preflight then materializes fields in a second pass; enumerable fields/getters can be read twice and may yield different values or throw.
   */
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

  /**
   * Validates an inventory snapshot and retains only provider resource identities and optional declared scopes.
   *
   * Inputs: An unknown snapshot record with an authority, timestamp, and item array.
   * Outputs: A safe snapshot or a fixed failure diagnostic; no secret payload is represented.
   * Does not handle: Fetching providers, validating authority ownership externally, deduplicating inventory items, or guaranteeing whole-graph input bounds: its preflight has no cycle detection, global object-field quota, or bound on inherited enumerable-key traversal.
   * Side effects: Performs a budget preflight then reads the record/items again; accessors can run in both passes and exceptions propagate outside the preflight only where later reads are unguarded.
   */
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
   * Converts an adapter coverage gap into safe evidence, treating model-domain gaps as binding uncertainty.
   *
   * Inputs: An unknown coverage record with an affected selector, input ID, adapter/path ID, domain, and optional reason.
   * Outputs: A safe `CoverageGap` or a fixed invalid-input diagnostic.
   * Does not handle: Recovering skipped content, assigning a precise source range, treating a model declaration as evidence of delivery, or guaranteeing whole-graph input bounds: its preflight has no cycle detection, global object-field quota, or bound on inherited enumerable-key traversal.
   * Side effects: Preflights then re-reads input properties; safe materializer calls allocate the output and can observe accessor changes between passes.
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
   * Converts a declared closed provisioning model into safe scope contracts without trusting dynamic-domain claims as finite coverage.
   *
   * Inputs: An unknown model containing schema/input IDs, finite cap, scopes, and optional dynamic-domain declarations.
   * Outputs: Safe scopes and coverage contracts, or one fixed materialization failure; dynamic domains are intentionally absent from the value.
   * Does not handle: Establishing closure at runtime, validating external adapter coverage, promoting declared dynamic keys into strong absence evidence, or guaranteeing whole-graph input bounds: its preflight has no cycle detection, global object-field quota, or bound on inherited enumerable-key traversal.
   * Side effects: Preflights then iterates nested arrays/records again, allocating contracts and observing getters more than once.
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

  /**
   * Reports the one fixed uncertainty warning when a model declares any dynamic domain.
   *
   * Inputs: The raw model-shaped value inspected for a nonempty `dynamicDomains` array.
   * Outputs: A frozen one-element array containing a mutable plain `UNPROVEN_DYNAMIC_DOMAIN` diagnostic record, or a frozen empty array.
   * Does not handle: Materializing the model, exposing individual domains, deciding whether a scope is closed, or deep-freezing the returned diagnostic record.
   * Side effects: Reads object/array properties and allocates/freezes a fresh result array.
   */
  public closedModelDiagnostics(input: unknown): readonly CoreDiagnostic[] {
    const record = asRecord(input);
    if (record !== undefined && Array.isArray(record.dynamicDomains) && record.dynamicDomains.length > 0) {
      return Object.freeze([
        { code: this.diagnosticCode("UNPROVEN_DYNAMIC_DOMAIN") },
      ]);
    }
    return Object.freeze([]);
  }

  /**
   * Converts one source-read claim into a safe reference whose untrusted name and evidence must pass nested materializers.
   *
   * Inputs: An unknown reference record containing ID, logical key, operation/resolution metadata, location, and evidence chain.
   * Outputs: A safe `SecretReference` or an `INVALID_SECRET_REFERENCE` failure without raw text.
   * Does not handle: Parsing source, proving execution, or accepting missing/invalid evidence.
   * Side effects: Reads nested record properties and allocates a reference/evidence graph; accessor errors can propagate.
   */
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

  /**
   * Converts the relationship from a safe source reference to an execution scope into a Core demand edge.
   *
   * Inputs: An unknown edge record with IDs, scope, allowed origin, and evidence chain.
   * Outputs: A safe direct/consumer-derived demand edge or one fixed invalid-edge diagnostic.
   * Does not handle: Verifying that the reference exists elsewhere in the graph or deciding reachability.
   * Side effects: Reads nested properties and allocates a value-free edge; accessor errors are not caught.
   */
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
   * Converts one dynamic environment lookup into conservative finite, pattern, or unbounded evidence.
   *
   * Inputs: An unknown edge record with scope, domain, origin, optional pattern constraint, likely keys, and evidence.
   * Outputs: A safe dynamic edge only when its likely keys agree with its domain, otherwise a fixed failure diagnostic.
   * Does not handle: Inferring omitted likely keys, resolving dynamic input at runtime, or making an unbounded domain finite.
   * Side effects: Reads nested input properties and allocates the edge/domain; accessor errors are not caught.
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

  /**
   * Derives a report-safe pattern identifier from already-safe source coordinates and the pattern category.
   *
   * Inputs: A `SafeLocation` and an allowed `SafeKeyPattern` kind.
   * Outputs: A deterministic branded identifier containing its start line, column, and kind.
   * Does not handle: Global uniqueness across files or validation of values already carrying safety brands.
   * Side effects: Interpolates the supplied primitives into a new string.
   */
  public patternId(location: SafeLocation, kind: SafeKeyPattern["kind"]): SafeIdentifier {
    return asSafeIdentifier(
      `pattern-${location.start.line}-${location.start.column}-${kind}`,
    );
  }

  /**
   * Narrows a generic identifier conversion to its concrete safe-string branch.
   *
   * Inputs: One unknown identifier value.
   * Outputs: A safe identifier or undefined when `genericIdentifier` returned the opaque sentinel.
   * Does not handle: Accepting environment-key exceptions or preserving rejected input.
   * Side effects: Delegates to `genericIdentifier` and its local classifier.
   */
   private requiredGenericIdentifier(value: unknown): SafeIdentifier | undefined {
    const identifier = this.genericIdentifier(value);
    return typeof identifier === "string" ? identifier : undefined;
  }

  /**
   * Validates a namespaced logical key while letting callers choose whether an opaque name is permissible.
   *
   * Inputs: An unknown `{ namespace, name }` record and an exact-name requirement.
   * Outputs: A logical key, including an opaque name only when `requireExact` is false, or undefined.
   * Does not handle: Resolving a logical key to a provider resource or interpreting its value.
   * Side effects: Reads record fields and delegates name classification to the namespace-specific converter.
   */
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

  /**
   * Builds the typed process scope used to compare source demand and declared provisioning.
   *
   * Inputs: An unknown scope record with IDs, phase, stage predicate, and delivery channel.
   * Outputs: A safe execution scope or undefined for any invalid field.
   * Does not handle: Demonstrating the component starts, resolving conditions, or comparing scopes.
   * Side effects: Reads record fields and creates stage/scope records.
   */
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

  /**
   * Distinguishes an omitted declared-scope list from an invalid list while converting every present scope.
   *
   * Inputs: An unknown optional array.
   * Outputs: Undefined for omission, a converted scope array for valid input, or null for a malformed element/list.
   * Does not handle: Deduplicating scopes or inferring an omitted scope.
   * Side effects: Iterates the array and allocates its converted list.
   */
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

  /**
   * Converts an applicability selector with optional unit/phase/channel dimensions and required stage/condition predicates.
   *
   * Inputs: An unknown selector record.
   * Outputs: A typed selector or undefined when any supplied dimension is invalid.
   * Does not handle: Evaluating conditions or deciding selector overlap.
   * Side effects: Reads nested fields and allocates a selector with omitted dimensions left absent.
   */
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

  /**
   * Validates an optional nonempty identifier array without collapsing omission into invalidity.
   *
   * Inputs: An unknown optional array of generic identifiers.
   * Outputs: Undefined for omission, a converted array for valid nonempty input, or null otherwise.
   * Does not handle: Deduplicating values or accepting opaque identifiers.
   * Side effects: Iterates input and allocates the converted list.
   */
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

  /**
   * Validates an optional nonempty execution-phase list while preserving omission.
   *
   * Inputs: An unknown optional array.
   * Outputs: Undefined for omission, the original typed phase array when every value is supported, or null.
   * Does not handle: Copying, deduplicating, or evaluating phase applicability.
   * Side effects: Calls `Array.isArray` and `.every`; it retains the caller array reference on success.
   */
   private materializeOptionalPhases(input: unknown): readonly Phase[] | undefined | null {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0 || !input.every(isPhase)) {
      return null;
    }
    return input;
  }

  /**
   * Validates an optional nonempty delivery-channel list while preserving omission.
   *
   * Inputs: An unknown optional array.
   * Outputs: Undefined for omission, the same valid channel array, or null for an empty/invalid list.
   * Does not handle: Copying, deduplicating, or proving channel delivery.
   * Side effects: Uses `.every` to inspect elements and retains the original array reference on success.
   */
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

  /**
   * Converts the three supported stage-predicate forms without treating an empty exact list as coverage.
   *
   * Inputs: An unknown stage-predicate record.
   * Outputs: `{ kind: all|unknown }`, a nonempty exact predicate, or undefined.
   * Does not handle: Matching stages against another selector or inferring an unknown stage.
   * Side effects: Reads record fields and allocates a predicate for accepted input.
   */
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

  /**
   * Converts an always, unknown, or nonempty conjunction of safe equality clauses.
   *
   * Inputs: An unknown condition record and, for `all`, clause records.
   * Outputs: A typed predicate or undefined when a clause, operator, or identifier is invalid.
   * Does not handle: Evaluating condition values in an environment or simplifying equivalent clauses.
   * Side effects: Iterates clauses and allocates converted clause/predicate records.
   */
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

  /**
   * Converts the provider namespace pair that lets inventory and binding facts be joined explicitly.
   *
   * Inputs: An unknown record with authority and provider-canonical identifiers.
   * Outputs: A safe pair or undefined when either identifier is rejected.
   * Does not handle: Looking up the provider resource, normalizing provider fields, or asserting authority ownership.
   * Side effects: Reads record fields and allocates the pair.
   */
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

  /**
   * Recreates a location only when its input path already carries a safe-path representation and coordinates are valid.
   *
   * Inputs: An unknown `{ file, start, end }` record.
   * Outputs: A normalized `SafeLocation` or undefined.
   * Does not handle: Resolving file paths, validating the source span, or declassifying opaque paths.
   * Side effects: Reads nested properties and delegates position normalization to `location`.
   */
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

  /**
   * Converts a complete ordered evidence chain only when every rule and location can cross the safety boundary.
   *
   * Inputs: An unknown array of evidence records with rule, diagnostic code, and location arrays.
   * Outputs: A new evidence array or undefined when any entry is malformed; an empty array is valid.
   * Does not handle: Establishing causal truth, deduplicating evidence, or retaining unsafe diagnostic text.
   * Side effects: Iterates nested arrays, reads properties, and allocates evidence/location arrays.
   */
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

  /**
   * Converts a bounded logical-key list and rejects duplicate namespace/name identities.
   *
   * Inputs: An unknown key array and a flag requiring concrete names.
   * Outputs: A newly allocated de-duplicated list or undefined for nonarrays, oversize input, invalid keys, or duplicates.
   * Does not handle: Sorting keys or validating a relationship to a binding/inventory resource.
   * Side effects: Allocates a result list and identity set while iterating the input.
   */
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

  /**
   * Converts finite, fixed-segment pattern, or explicitly unbounded dynamic-key evidence under the configured finite cap.
   *
   * Inputs: An unknown domain record and the safe dynamic-edge ID used to derive pattern IDs.
   * Outputs: A typed domain or undefined; finite domains require nonempty unique safe keys within the cap.
   * Does not handle: Expanding a pattern, deriving finite keys from opaque input, or accepting an unknown reason.
   * Side effects: Reads nested properties, iterates finite keys, and allocates sets/domain objects.
   */
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

  /**
   * Narrows an environment-key conversion to a nonempty segment usable in a prefix/suffix pattern.
   *
   * Inputs: One unknown fixed pattern segment.
   * Outputs: A safe nonempty environment-key identifier or undefined.
   * Does not handle: Arbitrary wildcard syntax or pattern expansion.
   * Side effects: Delegates to the environment-key safety classifier.
   */
   private safePatternSegment(value: unknown): SafeIdentifier | undefined {
    const key = this.environmentKey(value);
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  /**
   * Builds a bounded pattern identity from an already-safe edge ID without risking an overlong identifier.
   *
   * Inputs: A branded edge ID and an unknown proposed pattern kind.
   * Outputs: An ID with an accepted kind suffix or `unknown`, falling back to a short form over 255 characters.
   * Does not handle: Global uniqueness or validation of the edge-ID brand at runtime.
   * Side effects: Allocates/interpolates one or two strings.
   */
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

  /**
   * Enforces the representation invariant between a dynamic domain and its reported likely keys.
   *
   * Inputs: A validated dynamic domain and a converted logical-key list.
   * Outputs: True for no keys on unbounded domains, exact finite-set equality, or env keys matching a pattern.
   * Does not handle: Validating a key's safety brand or discovering additional possible keys.
   * Side effects: Allocates a set for finite comparison and runs array predicates over input keys.
   */
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
      return actual.size === domain.keys.length && domain.keys.every(/**
 * Confirms that one finite-domain key is present in the deduplicated reported-key set.
 *
 * Inputs: A safe finite domain key.
 * Outputs: Whether `actual` contains that exact string.
 * Does not handle: Namespace checks, which the surrounding loop already performed.
 * Side effects: Reads the closed-over `Set` during `.every`.
 */
(key) => actual.has(key));
    }

    return likelyKeys.every(/**
 * Confirms that one reported key is an exact environment key compatible with the fixed-segment pattern.
 *
 * Inputs: One converted logical key.
 * Outputs: True only for a concrete env name accepted by `keyMatchesPattern`.
 * Does not handle: Matching opaque keys or finding omitted candidates.
 * Side effects: Reads the closed-over pattern and calls the local matcher during `.every`.
 */
(key) =>
      key.namespace === "env" &&
      typeof key.name === "string" &&
      keyMatchesPattern(key.name, domain.pattern),
    );
  }

  /**
   * Converts a required nonempty identifier list and rejects repeated values.
   *
   * Inputs: An unknown array expected to contain generic identifiers.
   * Outputs: A newly allocated unique safe-ID list or undefined for an empty, malformed, rejected, or duplicate value.
   * Does not handle: Sorting, case-folding, or accepting opaque identifiers.
   * Side effects: Iterates input and allocates a result array plus a duplicate-detection set.
   */
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

  /**
   * Converts required model-relative paths and rejects repeated safe normalized spellings.
   *
   * Inputs: An unknown path array declared by a provisioning model.
   * Outputs: A new unique safe-path list or undefined for any absent/invalid/duplicate element.
   * Does not handle: Opening paths, resolving them against a root, or detecting symlink escapes.
   * Side effects: Iterates values and allocates a result list and duplicate-detection set.
   */
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

  /**
   * Validates a reportable model-relative path spelling without resolving it against the filesystem.
   *
   * Inputs: One unknown relative-path string.
   * Outputs: `<root>` for the whole-string root marker `.`, a slash-normalized safe path for non-dot safe segments, or undefined.
   * Does not handle: Normalizing embedded `.` or any `..` segment (it rejects them), filesystem existence, or root containment.
   * Side effects: Splits and classifies every segment without performing I/O.
   */
  public rootRelativePath(value: unknown): SafePath | undefined {
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
      return undefined;
    }
    if (value === ".") {
      return ROOT_RELATIVE_PATH;
    }
    const segments = value.split(/[\\/]/u);
    if (segments.length === 0 || segments.some(/**
 * Rejects one model path segment that would be unsafe or ambiguous in output.
 *
 * Inputs: One slash- or backslash-delimited segment.
 * Outputs: True when `isSafeDisplaySegment` rejects it.
 * Does not handle: Joining or resolving the remaining path.
 * Side effects: Invokes the local segment classifier during `.some`.
 */
(segment) => !isSafeDisplaySegment(segment))) {
      return undefined;
    }
    return segments.join("/") as SafePath;
  }

  /**
   * Converts declared coverage inputs while retaining their explicit IDs rather than inferring identity from adapter names.
   *
   * Inputs: An unknown array of input/domain records with optional adapter and extension declarations.
   * Outputs: A new list with unique `domain:inputId` identities or undefined for malformed/duplicate records.
   * Does not handle: Verifying the adapter ran, deriving IDs from names, or accepting unsupported file suffixes.
   * Side effects: Iterates nested records and allocates output plus a duplicate-detection set.
   */
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

  /**
   * Converts an optional list of file suffixes into normalized extension identifiers.
   *
   * Inputs: An unknown optional array of dot-prefixed alphanumeric suffix strings.
   * Outputs: Undefined for omission, a normalized `extension-...` list for valid input, or null for empty/invalid/duplicate suffixes.
   * Does not handle: Compound suffixes, filesystem case semantics, or extension-to-adapter routing.
   * Side effects: Lowercases suffixes and allocates identifiers, a list, and a duplicate set.
   */
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

  /**
   * Converts declared coverage exclusions into selector/rationale pairs without judging whether an exclusion is appropriate.
   *
   * Inputs: An unknown array of selector and rationale records.
   * Outputs: A new exclusion list or undefined when an entry cannot be materialized.
   * Does not handle: Deduplicating selectors, evaluating the exclusion, or suppressing downstream findings.
   * Side effects: Iterates records and allocates converted exclusions; raw rationale text becomes a safe fixed code.
   */
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

  /**
   * Converts inventory authority declarations while requiring a unique authority ID per closed scope.
   *
   * Inputs: An unknown array of authority/input-ID records.
   * Outputs: A new unique-authority list or undefined for malformed or duplicate authorities.
   * Does not handle: Contacting an inventory source or proving an input is authoritative.
   * Side effects: Iterates records and allocates the result and authority set.
   */
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

  /**
   * Converts declared out-of-code delivery mechanisms into selector/mechanism records.
   *
   * Inputs: An unknown array of selector and mechanism-ID records.
   * Outputs: A new allowed-mechanism list or undefined for any malformed member.
   * Does not handle: Verifying an external mechanism is active or resolving its delivery channel.
   * Side effects: Iterates records and allocates converted values.
   */
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

  /**
   * Maps an adapter reason through the fixed raw-to-safe diagnostic vocabulary.
   *
   * Inputs: An unknown reason value.
   * Outputs: The recognized safe code or the fixed invalid-input code.
   * Does not handle: Preserving unknown reason text or accepting arbitrary diagnostic labels.
   * Side effects: Calls the safe diagnostic-code conversion after local vocabulary lookup.
   */
   private bindingDiagnosticCode(input: unknown): SafeDiagnosticCode {
    return this.diagnosticCode(
      typeof input === "string" ? rawDiagnosticCodeToSafeCode(input) : "INVALID_INPUT_SHAPE",
    );
  }
}

export class SafetyConfigurationError extends Error {
  /**
   * Constructs the public configuration error with a fixed non-sensitive error code.
   *
   * Inputs: One of the two recognized local policy-configuration failure codes.
   * Outputs: An `Error` instance named `SafetyConfigurationError` whose message is that code.
   * Does not handle: Input redaction beyond accepting only fixed code literals or attaching a causal error.
   * Side effects: Initializes inherited error fields and sets `name`.
   */
   public constructor(
    code: "INVALID_TRUSTED_ENVIRONMENT_KEY" | "INVALID_MAX_FINITE_KEY_DOMAIN",
  ) {
    super(code);
    this.name = "SafetyConfigurationError";
  }
}

/**
 * Narrows a non-null, non-array object to the unchecked property-record shape used by materializers.
 *
 * Inputs: One unknown value.
 * Outputs: The same object under a record assertion, or undefined for primitives, null, and arrays.
 * Does not handle: Schema validation, prototype safety, getter evaluation, or copying fields.
 * Side effects: Performs only type/array checks and retains the original object reference.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Creates the uniform value-free error branch returned when a fact cannot cross the safety boundary.
 *
 * Inputs: The active factory and a fixed/raw diagnostic label.
 * Outputs: `{ ok: false, diagnostic }` with the factory-sanitized code and no partial value.
 * Does not handle: Logging, retaining rejected input, or recovering malformed facts.
 * Side effects: Calls `factory.diagnosticCode` and allocates the nested result objects.
 */
function materializationFailure<T>(
  factory: SafeFactFactory,
  code: string,
): FactMaterialization<T> {
  return { ok: false, diagnostic: { code: factory.diagnosticCode(code) } };
}

/**
 * Converts an execution scope into the exact, unconditional selector used by demand edges.
 *
 * Inputs: One validated execution scope.
 * Outputs: A new selector fixing its ID, phase, stage, and channel with `condition: always`.
 * Does not handle: Checking declared stages or evaluating runtime conditions.
 * Side effects: Allocates selector arrays and a condition record while retaining the stage reference.
 */
function selectorFromExecutionScope(scope: ExecutionScope): ScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

/**
 * Builds a closed-model selector only when the execution scope's known stages fit the declared stage inventory.
 *
 * Inputs: A validated scope and its declared safe stage IDs.
 * Outputs: An exact unconditional selector or undefined for an unknown/uncovered scope stage.
 * Does not handle: Deduplicating declared stages, proving the declaration is complete, or evaluating conditions.
 * Side effects: Runs `.every`/`.includes` on stage arrays and allocates a selector on success.
 */
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
    !stage.values.every(/**
 * Checks that one exact scope-stage value was listed in the model declaration.
 *
 * Inputs: One safe stage value from the scope predicate.
 * Outputs: Whether the closed-over declaration includes it.
 * Does not handle: Stage-pattern matching or declaration completeness.
 * Side effects: Reads the `declaredStages` array during `.every`.
 */
(value) => declaredStages.includes(value))
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

/**
 * Validates the two zero-based coordinates used in a serialized source position.
 *
 * Inputs: One unknown record candidate.
 * Outputs: A `{ line, column }` position for nonnegative safe integers, or undefined.
 * Does not handle: Position ordering, file association, or coercing numeric strings.
 * Side effects: Reads the candidate's two properties and allocates a position record on success.
 */
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

/**
 * Narrows a string to either the opaque-path sentinel or a slash-delimited sequence of safe display segments.
 *
 * Inputs: One unknown value.
 * Outputs: A type-guard result for valid `SafePath` representations.
 * Does not handle: Root containment, existence, backslash normalization, or re-branding a path.
 * Side effects: Splits non-opaque strings and calls the segment predicate.
 */
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

/**
 * Recognizes the closed vocabulary of execution phases accepted by fact materialization.
 *
 * Inputs: One unknown value.
 * Outputs: A type-guard result for `runtime`, `build`, `test`, `dev`, `ci`, or `unknown`.
 * Does not handle: Phase aliases, runtime detection, or semantic ordering.
 * Side effects: Performs fixed literal comparisons only.
 */
function isPhase(value: unknown): value is Phase {
  return value === "runtime" || value === "build" || value === "test" || value === "dev" || value === "ci" || value === "unknown";
}

/**
 * Recognizes the fixed set of provisioning delivery channels represented in scopes.
 *
 * Inputs: One unknown value.
 * Outputs: A type-guard result for known channel literals.
 * Does not handle: Verifying delivery behavior or mapping provider-specific names.
 * Side effects: Performs fixed literal comparisons only.
 */
function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return value === "environment" || value === "build-substitution" || value === "mounted-file" || value === "provider-sdk" || value === "unknown";
}

/**
 * Recognizes the three logical namespaces permitted in normalized secret keys.
 *
 * Inputs: One unknown namespace value.
 * Outputs: A type-guard result for `env`, `config`, or `secret-manager`.
 * Does not handle: Mapping aliases or resolving namespace contents.
 * Side effects: Performs fixed literal comparisons only.
 */
function isLogicalNamespace(value: unknown): value is LogicalNamespace {
  return value === "env" || value === "config" || value === "secret-manager";
}

/**
 * Recognizes the source classifications allowed on a provisioning binding candidate.
 *
 * Inputs: One unknown source-kind value.
 * Outputs: A type-guard result for `manifest`, `secret-manager`, or `external`.
 * Does not handle: Validating the associated manifest/provider/external mechanism.
 * Side effects: Performs fixed literal comparisons only.
 */
function isBindingSourceKind(value: unknown): value is BindingCandidate["sourceKind"] {
  return value === "manifest" || value === "secret-manager" || value === "external";
}

/**
 * Recognizes whether a binding claim is represented as exact or dynamic.
 *
 * Inputs: One unknown resolution value.
 * Outputs: A type-guard result for `exact` or `dynamic`.
 * Does not handle: Proving a claim is actually exact.
 * Side effects: Performs fixed literal comparisons only.
 */
function isBindingResolution(value: unknown): value is BindingCandidate["resolution"] {
  return value === "exact" || value === "dynamic";
}

/**
 * Recognizes the coverage-domain vocabulary used to attribute incomplete analysis.
 *
 * Inputs: One unknown domain value.
 * Outputs: A type-guard result for `demand`, `binding`, or `inventory`.
 * Does not handle: Determining whether coverage is actually complete.
 * Side effects: Performs fixed literal comparisons only.
 */
function isCoverageDomain(value: unknown): value is CoverageGap["domain"] {
  return value === "demand" || value === "binding" || value === "inventory";
}

/**
 * Recognizes the two explicit policies for imports that resolve outside the scan root.
 *
 * Inputs: One unknown policy value.
 * Outputs: A type-guard result for `out-of-scope` or `included`.
 * Does not handle: Resolving imports or enforcing either policy.
 * Side effects: Performs fixed literal comparisons only.
 */
function isOutsideRootImportsPolicy(
  value: unknown,
): value is "out-of-scope" | "included" {
  return value === "out-of-scope" || value === "included";
}

/**
 * Recognizes the source-demand classifications retained on normalized references.
 *
 * Inputs: One unknown demand kind.
 * Outputs: A type-guard result for the five supported Core demand literals.
 * Does not handle: Inferring demand from source code or ordering demand strength.
 * Side effects: Performs fixed literal comparisons only.
 */
function isDemandKind(value: unknown): value is DemandKind {
  return value === "direct-read" || value === "eager-validation" || value === "declaration-only" || value === "wrapper-definition" || value === "literal-indicator";
}

/**
 * Recognizes the operation vocabulary recorded on a secret reference.
 *
 * Inputs: One unknown operation value.
 * Outputs: A type-guard result for `read`, `validate`, `wrapper`, or `literal`.
 * Does not handle: Executing an operation or confirming runtime behavior.
 * Side effects: Performs fixed literal comparisons only.
 */
function isReferenceOperation(value: unknown): value is SecretReference["operation"] {
  return value === "read" || value === "validate" || value === "wrapper" || value === "literal";
}

/**
 * Recognizes the extraction-resolution vocabulary retained in a reference fact.
 *
 * Inputs: One unknown resolution value.
 * Outputs: A type-guard result for literal, folded, wrapper, or dynamic observations.
 * Does not handle: Re-running extraction or proving a resolution is complete.
 * Side effects: Performs fixed literal comparisons only.
 */
function isReferenceResolution(value: unknown): value is SecretReference["resolution"] {
  return value === "literal" || value === "constant-folded" || value === "wrapper-resolved" || value === "dynamic";
}

/**
 * Recognizes the three confidence labels that normalized references may carry.
 *
 * Inputs: One unknown confidence value.
 * Outputs: A type-guard result for `high`, `medium`, or `review`.
 * Does not handle: Calculating confidence from evidence.
 * Side effects: Performs fixed literal comparisons only.
 */
function isConfidence(value: unknown): value is SecretReference["confidence"] {
  return value === "high" || value === "medium" || value === "review";
}

/**
 * Recognizes the exposure labels used to distinguish server, client, worker, tooling, and unknown contexts.
 *
 * Inputs: One unknown exposure value.
 * Outputs: A type-guard result for the supported exposure literals.
 * Does not handle: Determining deployment visibility or auditing client bundles.
 * Side effects: Performs fixed literal comparisons only.
 */
function isExposure(value: unknown): value is SecretReference["exposure"] {
  return value === "server" || value === "client" || value === "worker" || value === "tooling" || value === "unknown";
}

/**
 * Recognizes whether dynamic-key evidence was lexical, user-controlled, or opaque.
 *
 * Inputs: One unknown origin value.
 * Outputs: A type-guard result for the three origin literals.
 * Does not handle: Reclassifying source expressions or ranking origin reliability.
 * Side effects: Performs fixed literal comparisons only.
 */
function isDynamicOrigin(value: unknown): value is DynamicKeyOrigin {
  return value === "lexical" || value === "user-controlled" || value === "opaque";
}

/**
 * Recognizes omission or the two explicit confidence labels for a dynamic pattern constraint.
 *
 * Inputs: One unknown value.
 * Outputs: A type-guard result for undefined, `adapter-proven`, or `not-proven`.
 * Does not handle: Assessing whether a pattern is in fact proven.
 * Side effects: Performs fixed literal comparisons only.
 */
function isOptionalPatternConstraint(value: unknown): value is DynamicLookupEdge["patternConstraint"] | undefined {
  return value === undefined || value === "adapter-proven" || value === "not-proven";
}

/**
 * Recognizes why a dynamic key domain cannot be represented as a bounded finite set.
 *
 * Inputs: One unknown reason value.
 * Outputs: A type-guard result for `user-controlled`, `opaque`, or `over-budget`.
 * Does not handle: Selecting a reason from source analysis.
 * Side effects: Performs fixed literal comparisons only.
 */
function isUnboundedReason(value: unknown): value is Extract<DynamicKeyDomain, { readonly kind: "unbounded" }>["reason"] {
  return value === "user-controlled" || value === "opaque" || value === "over-budget";
}

/**
 * Tests a concrete key against one already-safe fixed prefix, suffix, or both.
 *
 * Inputs: A string key and a typed safe pattern.
 * Outputs: Whether the key satisfies the pattern's fixed segments.
 * Does not handle: Wildcards beyond the implicit middle gap or validation of the key/pattern brands.
 * Side effects: Calls string prefix/suffix comparisons only.
 */
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

/**
 * Maps recognized adapter parser labels to the fixed diagnostics that may enter normalized facts.
 *
 * Inputs: One raw adapter diagnostic label.
 * Outputs: The mapped uppercase code or `INVALID_INPUT_SHAPE` for unknown labels.
 * Does not handle: Passing arbitrary source text through to reports.
 * Side effects: Reads the local lookup table without mutation.
 */
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

/**
 * Distinguishes the non-string opaque identifier sentinel from a concrete safe identifier.
 *
 * Inputs: One normalized `Identifier`.
 * Outputs: True only when its representation is the opaque non-string branch.
 * Does not handle: Revalidating a concrete string or revealing rejected source text.
 * Side effects: Performs a type check only.
 */
export function isOpaqueIdentifier(value: Identifier): value is OpaqueIdentifier {
  return typeof value !== "string";
}

/**
 * Accepts one bounded report-path segment only when its grammar and token-shape classification are safe.
 *
 * Inputs: A string segment with no path separator supplied separately.
 * Outputs: True for conventional non-dot, non-token-shaped segments up to the configured length.
 * Does not handle: Joining paths, filesystem containment, or Unicode normalization.
 * Side effects: Tests the segment grammar and calls `isSecretLikeToken`.
 */
export function isSafeDisplaySegment(segment: string): boolean {
  return (
    SAFE_DISPLAY_SEGMENT_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !isSecretLikeToken(segment)
  );
}

/**
 * Detects well-known credential prefixes and high-entropy mixed-character strings that should be kept opaque.
 *
 * Inputs: One candidate string.
 * Outputs: True for known token prefixes or long mixed-category strings whose Shannon entropy reaches the local threshold.
 * Does not handle: Proving that text is a secret or safely recovering a false positive.
 * Side effects: Tests prefix patterns; for long values, allocates normalized text/category data and computes entropy.
 */
export function isSecretLikeToken(value: string): boolean {
  if (SECRET_LIKE_PREFIXES.some(/**
 * Tests the candidate string against one known credential-prefix regular expression.
 *
 * Inputs: One compiled prefix pattern from the closed classifier list.
 * Outputs: Whether it matches the closed-over candidate string.
 * Does not handle: Entropy analysis or deciding the final classification alone.
 * Side effects: Invokes `RegExp.test` during `.some`; non-global patterns do not retain matcher position.
 */
(pattern) => pattern.test(value))) {
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

/**
 * Applies the compile-time safe-identifier brand after a caller has already enforced its grammar.
 *
 * Inputs: A string established by the caller as safe.
 * Outputs: The same string with the `SafeIdentifier` brand.
 * Does not handle: Any runtime validation or token detection.
 * Side effects: None; this is a type assertion with no allocation.
 */
function asSafeIdentifier(value: string): SafeIdentifier {
  return value as SafeIdentifier;
}

/**
 * Creates a position copy whose line and column are independently clamped to valid coordinates.
 *
 * Inputs: A position-shaped object carrying numeric coordinates.
 * Outputs: A new safe position using `normalizeCoordinate` for both fields.
 * Does not handle: Checking ordering relative to another position or source bounds.
 * Side effects: Reads both input fields and allocates the returned record.
 */
function normalizePosition(position: SafePosition): SafePosition {
  return {
    line: normalizeCoordinate(position.line),
    column: normalizeCoordinate(position.column),
  };
}

/**
 * Keeps a nonnegative safe integer coordinate and substitutes zero for every other number.
 *
 * Inputs: One numeric coordinate.
 * Outputs: The same coordinate when safe/nonnegative, otherwise zero.
 * Does not handle: Coercion, rounding, or maximum source-file bounds.
 * Side effects: None; performs numeric predicates only.
 */
function normalizeCoordinate(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Computes base-two Shannon entropy over the character-frequency distribution of a string.
 *
 * Inputs: One string, expected to be the separator-stripped candidate from the token classifier.
 * Outputs: Its entropy in bits per character (zero for a nonempty single-character distribution; `NaN` is possible for an empty string but callers avoid it).
 * Does not handle: Cryptographic randomness testing, token validation, or Unicode grapheme normalization.
 * Side effects: Allocates and mutates a local frequency map while traversing characters.
 */
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
