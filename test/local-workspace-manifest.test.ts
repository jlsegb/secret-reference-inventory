import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLocalWorkspaceManifest } from "../src/app/index.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

test("local workspace manifest reader accepts explicit JSONC without serializing its path", /**
 * Asserts JSONC manifest parsing issues opaque request state without exposing its canonical path.
 *
 * Inputs: The Node test context used to register cleanup.
 * Outputs: A fulfilled promise when request/serialization assertions pass; assertion failure rejects it.
 * Does not handle: Workspace scanning or invalid manifest parsing.
 * Side effects: Creates/writes/removes a temporary manifest file.
 */ async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-manifest-"));
  t.after(/**
   * Removes the temporary valid-manifest directory after the test completes.
   *
   * Inputs: None.
   * Outputs: A promise for recursive removal.
   * Does not handle: Manifest parsing or assertion failures.
   * Side effects: Deletes the temporary directory tree.
   */ () => rm(root, { recursive: true, force: true }));
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
});

test("invalid manifest input yields a fixed error without retaining source text", /**
 * Asserts malformed JSON returns a fixed code and does not serialize the sentinel source text.
 *
 * Inputs: The Node test context used to register cleanup.
 * Outputs: A fulfilled promise when fixed-code and no-retention assertions pass; assertion failure rejects it.
 * Does not handle: Valid JSONC capability issuance.
 * Side effects: Creates/writes/removes a temporary invalid-manifest file.
 */ async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-workspace-invalid-"));
  t.after(/**
   * Removes the temporary invalid-manifest directory after the test completes.
   *
   * Inputs: None.
   * Outputs: A promise for recursive removal.
   * Does not handle: Sentinel redaction assertions.
   * Side effects: Deletes the temporary directory tree.
   */ () => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, "workspace.json");
  await writeFile(manifestPath, "{ " + SENTINEL, "utf8");

  const result = await readLocalWorkspaceManifest(manifestPath);
  assert.deepEqual(result, { ok: false, code: "APP_WORKSPACE_MANIFEST_INVALID" });
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});
