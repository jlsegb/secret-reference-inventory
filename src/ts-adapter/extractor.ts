import type {
  CoreDiagnostic,
  CoreSourceFactBuilder,
  DemandEdge,
  DynamicLookupEdge,
  FactMaterialization,
  SecretReference,
} from "../core/types.js";

import {
  TypeScriptSyntaxBackend,
  type RawDynamicDomain,
  type RawDynamicOrigin,
  type RawSourceLocation,
  type RawSourceObservation,
  type SourceSyntaxBackend,
} from "./backend.js";
import type {
  SourceExtractionDiagnostic,
  SourceExtractionInput,
  SourceExtractionOptions,
  SourceExtractionResult,
  SourceExtractor,
} from "./types.js";

export const DEFAULT_MAX_FINITE_KEY_DOMAIN = 100;
let directUseSourceSequence = 0;

/**
 * Converts compact raw syntax observations into safe normalized Core facts.
 * This class never inspects environment values, invokes user code, resolves
 * imports, or allows raw parser/source text to escape the call.
 */
export class TypeScriptSourceExtractor implements SourceExtractor {
  readonly #backend: SourceSyntaxBackend;
  readonly #maxFiniteKeyDomain: number;

  public constructor(
    readonly builder: CoreSourceFactBuilder,
    options: SourceExtractionOptions = {},
  ) {
    this.#backend = options.backend ?? new TypeScriptSyntaxBackend();
    this.#maxFiniteKeyDomain = normalizeLimit(options.maxFiniteKeyDomain);
  }

