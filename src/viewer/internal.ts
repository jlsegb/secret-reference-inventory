import { isSecretLikeToken } from "../safety/index.js";
import type {
  LocalReportViewerRequest,
  ViewerDisposition,
  ViewerFactTone,
} from "./types.js";

const MAX_REPOSITORIES = 100;
const MAX_RESULTS_PER_REPOSITORY = 1_000;
const MAX_FACTS_PER_RESULT = 100;
const MAX_DISPLAY_TEXT_LENGTH = 512;

const ALLOWED_SUMMARIES = new Set([
  "This repository finished with complete scoped coverage.",
  "This repository has scoped uncertainty that needs review.",
  "This repository result could not be validated.",
  "This reference is shared by multiple consumers.",
  "This reference has one known consumer group.",
  "No environment key name is inferred for this lookup.",
  "Likely keys are derived from bounded static evidence.",
  "Explicit deployment aggregation only.",
]);

const COUNT_FACT_LABELS = new Set([
  "References",
  "Dynamic lookups",
  "Diagnostics",
  "Consumers",
  "Source occurrences",
  "Findings",
  "Likely keys",
  "Repositories",
  "Shared keys",
]);

export interface ViewerDocumentModel {
  readonly repositories: readonly ViewerRepositoryModel[];
}

interface ViewerRepositoryModel {
  readonly id: string;
  readonly label: string;
  readonly results: readonly ViewerResultModel[];
}

interface ViewerResultModel {
  readonly id: string;
  readonly label: string;
  readonly disposition: ViewerDisposition;
  readonly summary?: string;
  readonly facts: readonly ViewerFactModel[];
}

interface ViewerFactModel {
  readonly label: string;
  readonly value: string;
  readonly tone: ViewerFactTone;
}

interface MutableViewerRepository {
  readonly id: string;
  readonly label: string;
  readonly results: MutableViewerResult[];
}

interface MutableViewerResult {
  readonly id: string;
  readonly label: string;
  readonly disposition: ViewerDisposition;
  readonly summary?: string;
  readonly facts: MutableViewerFact[];
}

interface MutableViewerFact {
  readonly label: string;
  readonly value: string;
  readonly tone: ViewerFactTone;
}

interface BuilderState {
  readonly repositories: MutableViewerRepository[];
  sealed: boolean;
}

interface RepositorySlotState {
  readonly builder: BuilderState;
  readonly repository: MutableViewerRepository;
}

interface ResultSlotState {
  readonly builder: BuilderState;
  readonly result: MutableViewerResult;
}

export interface IssuedLocalReportViewerRequest {
  readonly document: ViewerDocumentModel;
  readonly port: number;
}

declare const viewerDocumentBuilderBrand: unique symbol;
export type LocalViewerDocumentBuilder = {
  readonly [viewerDocumentBuilderBrand]: true;
};

declare const viewerRepositorySlotBrand: unique symbol;
export type LocalViewerRepositorySlot = {
  readonly [viewerRepositorySlotBrand]: true;
};

declare const viewerResultSlotBrand: unique symbol;
export type LocalViewerResultSlot = {
  readonly [viewerResultSlotBrand]: true;
};

export type ViewerRequestErrorCode =
  | "VIEWER_REQUEST_INVALID"
  | "VIEWER_REPOSITORY_LIMIT_EXCEEDED"
  | "VIEWER_RESULT_LIMIT_EXCEEDED"
  | "VIEWER_FACT_LIMIT_EXCEEDED"
  | "VIEWER_PORT_INVALID"
  | "VIEWER_BIND_FAILED";

/**
 * Represents a fixed, value-free rejection from viewer request construction or server startup.
 *
 * Inputs: A fixed viewer request error code.
 * Outputs: An Error instance whose name, code, and message each derive from the fixed error code; the runtime may also expose a stack.
 * Does not handle: Preserving causal exceptions, raw request data, paths, or displayed model values.
 * Side effects: Initializes the standard Error stack according to the JavaScript runtime.
 */
export class ViewerRequestError extends Error {
  readonly code: ViewerRequestErrorCode;

