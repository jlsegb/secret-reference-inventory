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
 * Parses one verified bounded manifest read and issues a request tied to that exact file and base snapshot.
 *
 * Inputs: A bounded-read capability issued by the local manifest reader.
 * Outputs: An issued manifest token and opaque scan request, or read-invalid/manifest-invalid without source paths or text.
 * Does not handle: Arbitrary strings or copied bounded-read results, later filesystem changes, or recovery from an invalid manifest; malformed manifest text is reported as `manifest-invalid`.
 * Side effects: Parses the retained manifest text and registers an opaque request context in a private WeakMap.
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
 * Looks up the private context for an issued scan request without dereferencing caller input.
 *
 * Inputs: Any candidate request value, including a hostile Proxy.
 * Outputs: Its trusted manifest/read context, or undefined for any unissued identity.
 * Does not handle: Request-shape validation, manifest parsing, or capability forgery.
 * Side effects: None; only the private WeakMap is consulted.
 */
export function workspaceScanRequestContext(
  input: unknown,
): WorkspaceScanRequestContext | undefined {
  return input !== null && typeof input === "object"
    ? ISSUED_SCAN_REQUESTS.get(input as object)
    : undefined;
}

/**
 * Revalidates the manifest file and canonical parent captured when a request was issued.
 *
 * Inputs: A trusted request context containing canonical paths and prior file/directory stat identities.
 * Outputs: True only when both still exist with the recorded file type, device, inode, size, mtime, and ctime.
 * Does not handle: Re-reading manifest text, repairing renamed paths, symlink re-resolution, content hashing, or closing the time-of-check/time-of-use window before later repository-root and provisioning reads; matching stat fields are not a proof of immutable filesystem identity/version semantics.
 * Side effects: Performs asynchronous filesystem stat calls; all I/O or identity failures become false.
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
