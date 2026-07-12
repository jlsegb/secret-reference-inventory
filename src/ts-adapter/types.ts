import type {
  CoreDiagnostic,
  CoreSourceFactBuilder,
  DemandEdge,
  DynamicLookupEdge,
  SecretReference,
} from "../core/types.js";
import type { SourceLanguage } from "../discovery/types.js";
import type { SafeIdentifier, SafePath } from "../safety/types.js";

import type { SourceSyntaxBackend } from "./backend.js";

/**
 * Execution-surface evidence is supplied by the composition root. Syntax
 * extraction deliberately does not guess a deployable component from a path.
 */
export type SourceExposure = "server" | "client" | "worker" | "tooling" | "unknown";

/**
 * Scope stays raw until the supplied CoreSourceFactBuilder validates it.
 * File must be the discovery-provided displayPath, never a canonical path.
 */
export interface SourceExtractionInput {
  readonly sourceText: string;
  readonly file: SafePath;
  /**
   * Composition roots must provide a unique safe non-path identifier per file.
   * It namespaces fact IDs without retaining a canonical or display path.
   */
  readonly sourceId?: SafeIdentifier;
  readonly language: SourceLanguage;
  readonly scope: unknown;
  readonly exposure?: SourceExposure;
}

export interface SourceExtractionOptions {
  /** Bound shared by local constant evaluation and dynamic-domain facts. */
  readonly maxFiniteKeyDomain?: number;
  /**
   * Internal parser seam for a future OXC fast path. It is a local library
   * integration point, not a repository-supplied plugin mechanism.
   */
  readonly backend?: SourceSyntaxBackend;
}

export interface ParseFailureDiagnostic {
  readonly code: "PARSE_FAILURE";
}

export interface FactMaterializationDiagnostic {
  readonly code: "SOURCE_FACT_MATERIALIZATION_FAILED";
  readonly diagnostic: CoreDiagnostic;
}

export type SourceExtractionDiagnostic =
  | ParseFailureDiagnostic
  | FactMaterializationDiagnostic;

/**
 * All facts in this result were returned by CoreSourceFactBuilder. The adapter
 * never instantiates a normalized Core fact itself.
 */
export interface SourceExtractionResult {
  readonly backendId: string;
  readonly references: readonly SecretReference[];
  readonly demandEdges: readonly DemandEdge[];
  readonly dynamicLookupEdges: readonly DynamicLookupEdge[];
  readonly diagnostics: readonly SourceExtractionDiagnostic[];
}

export interface SourceExtractor {
  extract(input: SourceExtractionInput): SourceExtractionResult;
}

export type SourceFactBuilder = CoreSourceFactBuilder;