  /**
   * Initializes a value-free viewer error from a fixed code.
   *
   * Inputs: One member of the closed viewer-error code union.
   * Outputs: A constructed error with matching message and code fields.
   * Does not handle: Error causes, custom messages, or raw request detail.
   * Side effects: Invokes the Error superclass initialization.
   */
  public constructor(code: ViewerRequestErrorCode) {
    super(code);
    this.name = "ViewerRequestError";
    this.code = code;
  }
}

const BUILDERS = new WeakMap<object, BuilderState>();
const REPOSITORY_SLOTS = new WeakMap<object, RepositorySlotState>();
const RESULT_SLOTS = new WeakMap<object, ResultSlotState>();
const ISSUED_REQUESTS = new WeakMap<object, IssuedLocalReportViewerRequest>();

/**
 * Creates an opaque, initially active builder whose mutable model stays in a private WeakMap.
 *
 * Inputs: None.
 * Outputs: A frozen branded builder token with no enumerable model fields.
 * Does not handle: Accepting caller data, issuing a request, or exposing a partial document.
 * Side effects: Registers mutable builder state in the module-local WeakMap.
 */
export function createLocalViewerDocumentBuilder(): LocalViewerDocumentBuilder {
  const builder = Object.freeze(Object.create(null)) as LocalViewerDocumentBuilder;
  BUILDERS.set(builder, { repositories: [], sealed: false });
  return builder;
}

/**
 * Appends one bounded repository row to an active opaque builder.
 *
 * Inputs: A builder token plus scalar repository ID and label values.
 * Outputs: An opaque repository slot for later result appends.
 * Does not handle: Traversing caller objects, reading paths, or accepting more than the repository limit.
 * Side effects: Mutates private builder state and registers a repository slot in a WeakMap.
 */
export function appendLocalViewerRepository(
  builder: unknown,
  id: unknown,
  label: unknown,
): LocalViewerRepositorySlot {
  const state = requireActiveBuilder(builder);
  if (state.repositories.length >= MAX_REPOSITORIES) {
    throw new ViewerRequestError("VIEWER_REPOSITORY_LIMIT_EXCEEDED");
  }
  const normalizedId = normalizeId(id);
  const normalizedLabel = normalizeRepositoryLabel(label);
  const repository: MutableViewerRepository = {
    id: normalizedId,
    label: normalizedLabel,
    results: [],
  };
  state.repositories[state.repositories.length] = repository;
  const slot = Object.freeze(Object.create(null)) as LocalViewerRepositorySlot;
  REPOSITORY_SLOTS.set(slot, { builder: state, repository });
  return slot;
}

/**
 * Appends one bounded result row beneath an active repository slot.
 *
 * Inputs: A repository slot, scalar ID/label/disposition, and optional allowed summary.
 * Outputs: An opaque result slot for later fact appends.
 * Does not handle: Walking caller records, accepting arbitrary display text, or exceeding the per-repository result limit.
 * Side effects: Mutates private repository state and registers a result slot in a WeakMap.
 */
export function appendLocalViewerResult(
  repositorySlot: unknown,
  id: unknown,
  label: unknown,
  disposition: unknown,
  summary: unknown,
): LocalViewerResultSlot {
  const slot = requireActiveRepositorySlot(repositorySlot);
  if (slot.repository.results.length >= MAX_RESULTS_PER_REPOSITORY) {
    throw new ViewerRequestError("VIEWER_RESULT_LIMIT_EXCEEDED");
  }
  if (!isDisposition(disposition)) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  const normalizedSummary = summary === undefined ? undefined : normalizeSummary(summary);
  const result: MutableViewerResult = normalizedSummary === undefined
    ? {
        id: normalizeId(id),
        label: normalizeResultLabel(label),
        disposition,
        facts: [],
      }
    : {
        id: normalizeId(id),
        label: normalizeResultLabel(label),
        disposition,
        summary: normalizedSummary,
        facts: [],
      };
  slot.repository.results[slot.repository.results.length] = result;
  const resultSlot = Object.freeze(Object.create(null)) as LocalViewerResultSlot;
  RESULT_SLOTS.set(resultSlot, { builder: slot.builder, result });
  return resultSlot;
}

/**
 * Appends one allowed fact label/value/tone tuple to an active result slot.
 *
 * Inputs: A result slot and scalar fact fields in the viewer's fixed display grammar.
 * Outputs: Nothing after a successful append.
 * Does not handle: Arbitrary metadata, nested values, or fact lists beyond the configured limit.
 * Side effects: Mutates private result state or throws a fixed viewer error.
 */
