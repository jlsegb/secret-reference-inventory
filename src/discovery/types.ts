import type { SafeDiagnosticCode, SafeIdentifier, SafePath } from "../safety/types.js";

/** Raw canonical path, intentionally confined to discovery and adapters. */
export type InternalPath = string & {
  readonly __brand: "InternalPath";
};

export type SourceLanguage = "js" | "jsx" | "ts" | "tsx";

export interface ApprovedRoot {
  readonly id: SafeIdentifier;
  /** Non-enumerable; never serialize this internal canonical filesystem path. */
  readonly canonicalPath: InternalPath;
}

export interface GuardedPath {
  readonly root: ApprovedRoot;
  /** Non-enumerable; adapters may read it but reporters must use displayPath. */
  readonly canonicalPath: InternalPath;
  readonly displayPath: SafePath;
}

export interface DiscoveredSourceFile extends GuardedPath {
  readonly language: SourceLanguage;
  readonly byteLength: number;
}

export interface DiscoverySkip {
  readonly rootId: SafeIdentifier;
  readonly path: SafePath;
  readonly code: SafeDiagnosticCode;
}

export interface DiscoveryBudget {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface DiscoveryResult {
  readonly roots: readonly ApprovedRoot[];
  readonly files: readonly DiscoveredSourceFile[];
  readonly skips: readonly DiscoverySkip[];
  readonly totalBytes: number;
  readonly budgetExhausted: boolean;
}

export interface SourceDiscoveryOptions {
  readonly roots: readonly string[];
  readonly extensions?: readonly string[];
  readonly budget?: Partial<DiscoveryBudget>;
  readonly toolIgnoreFileName?: string;
}

export const DEFAULT_DISCOVERY_BUDGET: DiscoveryBudget = Object.freeze({
  maxDepth: 40,
  maxFiles: 100_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
});
