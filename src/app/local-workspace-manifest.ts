import {
  type WorkspaceManifestToken,
} from "../workspace/index.js";
import {
  parseVerifiedWorkspaceManifestRead,
} from "../workspace/scan-request.js";
import type { WorkspaceScanRequest } from "../workspace/types.js";

import { readBoundedLocalText } from "./bounded-local-file.js";
import type { LocalWorkspaceManifestReadFailure } from "./types.js";

const MAX_WORKSPACE_MANIFEST_BYTES = 1024 * 1024;

export interface LocalWorkspaceManifestDocument {
  readonly ok: true;
  readonly manifest: WorkspaceManifestToken;
  /** Opaque request tied to the exact bounded read and canonical base. */
  readonly request: WorkspaceScanRequest;
}

export type LocalWorkspaceManifestReadResult =
  | LocalWorkspaceManifestDocument
  | LocalWorkspaceManifestReadFailure;

/**
 * Reads only the explicit local manifest selected by the CLI. JSONC parsing is
 * data-only and parser failures are represented by fixed codes.
 */
export async function readLocalWorkspaceManifest(
  path: string,
): Promise<LocalWorkspaceManifestReadResult> {
  const read = await readBoundedLocalText(path, MAX_WORKSPACE_MANIFEST_BYTES);
  if (!read.ok) {
    return {
      ok: false,
      code: read.code === "too-large"
        ? "APP_WORKSPACE_MANIFEST_TOO_LARGE"
        : "APP_WORKSPACE_MANIFEST_READ_FAILED",
    };
  }

  const parsed = parseVerifiedWorkspaceManifestRead(read);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code === "read-invalid"
        ? "APP_WORKSPACE_MANIFEST_READ_FAILED"
        : "APP_WORKSPACE_MANIFEST_INVALID",
    };
  }

  return Object.freeze({
    ok: true as const,
    manifest: parsed.manifest,
    request: parsed.request,
  });
}
