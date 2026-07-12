import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

import { SafeFactFactory } from "../safety/factory.js";
import type { SafeDiagnosticCode, SafePath } from "../safety/types.js";
import { PathGuard, PathGuardError, createGuardedPath } from "./path-guard.js";
import {
  DEFAULT_DISCOVERY_BUDGET,
  type ApprovedRoot,
  type DiscoveryBudget,
  type DiscoveryResult,
  type DiscoverySkip,
  type DiscoveredSourceFile,
  type InternalPath,
  type SourceDiscoveryOptions,
  type SourceLanguage,
} from "./types.js";

const DEFAULT_SOURCE_EXTENSIONS = new Map<string, SourceLanguage>([
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
]);

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".jj",
  ".svn",
  ".turbo",
  ".next",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

const DEFAULT_TOOL_IGNORE_FILE = ".secret-usageignore";

interface IgnoreContext {
  readonly directory: InternalPath;
  readonly matcher: Ignore;
}

interface MutableDiscoveryState {
  readonly files: DiscoveredSourceFile[];
  readonly skips: DiscoverySkip[];
  totalBytes: number;
  budgetExhausted: boolean;
}

/**
 * Discovers source files without reading or executing those files. Every path
 * returned to adapters remains an InternalPath; reportable paths are produced
 * by SafeFactFactory through PathGuard.
 */
export async function discoverSources(
  options: SourceDiscoveryOptions,
  safety = new SafeFactFactory(),
): Promise<DiscoveryResult> {
  const guard = await PathGuard.create(options.roots, safety);
  const budget = normalizeBudget(options.budget);
  const extensions = normalizeExtensions(options.extensions);
  const toolIgnoreFileName = options.toolIgnoreFileName ?? DEFAULT_TOOL_IGNORE_FILE;

  if (!isSafeIgnoreFileName(toolIgnoreFileName)) {
    throw new DiscoveryError("INVALID_DISCOVERY_OPTIONS");
  }

  const state: MutableDiscoveryState = {
    files: [],
    skips: [],
    totalBytes: 0,
    budgetExhausted: false,
  };

  for (const root of guard.roots) {
    if (state.budgetExhausted) {
      recordSkip(state, safety, root, root.canonicalPath, "BUDGET_EXCEEDED");
      continue;
    }

    const rootContexts = await loadIgnoreContexts(
      root,
      root.canonicalPath,
      [],
      toolIgnoreFileName,
      state,
      safety,
    );
    await walkDirectory({
      guard,
      root,
      directory: root.canonicalPath,
      depth: 0,
      contexts: rootContexts,
      extensions,
      budget,
      toolIgnoreFileName,
      safety,
      state,
    });
  }

  return Object.freeze({
    roots: guard.roots,
    files: Object.freeze([...state.files]),
    skips: Object.freeze([...state.skips]),
    totalBytes: state.totalBytes,
    budgetExhausted: state.budgetExhausted,
  });
}

interface WalkOptions {
  readonly guard: PathGuard;
  readonly root: ApprovedRoot;
  readonly directory: InternalPath;
  readonly depth: number;
  readonly contexts: readonly IgnoreContext[];
  readonly extensions: ReadonlyMap<string, SourceLanguage>;
  readonly budget: DiscoveryBudget;
  readonly toolIgnoreFileName: string;
  readonly safety: SafeFactFactory;
  readonly state: MutableDiscoveryState;
}

