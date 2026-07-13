import { open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { InternalPath } from "../discovery/index.js";

/** The narrow portion of a file stat needed to prove a stable local read. */
export interface BoundedFileStat {
  readonly size: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** A deliberately small FileHandle surface, also usable by deterministic tests. */
export interface BoundedFileHandle {
  stat(): Promise<BoundedFileStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface BoundedLocalFileOperations {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<BoundedFileStat>;
  open(path: string, flags: string): Promise<BoundedFileHandle>;
}

export type BoundedLocalTextReadResult =
  | {
      readonly ok: true;
      readonly canonicalPath: InternalPath;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly code: "read-failed" | "too-large";
    };

interface StableFileIdentity {
  readonly size: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface StableDirectoryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/**
 * Internal provenance for a successful bounded read. It is held in a WeakMap
 * rather than on the returned document so canonical paths and filesystem
 * identities cannot be serialized or reconstructed by callers.
 */
export interface VerifiedBoundedReadContext {
  readonly text: string;
  readonly canonicalPath: InternalPath;
  readonly canonicalBase: InternalPath;
  readonly fileIdentity: StableFileIdentity;
  readonly baseIdentity: StableDirectoryIdentity;
}

const VERIFIED_READS = new WeakMap<object, VerifiedBoundedReadContext>();

/**
 * Retrieves the private provenance for an exact successful bounded-read result.
 *
 * Inputs: An unknown value that may be the frozen success object returned by `readBoundedLocalText`.
 * Outputs: Its private stable-read context, or `undefined` for primitives, failures, clones, proxies, and forged objects.
 * Does not handle: Re-reading a file or validating a structurally similar result.
 * Side effects: Reads the module-private WeakMap without invoking caller-owned properties.
 */
export function verifiedBoundedReadContext(
  input: unknown,
): VerifiedBoundedReadContext | undefined {
  return input !== null && typeof input === "object"
    ? VERIFIED_READS.get(input as object)
    : undefined;
}

const nodeOperations: BoundedLocalFileOperations = {
  realpath: /**
   * Resolves a supplied local path to Node's canonical filesystem path.
   *
   * Inputs: One local path string.
   * Outputs: A promise for the canonical path, or a rejected filesystem promise.
   * Does not handle: Path containment, stability checks, or error redaction.
   * Side effects: Queries local filesystem metadata.
   */ (path) => realpath(path),
  stat: /**
   * Obtains Node metadata for a local filesystem path.
   *
   * Inputs: One local path string.
   * Outputs: A promise for the path's stat structure, or a rejected filesystem promise.
   * Does not handle: File-type policy or stable identity comparison.
   * Side effects: Reads local filesystem metadata.
   */ async (path) => stat(path),
  open: /**
   * Opens one canonical local path with the requested Node flags.
   *
   * Inputs: A local path and Node open-mode string.
   * Outputs: A promise for the narrowed file-handle surface, or a rejected filesystem promise.
   * Does not handle: Byte limits, handle closure, or content validation.
   * Side effects: Opens a local file descriptor that the caller must close.
   */ async (path, flags) => open(path, flags) as unknown as BoundedFileHandle,
};

/**
 * Reads a stable local UTF-8 file through one descriptor while enforcing an exact byte cap.
 *
 * Inputs: A requested path, a nonnegative safe-integer maximum byte count, and optional filesystem operations.
 * Outputs: A frozen `{ ok: true, canonicalPath, text }` result, or a fixed `read-failed` or `too-large` failure.
 * Does not handle: JSON parsing, caller-provided path authorization, decoding errors beyond Node's UTF-8 conversion, or retries.
 * Side effects: Resolves and stats paths, opens, stats, reads, and closes one local file descriptor; records success provenance in a WeakMap.
 */
export async function readBoundedLocalText(
  path: string,
  maxBytes: number,
  operations: BoundedLocalFileOperations = nodeOperations,
): Promise<BoundedLocalTextReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return failedRead();
  }

  let canonicalPath: string;
  let canonicalBase: string;
  try {
    canonicalPath = await operations.realpath(path);
    canonicalBase = dirname(canonicalPath);
  } catch {
    return failedRead();
  }

  let handle: BoundedFileHandle | undefined;
  let result: BoundedLocalTextReadResult = failedRead();
  try {
    const initialBaseStat = await operations.stat(canonicalBase);
    if (!isReadableDirectory(initialBaseStat)) {
      return failedRead();
    }
    handle = await operations.open(canonicalPath, "r");
    const before = await handle.stat();
    if (!isReadableFile(before)) {
      result = failedRead();
    } else if (before.size > maxBytes) {
      result = tooLarge();
    } else {
      const firstPathStat = await operations.stat(canonicalPath);
      if (!sameStableIdentity(before, firstPathStat)) {
        result = failedRead();
      } else {
        const bytes = await readExactBounded(handle, before.size, maxBytes);
        if (bytes === undefined) {
          result = failedRead();
        } else {
          const after = await handle.stat();
          const finalPathStat = await operations.stat(canonicalPath);
          const finalBaseStat = await operations.stat(canonicalBase);
          if (
            !sameStableVersion(before, after) ||
            !sameStableVersion(before, finalPathStat) ||
            !sameStableDirectoryIdentity(initialBaseStat, finalBaseStat)
          ) {
            result = failedRead();
          } else if (after.size > maxBytes || finalPathStat.size > maxBytes) {
            result = tooLarge();
          } else {
            const success = Object.freeze({
              ok: true,
              canonicalPath: canonicalPath as InternalPath,
              text: bytes.toString("utf8"),
            });
            VERIFIED_READS.set(
              success,
              Object.freeze({
                text: success.text,
                canonicalPath: success.canonicalPath,
                canonicalBase: canonicalBase as InternalPath,
                fileIdentity: stableFileIdentity(before),
                baseIdentity: stableDirectoryIdentity(initialBaseStat),
              }),
            );
            result = success;
          }
        }
      }
    }
  } catch {
    result = failedRead();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        result = failedRead();
      }
    }
  }
  return result;
}

