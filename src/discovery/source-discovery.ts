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
 * Traverses approved roots to inventory eligible source files without reading or executing their contents.
 *
 * Inputs: Root paths plus optional extension, ignore-file, and resource-budget configuration, and an optional safety factory.
 * Outputs: Frozen discovered-source descriptors, privacy-safe skip records, byte total, and exhaustion state.
 * Does not handle: Parsing source text, following an entry found to be a symlink at its check, traversing source files or directories outside approved roots, or recovering skipped coverage. The lstat/realpath/read sequence is not atomic, so it cannot prevent a checked path from being replaced before later use. A configured ignore descriptor named `.` or `..` is an exception only for its lstat metadata probe: `..` can probe the parent outside an approved root, but neither name is traversed as source nor read as ignore-file content.
 * Side effects: Reads directory and file metadata, real paths, and ignore-file contents from regular ignore files; may lstat the current or parent directory for configured `.` or `..` descriptor names; throws PathGuardError or DiscoveryError for invalid configuration.
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

/**
 * Recursively enumerates one guarded directory while enforcing ignore, type, and budget boundaries.
 *
 * Inputs: Shared traversal state with one approved root, canonical directory, inherited ignores, extensions, and limits.
 * Outputs: No direct value; eligible files and safe skips are appended to the shared state.
 * Does not handle: Reading source-file contents, following an entry found to be a symlink at its check, retrying filesystem failures, or making the lstat/realpath/readdir checks atomic against replacement.
 * Side effects: Reads directory, lstat, and realpath metadata and mutates the supplied traversal state; a path can change between those checks and a later traversal operation.
 */
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

  entries.sort(
    /**
     * Orders directory entries by English-locale collation before traversal.
     *
     * Inputs: Two filesystem directory-entry descriptors.
     * Outputs: Their English-locale name comparator result.
     * Does not handle: Case normalization, path validation, or a total order: collation ties retain the original readdir order under stable Array.sort and can therefore vary with filesystem enumeration.
     * Side effects: None.
     */
    (left, right) => left.name.localeCompare(right.name, "en"),
  );

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

/**
 * Extends inherited ignore matchers with readable regular ignore files in one directory.
 *
 * Inputs: An approved root, canonical directory, parent contexts, tool-ignore filename, and shared safe-state services.
 * Outputs: A new context list containing inherited matchers and successfully parsed local matchers.
 * Does not handle: Symlinked or malformed ignore files, reporting ignore-file content, propagating parser errors, or preventing a regular file checked with lstat from being replaced before readFile. The allowed `.` and `..` descriptor names are not regular files here, so their current- or parent-directory lstat probe never adds a matcher or reads content.
 * Side effects: Reads lstat metadata and regular ignore-file contents, including an lstat probe outside the root for a configured `..` descriptor name, and records safe skip entries for unsafe or unreadable ignore files; the metadata/read sequence is not race-free.
 */
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

/**
 * Determines whether any active ignore context excludes a candidate path.
 *
 * Inputs: Ordered ignore contexts, a candidate path, and whether the candidate is a directory.
 * Outputs: True when a context matcher ignores the candidate's relative slash path.
 * Does not handle: Ignore-pattern parsing, candidate containment, or explaining which pattern matched.
 * Side effects: None.
 */
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

/**
 * Converts a candidate into the slash-delimited relative path expected by an ignore matcher.
 *
 * Inputs: A context directory, candidate path, and directory marker flag.
 * Outputs: A nonempty relative ignore path, optionally suffixed with '/', or undefined when the candidate is the context directory itself or lies outside that context.
 * Does not handle: Containment repair, glob evaluation, or filesystem resolution.
 * Side effects: None.
 */
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

/**
 * Validates requested source extensions and maps them to supported parser languages.
 *
 * Inputs: Optional extension strings with or without leading periods.
 * Outputs: The default extension map or a normalized map limited to supported extensions.
 * Does not handle: Inferring language from file content or accepting unsupported extensions.
 * Side effects: Throws DiscoveryError for malformed, unsupported, or empty explicit selections.
 */
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

