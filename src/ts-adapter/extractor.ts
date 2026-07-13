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
 * Converts compact raw syntax observations into Core facts through an injected
 * builder. The default collaborators are intended to keep raw parser/source
 * text out of facts, but this class returns an injected backend's ID verbatim
 * and does not sanitize injected backend/builder output or thrown errors.
 * Callers that inject either collaborator must trust it or sanitize the
 * resulting output independently.
 */
export class TypeScriptSourceExtractor implements SourceExtractor {
  readonly #backend: SourceSyntaxBackend;
  readonly #maxFiniteKeyDomain: number;

  /**
   * Connects a raw syntax backend to the Core safety materializer and chooses its finite-domain cap.
   *
   * Inputs: A required injected `CoreSourceFactBuilder` plus optional backend and positive finite-domain limit.
   * Outputs: An extractor using the injected backend or TypeScript backend and a normalized cap.
   * Does not handle: Constructing a default builder, validating injected collaborator behavior, resolving imports, reading files, or inspecting environment values.
   * Side effects: Allocates a default TypeScript backend only when no backend is supplied; it always retains/calls the caller-injected builder, and collaborator construction/errors can propagate.
   */
   public constructor(
    readonly builder: CoreSourceFactBuilder,
    options: SourceExtractionOptions = {},
  ) {
    this.#backend = options.backend ?? new TypeScriptSyntaxBackend();
    this.#maxFiniteKeyDomain = normalizeLimit(options.maxFiniteKeyDomain);
  }

  /**
   * Extracts one supplied source string, materializes its observations, and isolates failed fact conversions as fixed diagnostics.
   *
   * Inputs: Source text, language, safe file/scope metadata, and optional source ID/exposure.
   * Outputs: A shallow-frozen result whose outer arrays contain the backend's verbatim ID, builder-returned references/edges, and extraction diagnostics. The arrays are frozen, but their contained records and nested values remain mutable.
   * Does not handle: Import resolution, execution, source-file I/O, backend exceptions, deep immutability, or sanitizing values/errors from injected backend or builder collaborators. An injected collaborator can violate expected safe-output/privacy properties unless the caller separately sanitizes its output.
   * Side effects: Calls the injected backend, allocates result arrays, may increment the direct-use source counter, and invokes injected builder materializers.
   */
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

  /**
   * Turns one backend observation into a reference plus either a direct demand edge or conservative dynamic edge.
   *
   * Inputs: One raw observation, its source context, and mutable result/diagnostic arrays owned by `extract`.
   * Outputs: No direct value; facts returned by the builder are appended to the appropriate arrays.
   * Does not handle: Sanitizing or suppressing an injected builder's rejected diagnostic: `materialize` passes that diagnostic through, so an injected builder that violates its contract can retain raw source/key text. It also does not resolve aliases beyond backend output or recover collaborator throws.
   * Side effects: Calls builder materializers through `materialize` and pushes collaborator-returned records/diagnostics into the supplied arrays.
   */
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

  /**
   * Materializes one dynamic observation and retries a rejected finite/pattern domain as opaque unbounded uncertainty.
   *
   * Inputs: Safe/generated IDs, raw location/domain/origin evidence, source scope, and mutable dynamic/diagnostic arrays.
   * Outputs: No direct value; it appends the builder-returned dynamic edge, or requests an opaque fallback after a rejected finite/pattern edge.
   * Does not handle: Retrying rejected unbounded input, making a pattern adapter-proven, or sanitizing values/errors from the injected builder. The raw finite candidate text is passed only to that builder boundary by this method.
   * Side effects: Maps finite candidate names, invokes the injected builder one or two times, and appends returned results/diagnostics.
   */
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
          ? domain.keys.map(/**
 * Converts one backend-provided finite candidate name into the raw logical-key shape expected by the safety builder.
 *
 * Inputs: One name from the raw finite dynamic domain.
 * Outputs: A `{ namespace: "env", name }` record for the enclosing raw dynamic edge.
 * Does not handle: Validating/redacting the name; `materializeDynamicLookupEdge` is that boundary.
 * Side effects: Allocates one projection object during `.map`.
 */
(name) => ({ namespace: "env", name }))
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