/**
 * Fills a buffer from an already-opened file without reading beyond its verified initial size.
 *
 * Inputs: An open handle, expected safe file size, and caller-established maximum byte count.
 * Outputs: A buffer of exactly `expectedSize` bytes, or `undefined` for invalid sizes or short/invalid reads.
 * Does not handle: File/path stability checks, UTF-8 decoding, descriptor closure, or retries.
 * Side effects: Allocates one unsafe buffer and issues positional reads against the supplied open descriptor.
 */
async function readExactBounded(
  handle: BoundedFileHandle,
  expectedSize: number,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) {
    return undefined;
  }
  const buffer = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const read = await handle.read(buffer, offset, expectedSize - offset, offset);
    if (
      !Number.isSafeInteger(read.bytesRead) ||
      read.bytesRead <= 0 ||
      read.bytesRead > expectedSize - offset
    ) {
      return undefined;
    }
    offset += read.bytesRead;
  }

  // The post-read handle/path stat checks in the caller detect growth or a
  // replacement. Do not probe past `expectedSize`: this keeps the byte cap
  // exact even while an input is being modified concurrently.
  return buffer;
}

/**
 * Checks whether a stat value can support a bounded regular-file read.
 *
 * Inputs: The narrowed metadata returned from `stat` or `handle.stat`.
 * Outputs: `true` only for a regular file with a valid nonnegative size and stable identity/version fields.
 * Does not handle: Path containment, permissions, or comparison with another stat result.
 * Side effects: Calls the supplied stat object's type predicate methods.
 */
function isReadableFile(value: BoundedFileStat): boolean {
  return (
    value.isFile() &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    isIdentityPart(value.dev) &&
    isIdentityPart(value.ino) &&
    Number.isFinite(value.mtimeMs) &&
    Number.isFinite(value.ctimeMs)
  );
}

/**
 * Checks whether a stat value can anchor the parent-directory stability proof.
 *
 * Inputs: The narrowed metadata returned from a parent-directory stat.
 * Outputs: `true` only for a directory with valid device, inode, and timestamp identity fields.
 * Does not handle: Recursive parent containment or permission repair.
 * Side effects: Calls the supplied stat object's directory predicate method.
 */
