import type {
  BindingManifestParseResult,
  BindingResolutionPort,
} from "./contracts.js";

/**
 * Selection is Core-owned. This helper makes the handoff explicit and ensures
 * an adapter never chooses an effective binding merely because it found one.
 */
export function resolveParsedBindingCandidates<
  TBindingCandidate,
  TCoverageGap,
  TBindingResolution,
>(
  parsed: Pick<BindingManifestParseResult<TBindingCandidate, TCoverageGap>, "candidates">,
  port: BindingResolutionPort<TBindingCandidate, TBindingResolution>,
): readonly TBindingResolution[] {
  return port.resolve(parsed.candidates);
}