export function appendLocalViewerFact(
  resultSlot: unknown,
  label: unknown,
  value: unknown,
  tone: unknown,
): void {
  const slot = requireActiveResultSlot(resultSlot);
  if (slot.result.facts.length >= MAX_FACTS_PER_RESULT) {
    throw new ViewerRequestError("VIEWER_FACT_LIMIT_EXCEEDED");
  }
  if (
    !isFactTone(tone) ||
    !isAllowedFact(label, value) ||
    typeof label !== "string" ||
    typeof value !== "string"
  ) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  slot.result.facts[slot.result.facts.length] = {
    label,
    value,
    tone: tone ?? "neutral",
  };
}

/**
 * Validates the requested loopback port, then snapshots and seals an active builder into the sole opaque request accepted by the local server.
 *
 * Inputs: A builder token and an optional numeric loopback port.
 * Outputs: A frozen non-enumerable request token whose document and normalized port remain in a WeakMap, or a fixed invalid-port error before snapshotting when the port is invalid.
 * Does not handle: Starting the server, reopening a sealed builder, or accepting raw document records.
 * Side effects: Only after successful port normalization, freezes a snapshot, marks builder state sealed, and registers the request token. An invalid port throws before those mutations, leaving the active builder reusable.
 */
export function issueLocalReportViewerRequest(
  builder: unknown,
  port: unknown,
): LocalReportViewerRequest {
  const state = requireActiveBuilder(builder);
  const normalizedPort = normalizePort(port);
  const document = snapshotDocument(state.repositories);
  state.sealed = true;
  const request = Object.freeze(Object.create(null)) as LocalReportViewerRequest;
  ISSUED_REQUESTS.set(request, { document, port: normalizedPort });
  return request;
}

/**
 * Retrieves a previously issued server request by object identity before any property access.
 *
 * Inputs: An arbitrary caller-provided request value.
 * Outputs: The issued document/port pair or undefined for every non-issued value.
 * Does not handle: Traversing getters, iterators, validating arbitrary request shapes, or accepting forged request objects.
 * Side effects: None. The `typeof` guard and native `WeakMap.get` perform no `instanceof` check or caller-object property/proxy-trap access.
 */
export function resolveIssuedLocalReportViewerRequest(
  request: unknown,
): IssuedLocalReportViewerRequest | undefined {
  return request !== null && typeof request === "object"
    ? ISSUED_REQUESTS.get(request)
    : undefined;
}

/**
 * Identifies the three fixed errors caused specifically by builder cardinality limits.
 *
 * Inputs: An arbitrary thrown value.
 * Outputs: A type predicate for viewer repository, result, or fact limit errors.
 * Does not handle: Invalid input, port, or bind errors, even though they share the same class.
 * Side effects: Performs `instanceof` and then reads `.code`; hostile Proxy or custom-prototype behavior can run traps and throw before this predicate returns.
 */
export function isViewerRequestLimitError(error: unknown): error is ViewerRequestError {
  return (
    error instanceof ViewerRequestError &&
    (error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED" ||
      error.code === "VIEWER_RESULT_LIMIT_EXCEEDED" ||
      error.code === "VIEWER_FACT_LIMIT_EXCEEDED")
  );
}

/**
 * Resolves an unsealed builder token to its private mutable state.
 *
 * Inputs: An arbitrary builder candidate.
 * Outputs: The matching active state or a fixed invalid-request error.
 * Does not handle: Inspecting properties, accepting forged brands, or unsealing a builder.
 * Side effects: None.
 */