async function walkDirectory(options: WalkOptions): Promise<void> {
  const {
    guard,
    root,
    directory,
    depth,
    contexts,
    extensions,
    budget,
    toolIgnoreFileName,
    safety,
    state,
  } = options;

  if (state.budgetExhausted) {
    return;
  }

  if (depth > budget.maxDepth) {
    recordSkip(state, safety, root, directory, "DEPTH_EXCEEDED");
    return;
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    recordSkip(state, safety, root, directory, "UNREADABLE");
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    if (state.budgetExhausted) {
      return;
    }

    const candidate = join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      recordSkip(state, safety, root, candidate, "SYMLINK");
      continue;
    }

    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
        recordSkip(state, safety, root, candidate, "EXCLUDED_DIRECTORY");
        continue;
      }

      // Dirent metadata can be stale. Re-check without following a symlink
      // before recursing, then re-establish canonical root containment.
      let directoryMetadata: Awaited<ReturnType<typeof lstat>>;
      try {
        directoryMetadata = await lstat(candidate);
      } catch {
        recordSkip(state, safety, root, candidate, "UNREADABLE");
        continue;
      }
      if (directoryMetadata.isSymbolicLink()) {
        recordSkip(state, safety, root, candidate, "SYMLINK");
        continue;
      }
      if (!directoryMetadata.isDirectory()) {
        recordSkip(state, safety, root, candidate, "SPECIAL_FILE");
        continue;
      }

      const guardedDirectory = await guard.resolveExisting(candidate);
      if (guardedDirectory === undefined || guardedDirectory.root.id !== root.id) {
        recordSkip(state, safety, root, candidate, "OUTSIDE_ROOT");
        continue;
      }

      if (isIgnored(contexts, candidate, true)) {
        recordSkip(state, safety, root, candidate, "IGNORED");
        continue;
      }

      const nestedContexts = await loadIgnoreContexts(
        root,
        guardedDirectory.canonicalPath,
        contexts,
        toolIgnoreFileName,
        state,
        safety,
      );
      await walkDirectory({
        ...options,
        directory: guardedDirectory.canonicalPath,
        depth: depth + 1,
        contexts: nestedContexts,
      });
      continue;
    }

    if (!entry.isFile()) {
      recordSkip(state, safety, root, candidate, "SPECIAL_FILE");
      continue;
    }

    if (isIgnored(contexts, candidate, false)) {
      recordSkip(state, safety, root, candidate, "IGNORED");
      continue;
    }

    if (isGeneratedArtifact(entry.name)) {
      recordSkip(state, safety, root, candidate, "GENERATED");
      continue;
    }

    const language = extensions.get(extname(entry.name).toLowerCase());
    if (language === undefined) {
      recordSkip(state, safety, root, candidate, "UNSUPPORTED_FILE");
      continue;
    }

    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(candidate);
    } catch {
      recordSkip(state, safety, root, candidate, "UNREADABLE");
      continue;
    }

    if (metadata.isSymbolicLink()) {
      recordSkip(state, safety, root, candidate, "SYMLINK");
      continue;
    }
    if (!metadata.isFile()) {
      recordSkip(state, safety, root, candidate, "SPECIAL_FILE");
      continue;
    }
    if (metadata.size > budget.maxFileBytes) {
      recordSkip(state, safety, root, candidate, "OVERSIZE");
      continue;
    }
    if (state.files.length >= budget.maxFiles || state.totalBytes + metadata.size > budget.maxTotalBytes) {
      state.budgetExhausted = true;
      recordSkip(state, safety, root, candidate, "BUDGET_EXCEEDED");
      return;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch {
      recordSkip(state, safety, root, candidate, "UNREADABLE");
      continue;
    }

    const guarded = guard.fromCanonicalPath(canonicalPath);
    if (guarded === undefined || guarded.root.id !== root.id) {
      recordSkip(state, safety, root, candidate, "OUTSIDE_ROOT");
      continue;
    }

    state.files.push(
      createDiscoveredSourceFile(guarded, language, metadata.size),
    );
    state.totalBytes += metadata.size;
  }
}

async function loadIgnoreContexts(
  root: ApprovedRoot,
  directory: InternalPath,
  parentContexts: readonly IgnoreContext[],
  toolIgnoreFileName: string,
  state: MutableDiscoveryState,
  safety: SafeFactFactory,
): Promise<readonly IgnoreContext[]> {
  const contexts: IgnoreContext[] = [...parentContexts];
  const fileNames = [".gitignore", toolIgnoreFileName];

  for (const fileName of fileNames) {
    const candidate = join(directory, fileName);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(candidate);
    } catch {
      continue;
    }

    if (metadata.isSymbolicLink()) {
      recordSkip(state, safety, root, candidate, "SYMLINK");
      continue;
    }
    if (!metadata.isFile()) {
      continue;
    }

    try {
      const contents = await readFile(candidate, "utf8");
      const matcher = ignore();
      matcher.add(contents);
      contexts.push({ directory, matcher });
    } catch {
      // Ignore-file content and parser errors are deliberately not reported.
      recordSkip(state, safety, root, candidate, "UNREADABLE_IGNORE_FILE");
    }
  }

  return contexts;
}

