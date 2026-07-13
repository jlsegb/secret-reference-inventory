import { resolveBindingCandidates } from "../core/binding.js";
import type {
  BindingCandidate,
  BindingResolution,
  ClosedProvisioningModel,
  CoreFactBuilder,
  CoverageGap,
  FactMaterialization,
  InventorySnapshot,
} from "../core/types.js";

import type {
  BindingAdapterFactBuilder,
  BindingResolutionPort,
  FactBuilderResult,
} from "./contracts.js";

/**
 * Creates a parser-facing facade over Core's safe fact-materialization methods.
 *
 * Inputs: A Core fact builder that accepts raw adapter facts.
 * Outputs: An adapter builder whose methods return values or one fixed privacy-safe failure code only when the supplied Core materializer returns its union.
 * Does not handle: Binding precedence resolution, parsing wire input, exposing Core diagnostic detail, or catching/sanitizing exceptions from the supplied Core builder.
 * Side effects: Calls the supplied Core builder when a facade method is invoked; an exception from it propagates unchanged.
 */
export function adaptCoreFactBuilder(
  builder: CoreFactBuilder,
): BindingAdapterFactBuilder<
  BindingCandidate,
  InventorySnapshot,
  ClosedProvisioningModel,
  CoverageGap
> {
  return {
    /**
     * Materializes one normalized binding candidate through Core.
     *
     * Inputs: One adapter candidate object accepted by Core's binding materializer.
     * Outputs: If Core returns a materialization union, a safe candidate or the adapter's fixed unsafe-identifier result.
     * Does not handle: Selecting an effective candidate among competing bindings or catching/sanitizing a Core exception.
     * Side effects: Calls the supplied Core builder; any exception from it propagates unchanged.
     */
    bindingCandidate(input) {
      return adaptResult(builder.materializeBindingCandidate(input));
    },
    /**
     * Materializes one normalized inventory snapshot through Core.
     *
     * Inputs: One adapter inventory object accepted by Core's inventory materializer.
     * Outputs: If Core returns a materialization union, a safe snapshot or the adapter's fixed unsafe-identifier result.
     * Does not handle: Matching inventory resources to code demand or catching/sanitizing a Core exception.
     * Side effects: Calls the supplied Core builder; any exception from it propagates unchanged.
     */
    inventorySnapshot(input) {
      return adaptResult(builder.materializeInventorySnapshot(input));
    },
    /**
     * Materializes one closed-provisioning model through Core.
     *
     * Inputs: One adapter model object accepted by Core's closed-model materializer.
     * Outputs: If Core returns a materialization union, a safe model or the adapter's fixed unsafe-identifier result.
     * Does not handle: Proving model completeness, scanning source files, or catching/sanitizing a Core exception.
     * Side effects: Calls the supplied Core builder; any exception from it propagates unchanged.
     */
    closedModel(input) {
      return adaptResult(builder.materializeClosedModel(input));
    },
    /**
     * Materializes one adapter coverage gap through Core.
     *
     * Inputs: One normalized coverage-gap object accepted by Core.
     * Outputs: If Core returns a materialization union, a safe gap or the adapter's fixed unsafe-identifier result.
     * Does not handle: Recovering the omitted raw data, resolving the gap, or catching/sanitizing a Core exception.
     * Side effects: Calls the supplied Core builder; any exception from it propagates unchanged.
     */
    coverageGap(input) {
      return adaptResult(builder.materializeCoverageGap(input));
    },
  };
}

/**
 * Exposes Core's binding-selection function through the adapter port without adding an exception boundary.
 *
 * Inputs: Candidate facts supplied later through the port's `resolve` method.
 * Outputs: The exact Core resolutions when Core returns normally.
 * Does not handle: Parsing, precedence policy, result normalization, or catching/sanitizing Core exceptions.
 * Side effects: A later `resolve` call executes Core selection; any exception from it propagates unchanged.
 */
export const coreBindingResolutionPort: BindingResolutionPort<
  BindingCandidate,
  BindingResolution
> = Object.freeze({
  resolve: resolveBindingCandidates,
});

/**
 * Converts Core's materialization union into the adapter's value-free result union.
 *
 * Inputs: A Core materialization union that was already returned normally.
 * Outputs: The successful value unchanged, or a fixed unsafe-identifier error code.
 * Does not handle: Invoking Core, preserving Core diagnostic messages, retrying materialization, or catching Core exceptions.
 * Side effects: None.
 */
function adaptResult<T>(result: FactMaterialization<T>): FactBuilderResult<T> {
  if (result.ok) {
    return { ok: true, value: result.value };
  }

  // Keep the adapter's diagnostics fixed and value-free. The composition root
  // can retain the Core-safe diagnostic separately if it needs observability.
  return { ok: false, code: "unsafe-identifier" };
}