function requireActiveBuilder(input: unknown): BuilderState {
  const state = input !== null && typeof input === "object"
    ? BUILDERS.get(input)
    : undefined;
  if (state === undefined || state.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return state;
}

/**
 * Resolves an active repository slot to the builder and repository it represents.
 *
 * Inputs: An arbitrary repository-slot candidate.
 * Outputs: Private slot state or a fixed invalid-request error.
 * Does not handle: Verifying slot ownership through public fields or reopening sealed state.
 * Side effects: None.
 */
function requireActiveRepositorySlot(input: unknown): RepositorySlotState {
  const slot = input !== null && typeof input === "object"
    ? REPOSITORY_SLOTS.get(input)
    : undefined;
  if (slot === undefined || slot.builder.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return slot;
}

/**
 * Resolves an active result slot to its builder and result state.
 *
 * Inputs: An arbitrary result-slot candidate.
 * Outputs: Private slot state or a fixed invalid-request error.
 * Does not handle: Verifying slot ownership through public fields or reopening sealed state.
 * Side effects: None.
 */
function requireActiveResultSlot(input: unknown): ResultSlotState {
  const slot = input !== null && typeof input === "object"
    ? RESULT_SLOTS.get(input)
    : undefined;
  if (slot === undefined || slot.builder.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return slot;
}

/**
 * Accepts a bounded identifier only when it matches the viewer grammar and contains no secret-like token.
 *
 * Inputs: One arbitrary scalar candidate.
 * Outputs: The validated ID string or a fixed invalid-request error.
 * Does not handle: Uniqueness, relation to repository contents, or user-facing label selection.
 * Side effects: Invokes the shared secret-like token classifier.
 */
function normalizeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ||
    containsSecretLikeToken(value)
  ) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return value;
}

/**
 * Accepts a repository display label from the narrow identifier-or-Deployments grammar.
 *
 * Inputs: One arbitrary scalar candidate.
 * Outputs: The validated label or a fixed invalid-request error.
 * Does not handle: Arbitrary prose, filesystem paths, or repository identity validation.
 * Side effects: Invokes the shared secret-like token classifier.
 */
function normalizeRepositoryLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|Deployments)$/u.test(value) ||
    containsSecretLikeToken(value)
  ) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return value;
}

/**
 * Accepts a bounded result label from the viewer's explicit overview, key, or dynamic-lookup grammar.
 *
 * Inputs: One arbitrary scalar candidate.
 * Outputs: The validated label or a fixed invalid-request error.
 * Does not handle: Arbitrary prose, source paths, or inferred key discovery.
 * Side effects: Invokes the shared secret-like token classifier.
 */
function normalizeResultLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_TEXT_LENGTH ||
    /[\\/\u0000-\u001f\u007f]/u.test(value) ||
    containsSecretLikeToken(value) ||
    !(
      value === "Overview" ||
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ||
      /^(?:env|config|secret-manager):[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ||
      /^Dynamic: (?:finite environment-key set|bounded environment lookup|unbounded environment lookup|\*?[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\*?(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255})?)$/u.test(value)
    )
  ) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return value;
}

/**
 * Accepts one exact preapproved summary sentence.
 *
 * Inputs: One arbitrary scalar candidate.
 * Outputs: The matched summary string or a fixed invalid-request error.
 * Does not handle: Dynamic summaries, interpolation, localization, or free-form explanation.
 * Side effects: None.
 */
function normalizeSummary(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_SUMMARIES.has(value)) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return value;
}

/**
 * Tests a fact label/value pair against the viewer's closed state, origin, coverage, and count grammars.
 *
 * Inputs: Arbitrary label and value candidates.
 * Outputs: True only when both form one permitted safe fact pair.
 * Does not handle: Fact-tone validation, nested data, or secret redaction beyond rejection.
 * Side effects: Invokes the shared secret-like token classifier for supplied text.
 */
function isAllowedFact(label: unknown, value: unknown): label is string {
  if (typeof label !== "string" || typeof value !== "string") {
    return false;
  }
  if (
    value.length === 0 ||
    value.length > MAX_DISPLAY_TEXT_LENGTH ||
    /[\\/\u0000-\u001f\u007f]/u.test(value) ||
    containsSecretLikeToken(value)
  ) {
    return false;
  }
  if (label === "State") {
    return value === "complete" || value === "incomplete" || value === "invalid";
  }
  if (label === "Origin") {
    return value === "lexical" || value === "user-controlled" || value === "opaque";
  }
  if (label === "Coverage") {
    return value === "complete" || value === "incomplete";
  }
  return COUNT_FACT_LABELS.has(label) && /^(?:0|[1-9][0-9]{0,8})$/u.test(value);
}

