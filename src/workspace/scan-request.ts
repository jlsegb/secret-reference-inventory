import { stat } from "node:fs/promises";

import {
  verifiedBoundedReadContext,
  type VerifiedBoundedReadContext,
} from "../app/bounded-local-file.js";

import type { WorkspaceManifestToken } from "./contracts.js";
import {
  isIssuedWorkspaceManifestToken,
} from "./manifest-token.js";
import { parseWorkspaceManifestText } from "./parser.js";
import type { WorkspaceScanRequest } from "./types.js";

/**
 * Private request provenance. It is intentionally absent from the public
 * workspace barrel: only the local manifest reader can turn a verified,
 * bounded read into a scan capability.
 */
export interface WorkspaceScanRequestContext {
  readonly manifest: WorkspaceManifestToken;
  readonly verifiedRead: VerifiedBoundedReadContext;
}

export type VerifiedWorkspaceManifestParseResult =
  | {
      readonly ok: true;
      readonly manifest: WorkspaceManifestToken;
      readonly request: WorkspaceScanRequest;
    }
  | {
      readonly ok: false;
      readonly code: "read-invalid" | "manifest-invalid";
    };

const ISSUED_SCAN_REQUESTS = new WeakMap<object, WorkspaceScanRequestContext>();

/**
 * Parse exactly the bytes represented by an identity-backed bounded-read
 * result, then issue a scan request bound to that same read's file and base.
 * The initial WeakMap lookup deliberately happens before any property read.
 */
export function parseVerifiedWorkspaceManifestRead(
  input: unknown,
): VerifiedWorkspaceManifestParseResult {
  const verifiedRead = verifiedBoundedReadContext(input);
  if (verifiedRead === undefined) {
    return { ok: false, code: "read-invalid" };
  }

  const parsed = parseWorkspaceManifestText(verifiedRead.text);
  if (parsed.ok === false || !isIssuedWorkspaceManifestToken(parsed.value)) {
    return { ok: false, code: "manifest-invalid" };
  }

  // A null-prototype object has no enumerable data, so JSON/stringification
  // cannot expose the parser token, canonical manifest path, or base path.
  const request = Object.freeze(
    Object.create(null),
  ) as unknown as WorkspaceScanRequest;
  ISSUED_SCAN_REQUESTS.set(
    request as unknown as object,
    Object.freeze({ manifest: parsed.value, verifiedRead }),
  );
  return Object.freeze({ ok: true, manifest: parsed.value, request });
}

/**
 * Identity-only request lookup for the runtime. It does not reflect on or
 * dereference a caller-provided object, including a hostile Proxy.
 */
export function workspaceScanRequestContext(
  input: unknown,
): WorkspaceScanRequestContext | undefined {
  return input !== null && typeof input === "object"
    ? ISSUED_SCAN_REQUESTS.get(input as object)
    : undefined;
}

/**
 * Revalidate the exact manifest file and its canonical parent without
 * realpath-ing a caller path. This fails closed if either identity changed
 * since the bounded read that issued the request.
 */
export async function verifyWorkspaceScanRequestContext(
  context: WorkspaceScanRequestContext,
): Promise<boolean> {
  try {
    const [file, base] = await Promise.all([
      stat(context.verifiedRead.canonicalPath),
      stat(context.verifiedRead.canonicalBase),
    ]);
    const expectedFile = context.verifiedRead.fileIdentity;
    const expectedBase = context.verifiedRead.baseIdentity;
    return (
      file.isFile() &&
      file.size === expectedFile.size &&
      file.dev === expectedFile.dev &&
      file.ino === expectedFile.ino &&
      file.mtimeMs === expectedFile.mtimeMs &&
      file.ctimeMs === expectedFile.ctimeMs &&
      base.isDirectory() &&
      base.dev === expectedBase.dev &&
      base.ino === expectedBase.ino &&
      base.mtimeMs === expectedBase.mtimeMs &&
      base.ctimeMs === expectedBase.ctimeMs
    );
  } catch {
    return false;
  }
}
