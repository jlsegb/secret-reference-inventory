import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SafeFactFactory } from "../safety/factory.js";
import type { SafeDiagnosticCode } from "../safety/types.js";
import type { ApprovedRoot, GuardedPath, InternalPath } from "./types.js";

/**
 * A containment boundary for every filesystem path consumed by the scanner.
 * It uses real paths plus segment-aware ancestry; a string-prefix check is
 * never sufficient (`/repo/app` must not contain `/repo/app-old`).
 */
export class PathGuard {
  readonly #roots: readonly ApprovedRoot[];
  readonly #safety: SafeFactFactory;

  /**
   * Creates a guard from roots that have already passed real-path validation.
   *
   * Inputs: An immutable approved-root list and the factory used to derive display-safe paths.
   * Outputs: An initialized PathGuard instance.
   * Does not handle: Root validation, deduplication, or public construction from user input.
   * Side effects: Retains references to the supplied roots and safety factory.
   */
  private constructor(roots: readonly ApprovedRoot[], safety: SafeFactFactory) {
    this.#roots = roots;
    this.#safety = safety;
  }

  /**
   * Validates requested root directories and builds a containment guard for them.
   *
   * Inputs: User-supplied root strings and a factory for safe root identifiers and display paths.
   * Outputs: A guard containing distinct canonical directory roots ordered deepest first.
   * Does not handle: Creating roots, recovering unreadable paths, or traversing their contents.
   * Side effects: Resolves and stats each supplied path; throws PathGuardError for invalid input or filesystem access failures.
   */
  public static async create(
    rootInputs: readonly string[],
    safety: SafeFactFactory,
  ): Promise<PathGuard> {
    if (rootInputs.length === 0) {
      throw new PathGuardError("NO_APPROVED_ROOT");
    }

    const roots: ApprovedRoot[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < rootInputs.length; index += 1) {
      const rootInput = rootInputs[index];
      if (typeof rootInput !== "string" || rootInput.length === 0) {
        throw new PathGuardError("INVALID_APPROVED_ROOT");
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(resolve(rootInput));
        const metadata = await stat(canonicalPath);
        if (!metadata.isDirectory()) {
          throw new PathGuardError("APPROVED_ROOT_NOT_DIRECTORY");
        }
      } catch (error) {
        if (error instanceof PathGuardError) {
          throw error;
        }
        throw new PathGuardError("UNREADABLE_APPROVED_ROOT");
      }

      if (seen.has(canonicalPath)) {
        continue;
      }
      seen.add(canonicalPath);

      const identifier = safety.genericIdentifier(`root-${index + 1}`);
      if (typeof identifier !== "string") {
        throw new PathGuardError("INVALID_APPROVED_ROOT");
      }

      roots.push(createApprovedRoot(identifier, canonicalPath as InternalPath));
    }

    if (roots.length === 0) {
      throw new PathGuardError("NO_APPROVED_ROOT");
    }

    // Choose the deepest root when roots overlap so report paths stay local.
    roots.sort(
      /**
       * Orders overlapping roots from deepest to shallowest for containment selection.
       *
       * Inputs: Two approved-root descriptors.
       * Outputs: A descending canonical-path-length comparator result.
       * Does not handle: Lexical path ordering, containment validation, or a total order for equal-length roots; equal lengths retain their prior root-input order under stable Array.sort.
       * Side effects: None.
       */
      (left, right) => right.canonicalPath.length - left.canonicalPath.length,
    );
    return new PathGuard(Object.freeze(roots), safety);
  }

  /**
   * Exposes the guard's frozen canonical root descriptors for trusted traversal.
   *
   * Inputs: None.
   * Outputs: The ordered immutable approved-root list.
   * Does not handle: Hiding root identifiers or copying the individual descriptors.
   * Side effects: None.
   */
  public get roots(): readonly ApprovedRoot[] {
    return this.#roots;
  }

  /**
   * Resolves an existing candidate and returns it only when its real path remains contained.
   *
   * Inputs: One nonempty filesystem candidate string.
   * Outputs: A guarded path with a safe display path, or undefined when resolution fails or escapes every root.
   * Does not handle: Creating missing paths, preserving a path snapshot after realpath, or explaining rejection.
   * Side effects: Reads filesystem real-path metadata; a caller can observe replacement after this point-in-time containment check.
   */
  public async resolveExisting(candidate: string): Promise<GuardedPath | undefined> {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return undefined;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch {
      return undefined;
    }

    return this.fromCanonicalPath(canonicalPath);
  }