/**
 * Searches structured display text and punctuation-delimited fragments for tokens rejected by the shared classifier.
 *
 * Inputs: A string already constrained by a caller's display grammar.
 * Outputs: True when the whole text or a delimiter-suffix fragment appears secret-like.
 * Does not handle: Cryptographic validation, decoding, or redacting the rejected text.
 * Side effects: Invokes the shared secret-like token classifier for each candidate fragment.
 */
function containsSecretLikeToken(text: string): boolean {
  const candidates = text.match(/[A-Za-z0-9._:@/-]+/gu) ?? [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    if (candidate === undefined) {
      continue;
    }
    if (isSecretLikeToken(candidate)) {
      return true;
    }
    // Preserve punctuation as a display grammar, but test each delimiter
    // boundary with the shared credential classifier. For example,
    // `env:sk_live_short` must not hide a short prefixed credential behind a
    // structured display label.
    for (let index = 1; index < candidate.length; index += 1) {
      if (
        /[._:@/-]/u.test(candidate[index - 1] ?? "") &&
        isSecretLikeToken(candidate.slice(index))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Normalizes an absent port to zero or accepts a safe integer port in the host range.
 *
 * Inputs: An optional arbitrary port candidate.
 * Outputs: A legal numeric port or a fixed invalid-port error.
 * Does not handle: Binding checks, privileged-port policy, or string-form ports.
 * Side effects: None.
 */
function normalizePort(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    throw new ViewerRequestError("VIEWER_PORT_INVALID");
  }
  return value;
}

/**
 * Checks whether a scalar is one of the viewer's three supported result dispositions.
 *
 * Inputs: An arbitrary candidate.
 * Outputs: A type predicate for informational, review, or inconclusive.
 * Does not handle: Mapping application statuses to viewer dispositions.
 * Side effects: None.
 */
function isDisposition(value: unknown): value is ViewerDisposition {
  return value === "informational" || value === "review" || value === "inconclusive";
}

/**
 * Checks whether a scalar is absent or one of the permitted viewer fact tones.
 *
 * Inputs: An arbitrary candidate.
 * Outputs: A type predicate for undefined, neutral, warning, or positive.
 * Does not handle: Selecting a default tone or mapping dispositions to tone.
 * Side effects: None.
 */
function isFactTone(value: unknown): value is ViewerFactTone | undefined {
  return value === undefined || value === "neutral" || value === "warning" || value === "positive";
}

/**
 * Copies private mutable builder rows into deeply frozen viewer document data after checking dense arrays.
 *
 * Inputs: The builder's repository list.
 * Outputs: A frozen document model with frozen repositories, results, facts, and arrays.
 * Does not handle: Revalidating scalar grammar, recovering sparse arrays, or serializing HTML.
 * Side effects: Allocates copied/frozen objects or throws a fixed invalid-request error for sparse private state.
 */
function snapshotDocument(
  repositories: readonly MutableViewerRepository[],
): ViewerDocumentModel {
  const repositoryCopies: ViewerRepositoryModel[] = [];
  for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
    const repository = repositories[repositoryIndex];
    if (repository === undefined) {
      throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
    }
    const resultCopies: ViewerResultModel[] = [];
    for (let resultIndex = 0; resultIndex < repository.results.length; resultIndex += 1) {
      const result = repository.results[resultIndex];
      if (result === undefined) {
        throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
      }
      const factCopies: ViewerFactModel[] = [];
      for (let factIndex = 0; factIndex < result.facts.length; factIndex += 1) {
        const fact = result.facts[factIndex];
        if (fact === undefined) {
          throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
        }
        factCopies[factCopies.length] = Object.freeze({
          label: fact.label,
          value: fact.value,
          tone: fact.tone,
        });
      }
      const resultCopy: ViewerResultModel = result.summary === undefined
        ? {
            id: result.id,
            label: result.label,
            disposition: result.disposition,
            facts: Object.freeze(factCopies),
          }
        : {
            id: result.id,
            label: result.label,
            disposition: result.disposition,
            summary: result.summary,
            facts: Object.freeze(factCopies),
          };
      resultCopies[resultCopies.length] = Object.freeze(resultCopy);
    }
    repositoryCopies[repositoryCopies.length] = Object.freeze({
      id: repository.id,
      label: repository.label,
      results: Object.freeze(resultCopies),
    });
  }
  return Object.freeze({ repositories: Object.freeze(repositoryCopies) });
}
