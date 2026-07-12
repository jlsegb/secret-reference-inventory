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
 * Connects the raw-wire parser to Core's structural materialization boundary.
 * It deliberately maps every materialization failure to a fixed adapter code;
 * a Core diagnostic must never be copied into parser output as raw text.
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
    bindingCandidate(input) {
      return adaptResult(builder.materializeBindingCandidate(input));
    },
    inventorySnapshot(input) {
      return adaptResult(builder.materializeInventorySnapshot(input));
    },
    closedModel(input) {
      return adaptResult(builder.materializeClosedModel(input));
    },
    coverageGap(input) {
      return adaptResult(builder.materializeCoverageGap(input));
    },
  };
}

/** The adapter preserves candidates; Core owns precedence/partition selection. */
export const coreBindingResolutionPort: BindingResolutionPort<
  BindingCandidate,
  BindingResolution
> = Object.freeze({
  resolve: resolveBindingCandidates,
});

function adaptResult<T>(result: FactMaterialization<T>): FactBuilderResult<T> {
  if (result.ok) {
    return { ok: true, value: result.value };
  }

  // Keep the adapter's diagnostics fixed and value-free. The composition root
  // can retain the Core-safe diagnostic separately if it needs observability.
  return { ok: false, code: "unsafe-identifier" };
}