  /**
   * Wraps an already-canonical traversal path only when it is contained by an approved root.
   *
   * Inputs: A canonical path supplied by trusted traversal code.
   * Outputs: A guarded descriptor for the deepest containing root, or undefined when outside all roots.
   * Does not handle: Resolving relative paths, validating filesystem existence, or making the canonical path reportable.
   * Side effects: Delegates display-path materialization to the retained SafeFactFactory.
   */
  public fromCanonicalPath(canonicalPath: string): GuardedPath | undefined {
    const root = this.#roots.find(
      /**
       * Selects a root containing the supplied trusted canonical path.
       *
       * Inputs: One approved root from the guard's depth-ordered roots.
       * Outputs: True when that root segment-contains the requested path.
       * Does not handle: Real-path resolution or choosing among later roots.
       * Side effects: None.
       */
      (candidateRoot) => isSegmentDescendant(candidateRoot.canonicalPath, canonicalPath),
    );

    if (root === undefined) {
      return undefined;
    }

    return createGuardedPath(
      root,
      canonicalPath as InternalPath,
      this.#safety.safePath({
        approvedRoot: root.canonicalPath,
        canonicalPath,
      }),
    );
  }

  /**
   * Checks whether a candidate is a symbolic link without resolving its target.
   *
   * Inputs: One filesystem candidate path.
   * Outputs: True or false for a readable directory entry, or undefined when metadata cannot be read.
   * Does not handle: Target containment, symlink resolution, error reporting, or a race-free guarantee for later filesystem use.
   * Side effects: Reads point-in-time lstat metadata from the local filesystem.
   */
  public async isSymlink(candidate: string): Promise<boolean | undefined> {
    try {
      return (await lstat(candidate)).isSymbolicLink();
    } catch {
      return undefined;
    }
  }
}

export class PathGuardError extends Error {
  readonly code: SafeDiagnosticCode;

  /**
   * Constructs the stable error used for approved-root validation failures.
   *
   * Inputs: One allowlisted root-validation diagnostic code.
   * Outputs: A PathGuardError whose name, message, and safe code equal that code.
   * Does not handle: Wrapping arbitrary errors or retaining the rejected filesystem path.
   * Side effects: Initializes the Error base object.
   */
  public constructor(
    code:
      | "NO_APPROVED_ROOT"
      | "INVALID_APPROVED_ROOT"
      | "APPROVED_ROOT_NOT_DIRECTORY"
      | "UNREADABLE_APPROVED_ROOT",
  ) {
    super(code);
    this.name = "PathGuardError";
    this.code = code as SafeDiagnosticCode;
  }
}

/**
 * Tests ancestry using path segments rather than a vulnerable string prefix.
 *
 * Inputs: A root path and a candidate path in the host platform's path syntax.
 * Outputs: True when the candidate is the root itself or lies below it.
 * Does not handle: Real-path resolution, filesystem existence, or case-folding policy.
 * Side effects: None.
 */
export function isSegmentDescendant(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

/**
 * Returns the non-enumerable canonical path for trusted internal adapters.
 *
 * Inputs: A previously guarded path descriptor.
 * Outputs: Its InternalPath canonical path.
 * Does not handle: Safe display conversion, authorization, or reporter-facing serialization.
 * Side effects: None.
 */
export function internalPathOf(path: GuardedPath): InternalPath {
  return path.canonicalPath;
}

/**
 * Creates an immutable root descriptor while keeping its canonical path non-enumerable.
 *
 * Inputs: A safe root identifier and canonical internal path.
 * Outputs: A frozen ApprovedRoot whose canonical path is available only to typed internal consumers.
 * Does not handle: Validating either input or deriving a display path.
 * Side effects: Defines a non-enumerable property on the returned object.
 */
function createApprovedRoot(id: ApprovedRoot["id"], canonicalPath: InternalPath): ApprovedRoot {
  const root = { id } as ApprovedRoot;
  Object.defineProperty(root, "canonicalPath", {
    value: canonicalPath,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(root);
}

/**
 * Builds an immutable path descriptor that pairs trusted canonical data with its safe display form.
 *
 * Inputs: An approved root, a canonical internal path beneath it, and a SafePath display value.
 * Outputs: A frozen GuardedPath with a non-enumerable canonical path.
 * Does not handle: Checking containment, validating display safety, or resolving symlinks.
 * Side effects: Defines a non-enumerable property on the returned object.
 */
export function createGuardedPath(
  root: ApprovedRoot,
  canonicalPath: InternalPath,
  displayPath: GuardedPath["displayPath"],
): GuardedPath {
  const guarded = { root, displayPath } as GuardedPath;
  Object.defineProperty(guarded, "canonicalPath", {
    value: canonicalPath,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(guarded);
}
