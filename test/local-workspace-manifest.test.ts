import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLocalWorkspaceManifest } from "../src/app/index.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

test("local workspace manifest reader accepts explicit JSONC without serializing its path",
  /**
   * Creates one explicit JSONC manifest on disk and verifies the local-reader's safe success boundary.
   *
   * Inputs: The Node test context; allocates a temporary root and writes a v2 manifest containing one `api` repository and no deployments.
   * Outputs: Resolves after the read succeeds with `api`, exposes no enumerable canonical path, returns a null-prototype opaque request, and serializes without the temporary root.
   * Does not handle: Provisioning reads, workspace scanning, retaining the temporary directory, or recovery from filesystem/parser/assertion failure.
   * Side effects: Creates/writes a temp JSONC file and registers recursive root removal with `t.after`.
   */
  async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-manifest-"));
  t.after(
    /**
     * Recursively removes the test-owned JSONC reader fixture root after the test settles.
     *
     * Inputs: No arguments; closes over the temporary `root` created by the enclosing callback.
     * Outputs: The `rm` promise used by the Node cleanup hook.
     * Does not handle: Removing paths outside `root`, preserving failures for debugging, or changing the reader result.
     * Side effects: Deletes the fixture directory with `recursive` and `force`; cleanup rejection propagates through the test hook.
     */
    () => rm(root, { recursive: true, force: true }),
  );
  const manifestPath = join(root, "workspace.jsonc");
  await writeFile(
    manifestPath,
    [
      "{",
      "  // Explicit, non-executable repository map",
      '  "schemaVersion": "workspace-manifest/v2",',
      '  "repositories": [{ "id": "api", "root": "repositories/api" }],',
      '  "deployments": [],',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await readLocalWorkspaceManifest(manifestPath);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.manifest.repositories[0]?.id, "api");
    assert.equal("canonicalPath" in result, false);
    assert.equal(Object.getPrototypeOf(result.request), null);
    assert.equal(JSON.stringify(result.request), "{}");
    assert.equal(JSON.stringify(result).includes(root), false);
  }
  },
);

test("invalid manifest input yields a fixed error without retaining source text",
  /**
   * Writes malformed manifest text carrying a credential-shaped sentinel and verifies the reader's fixed nonleaking failure.
   *
   * Inputs: The Node test context; allocates a temporary root and writes `{ ` plus `SENTINEL` to `workspace.json`.
   * Outputs: Resolves after `readLocalWorkspaceManifest` returns exactly `APP_WORKSPACE_MANIFEST_INVALID` and serialized output omits the sentinel.
   * Does not handle: JSON recovery, source redaction beyond the returned error, scanning, or recovery from I/O/assertion failure.
   * Side effects: Creates/writes a temporary malformed file and registers recursive root cleanup with `t.after`.
   */
  async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-invalid-"));
  t.after(
    /**
     * Deletes the temporary malformed-manifest fixture after its nonleak assertions finish.
     *
     * Inputs: No arguments; closes over the enclosing callback's `root`.
     * Outputs: The recursive forced-removal promise consumed by `t.after`.
     * Does not handle: Recovering source text, deleting unrelated files, or changing assertion outcomes.
     * Side effects: Removes the test-owned directory; a cleanup failure propagates through Node's cleanup handling.
     */
    () => rm(root, { recursive: true, force: true }),
  );
  const manifestPath = join(root, "workspace.json");
  await writeFile(manifestPath, "{ " + SENTINEL, "utf8");

  const result = await readLocalWorkspaceManifest(manifestPath);
  assert.deepEqual(result, { ok: false, code: "APP_WORKSPACE_MANIFEST_INVALID" });
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  },
);