  /**
   * Routes a builder materialization result to its fact collection or to one fixed source-materialization failure diagnostic.
   *
   * Inputs: One builder `FactMaterialization` and mutable target/diagnostic arrays.
   * Outputs: The accepted builder value, or undefined after recording a fixed wrapper code and the identical builder-returned diagnostic object.
   * Does not handle: Catching a builder exception, retrying a failure, re-sanitizing a returned value/diagnostic, or passing any raw input to a separate diagnostic constructor. A rejected diagnostic from an injected builder can therefore retain raw text; the builder contract is trusted.
   * Side effects: Pushes exactly one builder value or one `SOURCE_FACT_MATERIALIZATION_FAILED` wrapper containing the builder diagnostic.
   */
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

/**
 * Provides the one-shot TypeScript extractor API by constructing an extractor and immediately scanning one input.
 *
 * Inputs: Source extraction input, a required caller-injected Core builder, and optional backend/limit options.
 * Outputs: The shallow-frozen extraction result, including the injected backend's verbatim ID and builder-returned records; its outer arrays are frozen while contained facts, diagnostics, and nested values remain mutable.
 * Does not handle: Constructing a default builder, reusing extractor state across calls, import resolution, filesystem reads, collaborator exceptions, deep immutability, or sanitizing injected backend/builder output. Callers that inject collaborators must trust or separately sanitize them.
 * Side effects: Allocates an extractor and a default TypeScript backend only when none is supplied, then invokes the required injected builder's materializers.
 */
export function extractTypeScriptSource(
  input: SourceExtractionInput,
  builder: CoreSourceFactBuilder,
  options: SourceExtractionOptions = {},
): SourceExtractionResult {
  return new TypeScriptSourceExtractor(builder, options).extract(input);
}

/**
 * Adapts backend coordinates and the caller's safe file token into the raw location shape consumed immediately by the factory.
 *
 * Inputs: A `SourceExtractionInput` file token and a raw backend location.
 * Outputs: A new `{ file, start, end }` record preserving the coordinate references.
 * Does not handle: Validating the file brand, source-span bounds, or retaining this record beyond materialization.
 * Side effects: Allocates the adapter record.
 */
function rawLocation(file: SourceExtractionInput["file"], location: RawSourceLocation): object {
  return {
    file,
    start: location.start,
    end: location.end,
  };
}

/**
 * Preserves the builder-returned diagnostic while satisfying the extraction diagnostic helper boundary.
 *
 * Inputs: A Core diagnostic returned by a fact materializer.
 * Outputs: The identical diagnostic object reference, including any data an injected builder improperly placed in it.
 * Does not handle: Re-sanitizing, cloning, or enriching the diagnostic; the caller trusts the builder's diagnostic contract and a contract-violating builder can retain raw text.
 * Side effects: None; it returns its input unchanged.
 */
function materializationDiagnostic(diagnostic: CoreDiagnostic): CoreDiagnostic {
  return diagnostic;
}

/**
 * Allocates a process-local opaque source identity for callers that did not supply a safe source ID.
 *
 * Inputs: No parameters.
 * Outputs: The next `source-direct-N` identity without file-path content.
 * Does not handle: Cross-process uniqueness, persistence, or stable IDs across process restarts.
 * Side effects: Increments module-global `directUseSourceSequence`.
 */
function nextDirectUseSourceId(): string {
  directUseSourceSequence += 1;
  return "source-direct-" + String(directUseSourceSequence);
}

/**
 * Derives a deterministic per-source fact ID from the supplied source identity, fact category, and start coordinate.
 *
 * Inputs: A safe source ID, one of three fact kinds, and a raw source location.
 * Outputs: A string ID incorporating only source ID, kind, start line, and start column.
 * Does not handle: Collision avoidance when callers reuse IDs/coordinates or redacting an unsafe source ID supplied by a collaborator.
 * Side effects: Converts coordinates to strings and concatenates a new identifier.
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

/**
 * Chooses the extractor's finite-domain cap without coercing malformed numeric input.
 *
 * Inputs: An optional numeric cap.
 * Outputs: The same positive safe integer or `DEFAULT_MAX_FINITE_KEY_DOMAIN`.
 * Does not handle: Aligning the cap with a builder's cap or imposing an upper bound beyond safe-integer positivity.
 * Side effects: None; it performs numeric predicates only and allocates nothing.
 */
function normalizeLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_MAX_FINITE_KEY_DOMAIN;
}
