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

/** Fixed codes only; no raw model, path, or value is retained on failure. */
export class ViewerRequestError extends Error {
  readonly code: ViewerRequestErrorCode;

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

/** Returns a private builder with no enumerable model fields. */
export function createLocalViewerDocumentBuilder(): LocalViewerDocumentBuilder {
  const builder = Object.freeze(Object.create(null)) as LocalViewerDocumentBuilder;
  BUILDERS.set(builder, { repositories: [], sealed: false });
  return builder;
}

/** App-only positional writer; it never walks caller-owned records or arrays. */
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

/** App-only positional writer; result limits are enforced before any bind. */
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

/** App-only positional writer; fact values are a small fixed grammar. */
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
 * Seals the app-built document into the sole request accepted by the server.
 * Both the document and port stay in a private WeakMap; the returned token has
 * no enumerable fields and carries no raw model data.
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
 * The server calls this before touching a request. WeakMap identity checks do
 * not invoke getters, iteration, proxy traps, or custom collection methods.
 */
export function resolveIssuedLocalReportViewerRequest(
  request: unknown,
): IssuedLocalReportViewerRequest | undefined {
  return request !== null && typeof request === "object"
    ? ISSUED_REQUESTS.get(request)
    : undefined;
}

export function isViewerRequestLimitError(error: unknown): error is ViewerRequestError {
  return (
    error instanceof ViewerRequestError &&
    (error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED" ||
      error.code === "VIEWER_RESULT_LIMIT_EXCEEDED" ||
      error.code === "VIEWER_FACT_LIMIT_EXCEEDED")
  );
}

function requireActiveBuilder(input: unknown): BuilderState {
  const state = input !== null && typeof input === "object"
    ? BUILDERS.get(input)
    : undefined;
  if (state === undefined || state.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return state;
}

function requireActiveRepositorySlot(input: unknown): RepositorySlotState {
  const slot = input !== null && typeof input === "object"
    ? REPOSITORY_SLOTS.get(input)
    : undefined;
  if (slot === undefined || slot.builder.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return slot;
}

function requireActiveResultSlot(input: unknown): ResultSlotState {
  const slot = input !== null && typeof input === "object"
    ? RESULT_SLOTS.get(input)
    : undefined;
  if (slot === undefined || slot.builder.sealed) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return slot;
}

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

function normalizeSummary(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_SUMMARIES.has(value)) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  return value;
}

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

function isDisposition(value: unknown): value is ViewerDisposition {
  return value === "informational" || value === "review" || value === "inconclusive";
}

function isFactTone(value: unknown): value is ViewerFactTone | undefined {
  return value === undefined || value === "neutral" || value === "warning" || value === "positive";
}

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