  public extract(input: SourceExtractionInput): SourceExtractionResult {
    const parsed = this.#backend.extract({
      sourceText: input.sourceText,
      language: input.language,
      maxFiniteKeyDomain: this.#maxFiniteKeyDomain,
    });
    const references: SecretReference[] = [];
    const demandEdges: DemandEdge[] = [];
    const dynamicLookupEdges: DynamicLookupEdge[] = [];
    const diagnostics: SourceExtractionDiagnostic[] = [];

    if (parsed.parseFailed) {
      diagnostics.push({ code: "PARSE_FAILURE" });
    }

    const sourceId = input.sourceId ?? nextDirectUseSourceId();
    for (const observation of parsed.observations) {
      this.materializeObservation(
        observation,
        sourceId,
        input,
        references,
        demandEdges,
        dynamicLookupEdges,
        diagnostics,
      );
    }

    return Object.freeze({
      backendId: this.#backend.id,
      references: Object.freeze(references),
      demandEdges: Object.freeze(demandEdges),
      dynamicLookupEdges: Object.freeze(dynamicLookupEdges),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  private materializeObservation(
    observation: RawSourceObservation,
    sourceId: string,
    input: SourceExtractionInput,
    references: SecretReference[],
    demandEdges: DemandEdge[],
    dynamicLookupEdges: DynamicLookupEdge[],
    diagnostics: SourceExtractionDiagnostic[],
  ): void {
    const location = rawLocation(input.file, observation.location);
    const referenceId = factId(sourceId, "reference", observation.location);
    const reference = this.materialize(
      this.builder.materializeSecretReference({
        id: referenceId,
        requested: {
          namespace: "env",
          name: observation.kind === "exact" ? observation.key : null,
        },
        demand: "direct-read",
        operation: "read",
        resolution: observation.kind === "exact" ? observation.resolution : "dynamic",
        confidence: observation.kind === "exact" ? "high" : "review",
        location,
        exposure: input.exposure ?? "unknown",
        evidenceChain: [
          {
            ruleId:
              observation.kind === "exact"
                ? "typescript-environment-read"
                : "typescript-dynamic-environment-read",
            diagnosticCode:
              observation.kind === "exact" ? "TS_ENVIRONMENT_READ" : "TS_DYNAMIC_ENVIRONMENT_READ",
            locations: [location],
          },
        ],
      }),
      references,
      diagnostics,
    );
    if (reference === undefined) {
      return;
    }

    if (observation.kind === "exact" && typeof reference.requested.name === "string") {
      this.materialize(
        this.builder.materializeDemandEdge({
          id: factId(sourceId, "demand", observation.location),
          referenceId,
          scope: input.scope,
          origin: "direct",
          evidenceChain: [
            {
              ruleId: "typescript-direct-demand",
              diagnosticCode: "TS_DIRECT_DEMAND",
              locations: [location],
            },
          ],
        }),
        demandEdges,
        diagnostics,
      );
      return;
    }

    if (observation.kind === "exact") {
      this.materializeDynamic(
        referenceId,
        sourceId,
        observation.location,
        location,
        input,
        { kind: "unbounded", reason: "opaque" },
        "opaque",
        undefined,
        dynamicLookupEdges,
        diagnostics,
      );
      return;
    }

    this.materializeDynamic(
      referenceId,
      sourceId,
      observation.location,
      location,
      input,
      observation.domain,
      observation.origin,
      observation.domain.kind === "pattern" ? "not-proven" : undefined,
      dynamicLookupEdges,
      diagnostics,
    );
  }

  private materializeDynamic(
    referenceId: string,
    sourceId: string,
    sourceLocation: RawSourceLocation,
    location: object,
    input: SourceExtractionInput,
    domain: RawDynamicDomain,
    origin: RawDynamicOrigin,
    patternConstraint: "not-proven" | undefined,
    dynamicLookupEdges: DynamicLookupEdge[],
    diagnostics: SourceExtractionDiagnostic[],
  ): void {
    const raw = {
      id: factId(sourceId, "dynamic", sourceLocation),
      referenceId,
      scope: input.scope,
      domain,
      origin,
      ...(patternConstraint === undefined ? {} : { patternConstraint }),
      likelyKeys:
        domain.kind === "finite"
          ? domain.keys.map((name) => ({ namespace: "env", name }))
          : [],
      evidenceChain: [
        {
          ruleId: "typescript-dynamic-lookup",
          diagnosticCode: "TS_DYNAMIC_LOOKUP",
          locations: [location],
        },
      ],
    };
    const dynamic = this.materialize(
      this.builder.materializeDynamicLookupEdge(raw),
      dynamicLookupEdges,
      diagnostics,
    );
    if (dynamic !== undefined || domain.kind === "unbounded") {
      return;
    }

    // Rejected finite/pattern text cannot escape through a fallback. Preserve
    // scoped uncertainty using only a fixed diagnostic category.
    this.materialize(
      this.builder.materializeDynamicLookupEdge({
        ...raw,
        domain: { kind: "unbounded", reason: "opaque" },
        likelyKeys: [],
      }),
      dynamicLookupEdges,
      diagnostics,
    );
  }

  private materialize<T>(
    result: FactMaterialization<T>,
    target: T[],
    diagnostics: SourceExtractionDiagnostic[],
  ): T | undefined {
    if (result.ok) {
      target.push(result.value);
      return result.value;
    }
    diagnostics.push({
      code: "SOURCE_FACT_MATERIALIZATION_FAILED",
      diagnostic: materializationDiagnostic(result.diagnostic),
    });
    return undefined;
  }
}

export function extractTypeScriptSource(
  input: SourceExtractionInput,
  builder: CoreSourceFactBuilder,
  options: SourceExtractionOptions = {},
): SourceExtractionResult {
  return new TypeScriptSourceExtractor(builder, options).extract(input);
}

function rawLocation(file: SourceExtractionInput["file"], location: RawSourceLocation): object {
  return {
    file,
    start: location.start,
    end: location.end,
  };
}

function materializationDiagnostic(diagnostic: CoreDiagnostic): CoreDiagnostic {
  return diagnostic;
}

function nextDirectUseSourceId(): string {
  directUseSourceSequence += 1;
  return "source-direct-" + String(directUseSourceSequence);
}

/**
 * sourceId is a Safety-materialized composition identifier. Coordinates make
 * IDs stable for a given source and allow SafeFactFactory to derive a
 * location-specific pattern identity without retaining a path or key.
 */
function factId(
  sourceId: string,
  kind: "reference" | "demand" | "dynamic",
  location: RawSourceLocation,
): string {
  return (
    sourceId +
    "-" +
    kind +
    "-l" +
    String(location.start.line) +
    "-c" +
    String(location.start.column)
  );
}

function normalizeLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_MAX_FINITE_KEY_DOMAIN;
}