function isReadableDirectory(value: BoundedFileStat): boolean {
  return (
    value.isDirectory() &&
    isIdentityPart(value.dev) &&
    isIdentityPart(value.ino) &&
    Number.isFinite(value.mtimeMs) &&
    Number.isFinite(value.ctimeMs)
  );
}

/**
 * Compares two regular-file stats for device-and-inode identity.
 *
 * Inputs: Two candidate file stat values.
 * Outputs: `true` when both are readable files with identical device and inode values.
 * Does not handle: Size or timestamp version comparison.
 * Side effects: Calls each stat object's file predicate through `isReadableFile`.
 */
function sameStableIdentity(
  left: BoundedFileStat,
  right: BoundedFileStat,
): boolean {
  return (
    isReadableFile(left) &&
    isReadableFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/**
 * Compares two regular-file stats for unchanged identity and content version markers.
 *
 * Inputs: Two candidate file stat values.
 * Outputs: `true` when identity, size, modification time, and change time all match.
 * Does not handle: Content hashing or filesystem guarantees beyond the reported stat fields.
 * Side effects: Calls file type predicates while validating both metadata values.
 */
function sameStableVersion(
  left: BoundedFileStat,
  right: BoundedFileStat,
): boolean {
  return (
    sameStableIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Compares parent-directory stats to detect a directory replacement during a file read.
 *
 * Inputs: The directory metadata observed before and after the descriptor read.
 * Outputs: `true` when both readable directories retain the same device, inode, mtime, and ctime.
 * Does not handle: Ancestor-directory changes or file content comparison.
 * Side effects: Calls directory type predicates while validating both metadata values.
 */
function sameStableDirectoryIdentity(
  left: BoundedFileStat,
  right: BoundedFileStat,
): boolean {
  return (
    isReadableDirectory(left) &&
    isReadableDirectory(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Copies the file fields that form a successful read's private stability identity.
 *
 * Inputs: A previously validated regular-file stat value.
 * Outputs: A frozen object containing size, device, inode, mtime, and ctime.
 * Does not handle: Validation of malformed stat values or future change detection.
 * Side effects: Allocates and freezes a small identity object.
 */
function stableFileIdentity(value: BoundedFileStat): StableFileIdentity {
  return Object.freeze({
    size: value.size,
    dev: value.dev,
    ino: value.ino,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

/**
 * Copies the parent-directory fields retained for later stable-base verification.
 *
 * Inputs: A previously validated directory stat value.
 * Outputs: A frozen object containing device, inode, mtime, and ctime.
 * Does not handle: Validation of malformed stat values or traversal above that directory.
 * Side effects: Allocates and freezes a small identity object.
 */
function stableDirectoryIdentity(value: BoundedFileStat): StableDirectoryIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

/**
 * Recognizes numeric metadata values that can safely participate in identity checks.
 *
 * Inputs: A device or inode value represented as a number or bigint.
 * Outputs: `true` for any bigint or safe-integer number.
 * Does not handle: Positivity, ordering, or cross-platform identity semantics.
 * Side effects: None.
 */
function isIdentityPart(value: number | bigint): boolean {
  return typeof value === "bigint" || Number.isSafeInteger(value);
}

/**
 * Constructs the opaque failure returned for any unstable or unreadable local input.
 *
 * Inputs: None.
 * Outputs: A `BoundedLocalTextReadResult` with `ok: false` and code `read-failed`.
 * Does not handle: Preserving filesystem error details, paths, or partial content.
 * Side effects: Allocates a new small result object.
 */
function failedRead(): BoundedLocalTextReadResult {
  return { ok: false, code: "read-failed" };
}

/**
 * Constructs the opaque failure returned when a verified file exceeds its configured byte cap.
 *
 * Inputs: None.
 * Outputs: A `BoundedLocalTextReadResult` with `ok: false` and code `too-large`.
 * Does not handle: Returning partial file content or disclosing the observed size.
 * Side effects: Allocates a new small result object.
 */
function tooLarge(): BoundedLocalTextReadResult {
  return { ok: false, code: "too-large" };
}
