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
 * Internal capability lookup. Membership is checked without reading any
 * caller-controlled properties, so cloned or forged result objects fail
 * closed without invoking Proxy traps.
 */
export function verifiedBoundedReadContext(
  input: unknown,
): VerifiedBoundedReadContext | undefined {
  return input !== null && typeof input === "object"
    ? VERIFIED_READS.get(input as object)
    : undefined;
}

const nodeOperations: BoundedLocalFileOperations = {
  realpath: (path) => realpath(path),
  stat: async (path) => stat(path),
  open: async (path, flags) => open(path, flags) as unknown as BoundedFileHandle,
};

/**
 * Opens a user-selected local file once, reads no more than `maxBytes`, and
 * rejects a result if the opened file or the canonical path changes while it
 * is being read. No filesystem error, path, or source text escapes this
 * boundary.
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

function isReadableDirectory(value: BoundedFileStat): boolean {
  return (
    value.isDirectory() &&
    isIdentityPart(value.dev) &&
    isIdentityPart(value.ino) &&
    Number.isFinite(value.mtimeMs) &&
    Number.isFinite(value.ctimeMs)
  );
}

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

function stableFileIdentity(value: BoundedFileStat): StableFileIdentity {
  return Object.freeze({
    size: value.size,
    dev: value.dev,
    ino: value.ino,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

function stableDirectoryIdentity(value: BoundedFileStat): StableDirectoryIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

function isIdentityPart(value: number | bigint): boolean {
  return typeof value === "bigint" || Number.isSafeInteger(value);
}

function failedRead(): BoundedLocalTextReadResult {
  return { ok: false, code: "read-failed" };
}

function tooLarge(): BoundedLocalTextReadResult {
  return { ok: false, code: "too-large" };
}