function isIgnored(
  contexts: readonly IgnoreContext[],
  candidate: string,
  directory: boolean,
): boolean {
  for (const context of contexts) {
    const candidateRelativePath = toIgnorePath(context.directory, candidate, directory);
    if (candidateRelativePath !== undefined && context.matcher.ignores(candidateRelativePath)) {
      return true;
    }
  }
  return false;
}

function toIgnorePath(
  contextDirectory: string,
  candidate: string,
  directory: boolean,
): string | undefined {
  const relativePath = relative(contextDirectory, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  const normalized = relativePath.split(sep).join("/");
  return directory ? `${normalized}/` : normalized;
}

function normalizeExtensions(extensions: readonly string[] | undefined): ReadonlyMap<string, SourceLanguage> {
  if (extensions === undefined) {
    return DEFAULT_SOURCE_EXTENSIONS;
  }

  const normalized = new Map<string, SourceLanguage>();
  for (const extension of extensions) {
    if (typeof extension !== "string") {
      throw new DiscoveryError("INVALID_DISCOVERY_OPTIONS");
    }
    const normalizedExtension = extension.startsWith(".")
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    const language = DEFAULT_SOURCE_EXTENSIONS.get(normalizedExtension);
    if (language === undefined) {
      throw new DiscoveryError("INVALID_DISCOVERY_OPTIONS");
    }
    normalized.set(normalizedExtension, language);
  }

  if (normalized.size === 0) {
    throw new DiscoveryError("INVALID_DISCOVERY_OPTIONS");
  }

  return normalized;
}

function normalizeBudget(input: Partial<DiscoveryBudget> | undefined): DiscoveryBudget {
  const budget = {
    ...DEFAULT_DISCOVERY_BUDGET,
    ...input,
  };

  if (
    !isPositiveSafeInteger(budget.maxDepth) ||
    !isPositiveSafeInteger(budget.maxFiles) ||
    !isPositiveSafeInteger(budget.maxTotalBytes) ||
    !isPositiveSafeInteger(budget.maxFileBytes)
  ) {
    throw new DiscoveryError("INVALID_DISCOVERY_OPTIONS");
  }

  return budget;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeIgnoreFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    basename(value) === value &&
    !value.includes("\0")
  );
}

function isGeneratedArtifact(fileName: string): boolean {
  return (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".map") ||
    /\.min\.[cm]?[jt]sx?$/i.test(fileName)
  );
}

function recordSkip(
  state: MutableDiscoveryState,
  safety: SafeFactFactory,
  root: ApprovedRoot,
  candidate: string,
  code: string,
): void {
  state.skips.push({
    rootId: root.id,
    path: safety.safePath({
      approvedRoot: root.canonicalPath,
      canonicalPath: candidate,
    }),
    code: safety.diagnosticCode(code),
  });
}

export class DiscoveryError extends Error {
  readonly code: SafeDiagnosticCode;

  public constructor(code: "INVALID_DISCOVERY_OPTIONS") {
    super(code);
    this.name = "DiscoveryError";
    this.code = code as SafeDiagnosticCode;
  }
}

export function isPathGuardError(error: unknown): error is PathGuardError {
  return error instanceof PathGuardError;
}

function createDiscoveredSourceFile(
  guarded: ReturnType<PathGuard["fromCanonicalPath"]> extends infer T
    ? Exclude<T, undefined>
    : never,
  language: SourceLanguage,
  byteLength: number,
): DiscoveredSourceFile {
  const path = createGuardedPath(
    guarded.root,
    guarded.canonicalPath,
    guarded.displayPath,
  );
  const source = {
    root: path.root,
    displayPath: path.displayPath,
    language,
    byteLength,
  } as DiscoveredSourceFile;
  Object.defineProperty(source, "canonicalPath", {
    value: path.canonicalPath,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(source);
}
