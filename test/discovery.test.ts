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

test("PathGuard uses segment-aware real-path containment", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "secret-usage-guard-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

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

test("discovery is deterministic, ignores excluded paths, and does not serialize raw secret-like paths", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "secret-usage-discovery-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

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
  const displayPaths = result.files.map((file) => file.displayPath);
  const skipCodes = result.skips.map((skip) => String(skip.code));

  assert.deepEqual(displayPaths.slice().sort(), [OPAQUE_PATH, "src/index.ts"]);
  assert.ok(skipCodes.includes("IGNORED"));
  assert.ok(skipCodes.includes("EXCLUDED_DIRECTORY"));
  assert.ok(skipCodes.includes("GENERATED"));
  assert.ok(skipCodes.includes("SYMLINK"));
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test("discovery marks an exhausted budget instead of silently truncating source coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-usage-budget-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.ts"), "export {};\n");
  await writeFile(join(root, "second.ts"), "export {};\n");

  const result = await discoverSources({ roots: [root], budget: { maxFiles: 1 } });
  assert.equal(result.files.length, 1);
  assert.equal(result.budgetExhausted, true);
  assert.ok(result.skips.some((skip) => String(skip.code) === "BUDGET_EXCEEDED"));
});
