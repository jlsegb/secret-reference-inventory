import { open, realpath } from "node:fs/promises";

import {
  adaptCoreFactBuilder,
  coreBindingResolutionPort,
  parseBindingManifest,
  parseClosedProvisioningModel,
  parseInventorySnapshot,
} from "../binding-adapters/index.js";
import {
  reconcile,
  selectorMayAffectScope,
  type BindingCandidate,
  type ClosedProvisioningModel,
  type CoverageGap,
  type CoverageInputStatus,
  type DemandEdge,
  type DynamicLookupEdge,
  type ExecutionScope,
  type InventorySnapshot,
  type ReconciliationInput,
  type SafeDiagnosticCode,
  type SafeIdentifier,
  type ScopeSelector,
  type SecretReference,
} from "../core/index.js";
import {
  discoverSources,
  isSegmentDescendant,
  type DiscoveryResult,
  type DiscoveredSourceFile,
} from "../discovery/index.js";
import type { ReportingInput } from "../reporters/index.js";
import { OPAQUE_PATH, SafeFactFactory, type SafePath } from "../safety/index.js";
import {
  extractTypeScriptSource,
  type SourceExtractionResult,
} from "../ts-adapter/index.js";

import type { LocalJsonReadResult } from "./local-json.js";
import { AppError, type LocalAnalysis } from "./types.js";

const DEFAULT_SOURCE_INPUT_ID = "source-discovery";
const DEFAULT_SCOPE_ID = "local-default-runtime";
const DEFAULT_COMPONENT_ID = "local-default";
const MAX_READ_SOURCE_BYTES = 5 * 1024 * 1024;

export interface ReconcileDocuments {
  readonly bindings: LocalJsonReadResult;
  readonly inventory: LocalJsonReadResult;
  readonly closedModel?: LocalJsonReadResult;
}

