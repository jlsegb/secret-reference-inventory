import type {
  BindingManifestParseResult,
  BindingResolutionPort,
} from "./contracts.js";

/**
 * Sends parsed binding candidates to the Core-owned selection port without choosing a winner locally.
 *
 * Inputs: A parse result's candidate collection and a Core-compatible resolution port.
 * Outputs: The exact resolution value returned by the supplied port when it returns normally; this helper imposes no ordering guarantee.
 * Does not handle: Parsing input, validating the port's return value, resolving coverage gaps, deciding precedence in the adapter, or catching/sanitizing port exceptions.
 * Side effects: Calls the supplied resolution port; any exception from it propagates unchanged.
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
