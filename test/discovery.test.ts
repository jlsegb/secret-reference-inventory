import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  PathGuard,
  discoverSources,
} from "../src/discovery/index.js";
import { OPAQUE_PATH, SafeFactFactory } from "../src/safety/index.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

test("PathGuard uses segment-aware real-path containment", /**
 * Exercises real-path containment so sibling prefix paths cannot escape an approved root.
 *
 * Inputs: The node:test context used to register cleanup.
 * Outputs: A fulfilled async test after inside and sibling paths receive opposite guard results.
 * Does not handle: Symlink containment, source discovery, or filesystem permission failures.
 * Side effects: Creates and removes a temporary workspace and files.
 */ async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "secret-usage-guard-"));
  t.after(/**
   * Deletes the temporary containment workspace after the test completes.
   *
   * Inputs: None; closes over the created temporary workspace path.
   * Outputs: A promise resolving after best-effort recursive removal.
   * Does not handle: Reporting cleanup failures or preserving fixture artifacts.
   * Side effects: Removes the temporary directory from the local filesystem.
   */ async () => rm(workspace, { recursive: true, force: true }));

  const app = join(workspace, "app");
  const appOld = join(workspace, "app-old");
  await mkdir(app);
  await mkdir(appOld);
  await writeFile(join(app, "index.ts"), "export {};\n");
  await writeFile(join(appOld, "outside.ts"), "export {};\n");

  const guard = await PathGuard.create([app], new SafeFactFactory());
  assert.notEqual(await guard.resolveExisting(join(app, "index.ts")), undefined);
  assert.equal(await guard.resolveExisting(join(appOld, "outside.ts")), undefined);
});

test("discovery is deterministic, ignores excluded paths, and does not serialize raw secret-like paths", /**
 * Exercises source traversal exclusion and privacy handling against a mixed temporary tree.
 *
 * Inputs: The node:test context used to register cleanup.
 * Outputs: A fulfilled async test after asserting safe paths and expected skip codes.
 * Does not handle: Parser extraction, provisioning adapters, or all ignore-pattern forms.
 * Side effects: Creates files, directories, and a symlink, then schedules workspace removal.
 */ async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "secret-usage-discovery-"));
  t.after(/**
   * Removes the mixed traversal fixture after privacy assertions finish.
   *
   * Inputs: None; closes over the temporary workspace path.
   * Outputs: A promise for forced recursive removal.
   * Does not handle: Preserving debugging artifacts or surfacing cleanup errors.
   * Side effects: Deletes test-created filesystem content.
   */ async () => rm(workspace, { recursive: true, force: true }));

  const root = join(workspace, "app");
  const outside = join(workspace, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(join(root, "src", "index.ts"), "export const value = process.env.DATABASE_URL;\n");
  await writeFile(join(root, "ignored.ts"), "export {};\n");
  await writeFile(join(root, "node_modules", "pkg", "index.ts"), "export {};\n");
  await writeFile(join(root, "src", "generated.min.js"), "minified");
  await writeFile(join(root, "src", `${SENTINEL}.ts`), "export {};\n");
  await writeFile(join(outside, "outside.ts"), "export {};\n");
  await symlink(join(outside, "outside.ts"), join(root, "src", "outside-link.ts"));

  const result = await discoverSources({ roots: [root] });
  const displayPaths = result.files.map(/**
   * Extracts the reportable display path from one discovered source file.
   *
   * Inputs: One discovered source descriptor.
   * Outputs: Its SafePath display value.
   * Does not handle: Canonical-path inspection or path sanitization.
   * Side effects: None.
   */ (file) => file.displayPath);
  const skipCodes = result.skips.map(/**
   * Converts one branded skip code to plain text for assertion membership.
   *
   * Inputs: One discovery skip descriptor.
   * Outputs: Its code's string form.
   * Does not handle: Skip-path inspection or code validation.
   * Side effects: None.
   */ (skip) => String(skip.code));

  assert.deepEqual(displayPaths.slice().sort(), [OPAQUE_PATH, "src/index.ts"]);
  assert.ok(skipCodes.includes("IGNORED"));
  assert.ok(skipCodes.includes("EXCLUDED_DIRECTORY"));
  assert.ok(skipCodes.includes("GENERATED"));
  assert.ok(skipCodes.includes("SYMLINK"));
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("discovery marks an exhausted budget instead of silently truncating source coverage", /**
 * Verifies that a file-count budget produces explicit incomplete-coverage state.
 *
 * Inputs: The node:test context used to register cleanup.
 * Outputs: A fulfilled async test after asserting one file, exhaustion, and a budget skip.
 * Does not handle: Byte, depth, or parser-budget boundaries.
 * Side effects: Creates and removes a temporary directory with two source files.
 */ async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-budget-"));
  t.after(/**
   * Deletes the budget test fixture after the test resolves.
   *
   * Inputs: None; closes over the temporary root.
   * Outputs: A forced recursive-removal promise.
   * Does not handle: Cleanup-error reporting or fixture retention.
   * Side effects: Removes the temporary directory.
   */ async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.ts"), "export {};\n");
  await writeFile(join(root, "second.ts"), "export {};\n");

  const result = await discoverSources({ roots: [root], budget: { maxFiles: 1 } });
  assert.equal(result.files.length, 1);
  assert.equal(result.budgetExhausted, true);
  assert.ok(result.skips.some(/**
   * Finds the explicit budget-exhaustion skip among recorded traversal skips.
   *
   * Inputs: One discovery skip descriptor.
   * Outputs: True when its code is BUDGET_EXCEEDED.
   * Does not handle: Counting skipped files or evaluating other incomplete states.
   * Side effects: None.
   */ (skip) => String(skip.code) === "BUDGET_EXCEEDED"));
});