interface SourceFacts {
  readonly factory: SafeFactFactory;
  readonly discovery: DiscoveryResult;
  readonly scope: ExecutionScope;
  readonly selector: ScopeSelector;
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly coverageGaps: readonly CoverageGap[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

interface ParsedProvisioning {
  readonly bindingCandidates: readonly BindingCandidate[];
  readonly bindingResolutions: ReconciliationInput["bindingResolutions"];
  readonly inventorySnapshots: readonly InventorySnapshot[];
  readonly closedModel?: ClosedProvisioningModel;
  readonly coverageGaps: readonly CoverageGap[];
  readonly coverageInputs: readonly CoverageInputStatus[];
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

/**
 * Scan first-party TypeScript/JavaScript only. It never invokes repository
 * code, reads process environment values, or performs a network request.
 */
export async function scanLocalRoot(root: string): Promise<LocalAnalysis> {
  const source = await collectSourceFacts(root);
  return reconcileCollected(source, emptyProvisioning(source));
}

/**
 * Scan code and reconcile it with explicitly supplied local JSON exports.
 * Parse/read failures become scoped coverage uncertainty instead of a hidden
 * clean result.
 */
export async function reconcileLocalRoot(
  root: string,
  documents: ReconcileDocuments,
): Promise<LocalAnalysis> {
  const source = await collectSourceFacts(root);
  const provisioning = await collectProvisioning(source, documents);
  return reconcileCollected(source, provisioning);
}

async function collectSourceFacts(root: string): Promise<SourceFacts> {
  const factory = new SafeFactFactory();
  let discovery: DiscoveryResult;
  try {
    discovery = await discoverSources({ roots: [root] }, factory);
  } catch {
    throw new AppError("APP_DISCOVERY_FAILED");
  }

  const scope = defaultScope(factory);
  const selector = selectorForScope(scope);
  const gaps = new AppGapBuilder(factory, selector);
  const diagnostics: SafeDiagnosticCode[] = [];
  const references: SecretReference[] = [];
  const demandEdges: DemandEdge[] = [];
  const dynamicLookupEdges: DynamicLookupEdge[] = [];

  for (const skip of discovery.skips) {
    if (!isRelevantDiscoverySkip(skip.code)) {
      continue;
    }
    gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
    diagnostics.push(factory.diagnosticCode("APP_DISCOVERY_INCOMPLETE"));
  }

  for (const [fileIndex, file] of discovery.files.entries()) {
    const sourceText = await readDiscoveredSource(file);
    if (sourceText === undefined) {
      gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
      diagnostics.push(factory.diagnosticCode("APP_SOURCE_READ_FAILED"));
      continue;
    }

    const extraction = extractTypeScriptSource(
      {
        sourceText,
        file: file.displayPath,
        sourceId: requiredIdentifier(factory, `source-file-${fileIndex + 1}`),
        language: file.language,
        scope,
        exposure: "unknown",
      },
      factory,
    );

    const namespaced = namespaceExtraction(extraction, fileIndex + 1, factory);
    references.push(...namespaced.references);
    demandEdges.push(...namespaced.demandEdges);
    dynamicLookupEdges.push(...namespaced.dynamicLookupEdges);

    if (extraction.diagnostics.length > 0 || namespaced.incomplete) {
      gaps.add("demand", DEFAULT_SOURCE_INPUT_ID);
      diagnostics.push(factory.diagnosticCode("APP_SOURCE_EXTRACTION_INCOMPLETE"));
    }
  }

  return {
    factory,
    discovery,
    scope,
    selector,
    references: Object.freeze(references),
    demandEdges: Object.freeze(demandEdges),
    dynamicLookupEdges: Object.freeze(dynamicLookupEdges),
    coverageGaps: gaps.values,
    diagnostics: Object.freeze(diagnostics),
  };
}

function emptyProvisioning(source: SourceFacts): ParsedProvisioning {
  return {
    bindingCandidates: [],
    bindingResolutions: [],
    inventorySnapshots: [],
    coverageGaps: [],
    coverageInputs: [
      coverageInput(
        source.factory,
        DEFAULT_SOURCE_INPUT_ID,
        "demand",
        source.coverageGaps.length === 0 ? "complete" : "incomplete",
        source.selector,
      ),
    ],
    diagnostics: [],
  };
}

async function collectProvisioning(
  source: SourceFacts,
  documents: ReconcileDocuments,
): Promise<ParsedProvisioning> {
  const builder = adaptCoreFactBuilder(source.factory);
  const gaps = new AppGapBuilder(source.factory, source.selector, source.coverageGaps.length);
  const diagnostics: SafeDiagnosticCode[] = [];

  const closed = collectClosedModel(documents.closedModel, builder, gaps, diagnostics);
  const binding = collectBindings(documents.bindings, builder, source.factory, gaps, diagnostics);
  const inventory = collectInventory(documents.inventory, builder, source.factory, gaps, diagnostics);

  const closedModel = closed.model;
  const sourceStatus = coverageInput(
    source.factory,
    DEFAULT_SOURCE_INPUT_ID,
    "demand",
    source.coverageGaps.length === 0 ? "complete" : "incomplete",
    source.selector,
  );

  const coverageInputs: CoverageInputStatus[] = [sourceStatus];
  if (binding.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        binding.inputId,
        "binding",
        binding.complete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }
  if (inventory.inputId !== undefined) {
    coverageInputs.push(
      ...coverageInputsFor(
        closedModel,
        inventory.inputId,
        "inventory",
        inventory.complete ? "complete" : "incomplete",
        source.selector,
      ),
    );
  }

  if (
    closedModel !== undefined &&
    !(await closedModelRootsAreVerifiable(source, closedModel, documents.bindings))
  ) {
    gaps.add("binding", "closed-model-root-verification");
    diagnostics.push(source.factory.diagnosticCode("APP_CLOSED_MODEL_ROOT_UNVERIFIED"));
  }

  return {
    bindingCandidates: binding.candidates,
    bindingResolutions: coreBindingResolutionPort.resolve(binding.candidates),
    inventorySnapshots: inventory.snapshot === undefined ? [] : [inventory.snapshot],
    ...(closedModel === undefined ? {} : { closedModel }),
    coverageGaps: Object.freeze([...closed.coverageGaps, ...binding.coverageGaps, ...inventory.coverageGaps, ...gaps.values]),
    coverageInputs: Object.freeze(coverageInputs),
    diagnostics: Object.freeze(diagnostics),
  };
}

function collectClosedModel(
  document: LocalJsonReadResult | undefined,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly model?: ClosedProvisioningModel;
  readonly coverageGaps: readonly CoverageGap[];
} {
  if (document === undefined) {
    return { coverageGaps: [] };
  }
  if (!document.ok) {
    gaps.add("binding", "closed-model-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { coverageGaps: [] };
  }

  const parsed = parseClosedProvisioningModel(document.value, builder);
  return {
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    coverageGaps: parsed.coverageGaps,
  };
}

function collectBindings(
  document: LocalJsonReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly candidates: readonly BindingCandidate[];
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
} {
  if (!document.ok) {
    gaps.add("binding", "binding-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { candidates: [], coverageGaps: [], complete: false };
  }

  const parsed = parseBindingManifest(document.value, builder);
  const inputId = localInputId(document.value, factory);
  if (inputId === undefined) {
    gaps.add("binding", "binding-input");
    diagnostics.push(codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON"));
  }
  return {
    candidates: parsed.candidates,
    coverageGaps: parsed.coverageGaps,
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined,
  };
}

function collectInventory(
  document: LocalJsonReadResult,
  builder: ReturnType<typeof adaptCoreFactBuilder>,
  factory: SafeFactFactory,
  gaps: AppGapBuilder,
  diagnostics: SafeDiagnosticCode[],
): {
  readonly snapshot?: InventorySnapshot;
  readonly coverageGaps: readonly CoverageGap[];
  readonly inputId?: SafeIdentifier;
  readonly complete: boolean;
} {
  if (!document.ok) {
    gaps.add("inventory", "inventory-input");
    diagnostics.push(codeForDocumentFailure(document.code));
    return { coverageGaps: [], complete: false };
  }

  const parsed = parseInventorySnapshot(document.value, builder);
  const inputId = localInputId(document.value, factory);
  const snapshot = parsed.snapshot;
  if (inputId === undefined || snapshot === undefined) {
    gaps.add("inventory", "inventory-input");
    diagnostics.push(codeForDocumentFailure("APP_LOCAL_INPUT_INVALID_JSON"));
  }
  return {
    ...(snapshot === undefined ? {} : { snapshot }),
    coverageGaps: parsed.coverageGaps,
    ...(inputId === undefined ? {} : { inputId }),
    complete: parsed.coverageGaps.length === 0 && inputId !== undefined && snapshot !== undefined,
  };
}

function reconcileCollected(source: SourceFacts, provisioning: ParsedProvisioning): LocalAnalysis {
  const reconciliationInput: ReconciliationInput = {
    references: source.references,
    demandEdges: source.demandEdges,
    dynamicLookupEdges: source.dynamicLookupEdges,
    targetStatuses: [{ scope: source.scope, status: "unknown-target" }],
    bindingCandidates: provisioning.bindingCandidates,
    bindingResolutions: provisioning.bindingResolutions,
    inventorySnapshots: provisioning.inventorySnapshots,
    coverageGaps: [...source.coverageGaps, ...provisioning.coverageGaps],
    coverageInputs: provisioning.coverageInputs,
    ...(provisioning.closedModel === undefined ? {} : { closedModel: provisioning.closedModel }),
  };
  const result = reconcile(reconciliationInput);
  const reportingInput: ReportingInput = {
    result,
    references: source.references,
    demandEdges: source.demandEdges,
  };
  return {
    reconciliationInput,
    result,
    reportingInput,
    diagnostics: Object.freeze([...source.diagnostics, ...provisioning.diagnostics]),
  };
}

function defaultScope(factory: SafeFactFactory): ExecutionScope {
  return {
    id: requiredIdentifier(factory, DEFAULT_SCOPE_ID),
    componentId: requiredIdentifier(factory, DEFAULT_COMPONENT_ID),
    // Explicitly broad rather than pretending the command knows deployment stage.
    phase: "runtime",
    stage: { kind: "all" },
    channel: "environment",
  };
}

function selectorForScope(scope: ExecutionScope): ScopeSelector {
  return {
    executionUnitIds: [scope.id],
    phases: [scope.phase],
    stage: scope.stage,
    channels: [scope.channel],
    condition: { kind: "always" },
  };
}

function requiredIdentifier(factory: SafeFactFactory, value: string): SafeIdentifier {
  const identifier = factory.genericIdentifier(value);
  if (typeof identifier !== "string") {
    throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
  }
  return identifier;
}

class AppGapBuilder {
  readonly #values: CoverageGap[] = [];
  #ordinal: number;

  public constructor(
    private readonly factory: SafeFactFactory,
    private readonly selector: ScopeSelector,
    startOrdinal = 0,
  ) {
    this.#ordinal = startOrdinal;
  }

  public get values(): readonly CoverageGap[] {
    return Object.freeze([...this.#values]);
  }

  public add(
    domain: "demand" | "binding" | "inventory",
    inputId: string,
  ): void {
    this.#ordinal += 1;
    const result = this.factory.materializeCoverageGap({
      idHint: `app-${domain}-gap-${this.#ordinal}`,
      domain,
      inputId,
      pathOrAdapterId: "local-app",
      potentiallyAffects: this.selector,
      reason: "invalid-input-shape",
    });
    if (!result.ok) {
      throw new AppError("APP_SAFETY_MATERIALIZATION_FAILED");
    }
    this.#values.push(result.value);
  }
}

async function readDiscoveredSource(file: DiscoveredSourceFile): Promise<string | undefined> {
  try {
    const current = await realpath(file.canonicalPath);
    if (!isSegmentDescendant(file.root.canonicalPath, current)) {
      return undefined;
    }
    const handle = await open(current, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_READ_SOURCE_BYTES) {
        return undefined;
      }
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function namespaceExtraction(
  extraction: SourceExtractionResult,
  fileOrdinal: number,
  factory: SafeFactFactory,
): {
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly incomplete: boolean;
} {
  const referenceIds = new Map<SafeIdentifier, SafeIdentifier>();
  const references: SecretReference[] = [];

  for (const [index, reference] of extraction.references.entries()) {
    const id = requiredIdentifier(factory, `source-file-${fileOrdinal}-reference-${index + 1}`);
    referenceIds.set(reference.id, id);
    references.push({ ...reference, id });
  }

  let incomplete = false;
  const demandEdges: DemandEdge[] = [];
  for (const [index, edge] of extraction.demandEdges.entries()) {
    const referenceId = referenceIds.get(edge.referenceId);
    if (referenceId === undefined) {
      incomplete = true;
      continue;
    }
    demandEdges.push({
      ...edge,
      id: requiredIdentifier(factory, `source-file-${fileOrdinal}-demand-${index + 1}`),
      referenceId,
    });
  }

  const dynamicLookupEdges: DynamicLookupEdge[] = [];
  for (const [index, edge] of extraction.dynamicLookupEdges.entries()) {
    const referenceId = referenceIds.get(edge.referenceId);
    if (referenceId === undefined) {
      incomplete = true;
      continue;
    }
    dynamicLookupEdges.push({
      ...edge,
      id: requiredIdentifier(factory, `source-file-${fileOrdinal}-dynamic-${index + 1}`),
      referenceId,
    });
  }

  return {
    references: Object.freeze(references),
    demandEdges: Object.freeze(demandEdges),
    dynamicLookupEdges: Object.freeze(dynamicLookupEdges),
    incomplete,
  };
}

/**
 * A skipped first-party path is uncertainty even when discovery cannot retain
 * its file-vs-directory shape. In particular, an ignored directory may hold
 * arbitrary TypeScript. Deliberately excluded dependency/outside-root paths
 * remain outside the local-demand contract.
 */
function isRelevantDiscoverySkip(code: SafeDiagnosticCode): boolean {
  const value = String(code);
  if (
    value === "BUDGET_EXCEEDED" ||
    value === "UNREADABLE" ||
    value === "OVERSIZE" ||
    value === "DEPTH_EXCEEDED" ||
    value === "IGNORED" ||
    value === "SYMLINK" ||
    value === "GENERATED"
  ) {
    return true;
  }
  return false;
}

function coverageInput(
  factory: SafeFactFactory,
  inputId: string | SafeIdentifier,
  domain: CoverageInputStatus["domain"],
  state: CoverageInputStatus["state"],
  selector: ScopeSelector,
): CoverageInputStatus {
  return {
    inputId: typeof inputId === "string" ? requiredIdentifier(factory, inputId) : inputId,
    domain,
    state,
    selector,
  };
}

function coverageInputsFor(
  model: ClosedProvisioningModel | undefined,
  inputId: SafeIdentifier,
  domain: CoverageInputStatus["domain"],
  state: CoverageInputStatus["state"],
  fallback: ScopeSelector,
): readonly CoverageInputStatus[] {
  const selectors = model?.scopes
    .flatMap((scope) =>
      scope.coverage?.expectedInputs.some(
        (expected) => expected.inputId === inputId && expected.domain === domain,
      )
        ? [scope.selector]
        : [],
    ) ?? [];
  const effectiveSelectors = selectors.length === 0 ? [fallback] : selectors;
  return effectiveSelectors.map((selector) => ({ inputId, domain, state, selector }));
}

function localInputId(value: unknown, factory: SafeFactFactory): SafeIdentifier | undefined {
  if (!isRecord(value) || typeof value.inputId !== "string") {
    return undefined;
  }
  const inputId = factory.genericIdentifier(value.inputId);
  return typeof inputId === "string" ? inputId : undefined;
}

function codeForDocumentFailure(
  code: "APP_LOCAL_INPUT_READ_FAILED" | "APP_LOCAL_INPUT_TOO_LARGE" | "APP_LOCAL_INPUT_INVALID_JSON",
): SafeDiagnosticCode {
  switch (code) {
    case "APP_LOCAL_INPUT_READ_FAILED":
      return "APP_LOCAL_INPUT_READ_FAILED" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_TOO_LARGE":
      return "APP_LOCAL_INPUT_TOO_LARGE" as SafeDiagnosticCode;
    case "APP_LOCAL_INPUT_INVALID_JSON":
      return "APP_LOCAL_INPUT_INVALID_JSON" as SafeDiagnosticCode;
  }
}

async function closedModelRootsAreVerifiable(
  source: SourceFacts,
  model: ClosedProvisioningModel,
  bindingDocument: LocalJsonReadResult,
): Promise<boolean> {
  const relevantScopes = model.scopes.filter(
    (scope) => scope.closed && selectorMayAffectScope(scope.selector, source.scope),
  );
  if (relevantScopes.length === 0) {
    return true;
  }

  let workspace: string;
  try {
    workspace = await realpath(process.cwd());
  } catch {
    return false;
  }

  const rootMarker = source.factory.rootRelativePath(".");
  if (rootMarker === undefined) {
    return false;
  }
  const sourceRoots = source.discovery.roots.map((root) =>
    root.canonicalPath === workspace
      ? rootMarker
      : source.factory.safePath({ approvedRoot: workspace, canonicalPath: root.canonicalPath }),
  );
  if (sourceRoots.some((path) => path === OPAQUE_PATH)) {
    return false;
  }

  const bindingPath = bindingDocument.ok
    ? bindingDocument.canonicalPath === workspace
      ? rootMarker
      : source.factory.safePath({
          approvedRoot: workspace,
          canonicalPath: bindingDocument.canonicalPath,
        })
    : undefined;

  return relevantScopes.every((scope) => {
    const coverage = scope.coverage;
    if (coverage === undefined || bindingPath === undefined || bindingPath === OPAQUE_PATH) {
      return false;
    }
    return (
      sourceRoots.every((root) => coverage.approvedFirstPartyRoots.some((declared) => safePathCovers(declared, root, rootMarker))) &&
      coverage.bindingRoots.some((declared) => safePathCovers(declared, bindingPath, rootMarker))
    );
  });
}

function safePathCovers(root: SafePath, candidate: SafePath, rootMarker: SafePath): boolean {
  return root === rootMarker || root === candidate || String(candidate).startsWith(`${String(root)}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