/**
 * Merges a partial resource budget with defaults and rejects unsafe numeric limits.
 *
 * Inputs: Optional overrides for depth, file count, total bytes, and single-file bytes.
 * Outputs: A complete positive-safe-integer DiscoveryBudget.
 * Does not handle: Dynamic budget adjustment during traversal or coercion of numeric-like values.
 * Side effects: Throws DiscoveryError when any resulting limit is invalid.
 */
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

/**
 * Identifies positive JavaScript safe integers accepted as discovery resource limits.
 *
 * Inputs: Any runtime value.
 * Outputs: A number type guard true only for positive safe integers.
 * Does not handle: Numeric coercion, zero, negative values, or fractional quantities.
 * Side effects: None.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Checks a configured tool-ignore filename against the limited filename policy currently enforced.
 *
 * Inputs: One requested filename string.
 * Outputs: True only for a nonempty, short basename without NUL bytes, including the special basenames `.` and `..`.
 * Does not handle: Filesystem existence, reserved names, ignore-pattern validation, or rejection of `.` and `..`; those accepted names can cause lstat metadata reads on the current or parent directory, including outside the approved root for `..`.
 * Side effects: None.
 */
function isSafeIgnoreFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    basename(value) === value &&
    !value.includes("\0")
  );
}

/**
 * Recognizes declaration, source-map, and minified filename forms excluded from source demand analysis.
 *
 * Inputs: One directory-entry filename.
 * Outputs: True when the filename matches a generated-artifact convention.
 * Does not handle: Content-based generated-code detection or all build-system conventions.
 * Side effects: None.
 */
function isGeneratedArtifact(fileName: string): boolean {
  return (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".map") ||
    /\.min\.[cm]?[jt]sx?$/i.test(fileName)
  );
}

/**
 * Appends a privacy-safe reason that one traversal candidate was not scanned.
 *
 * Inputs: Mutable discovery state, safety factory, containing root, raw candidate path, and reason code.
 * Outputs: No direct value; one normalized DiscoverySkip is appended.
 * Does not handle: Retrying the candidate, deduplicating skips, or making a coverage conclusion.
 * Side effects: Mutates state.skips and asks the safety factory to sanitize path and code data.
 */
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

  /**
   * Constructs the stable error used when discovery configuration fails validation.
   *
   * Inputs: The only allowlisted invalid-options diagnostic code.
   * Outputs: A DiscoveryError with that code as its name, message, and safe code.
   * Does not handle: Wrapping traversal errors or recording the rejected option value.
   * Side effects: Initializes the Error base object.
   */
  public constructor(code: "INVALID_DISCOVERY_OPTIONS") {
    super(code);
    this.name = "DiscoveryError";
    this.code = code as SafeDiagnosticCode;
  }
}

/**
 * Narrows an unknown caught value to the approved-root error type.
 *
 * Inputs: Any caught or supplied runtime value.
 * Outputs: True only for PathGuardError instances.
 * Does not handle: Inspecting error codes, cross-realm error serialization, or converting errors.
 * Side effects: None.
 */
export function isPathGuardError(error: unknown): error is PathGuardError {
  return error instanceof PathGuardError;
}

/**
 * Creates a frozen source descriptor while retaining its canonical path as internal non-enumerable metadata.
 *
 * Inputs: A guarded file path, supported language tag, and metadata byte length captured during traversal.
 * Outputs: A DiscoveredSourceFile exposing only safe display fields and internal canonical-path access for adapters.
 * Does not handle: Rechecking or opening a stable file snapshot after metadata capture, reading content, or validating byte length.
 * Side effects: Defines a non-enumerable canonicalPath property on the returned object; a later consumer can observe a file replaced after discovery's lstat/realpath checks.
 */
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
