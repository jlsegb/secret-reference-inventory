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

  private constructor(roots: readonly ApprovedRoot[], safety: SafeFactFactory) {
    this.#roots = roots;
    this.#safety = safety;
  }

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
    roots.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);
    return new PathGuard(Object.freeze(roots), safety);
  }

  public get roots(): readonly ApprovedRoot[] {
    return this.#roots;
  }

  /**
   * Resolves an existing candidate and returns it only when its canonical real
   * path remains under an approved root.
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
   * Returns a safe result for a canonical path already obtained by trusted
   * traversal code. It still checks every approved root before exposing it.
   */
  public fromCanonicalPath(canonicalPath: string): GuardedPath | undefined {
    const root = this.#roots.find((candidateRoot) =>
      isSegmentDescendant(candidateRoot.canonicalPath, canonicalPath),
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

  /** A non-following check used by source discovery before it calls realpath. */
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

export function isSegmentDescendant(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

/** Explicit escape hatch for trusted adapters; never pass this to reporters. */
export function internalPathOf(path: GuardedPath): InternalPath {
  return path.canonicalPath;
}

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
