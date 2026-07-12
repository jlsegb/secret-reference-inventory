/**
 * Core-independent safety brands.  All externally reportable text must be
 * constructed by SafeFactFactory; these brands make accidental raw-string
 * propagation visible at TypeScript boundaries.
 */

export type SafeIdentifier = string & {
  readonly __brand: "SafeIdentifier";
};

export type SafePath = string & {
  readonly __brand: "SafePath";
};

export type SafeDiagnosticCode = string & {
  readonly __brand: "SafeDiagnosticCode";
};

export type SafeTimestamp = string & {
  readonly __brand: "SafeTimestamp";
};

/** A fixed non-reportable result for an unsafe source-derived identifier. */
export interface OpaqueIdentifier {
  readonly kind: "opaque";
  readonly reason: "unsafe-identifier";
}

export type Identifier = SafeIdentifier | OpaqueIdentifier;

export interface SafePosition {
  readonly line: number;
  readonly column: number;
}

export interface SafeLocation {
  readonly file: SafePath;
  readonly start: SafePosition;
  readonly end: SafePosition;
}

export interface SanitizedDiagnostic {
  readonly code: SafeDiagnosticCode;
  readonly location?: SafeLocation;
}

export const OPAQUE_IDENTIFIER: OpaqueIdentifier = Object.freeze({
  kind: "opaque" as const,
  reason: "unsafe-identifier" as const,
});

export const OPAQUE_PATH = "<opaque-path>" as SafePath;
