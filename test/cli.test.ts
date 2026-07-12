import assert from "node:assert/strict";
import test from "node:test";

import { parseCli, runCli } from "../src/cli/index.js";

const SENTINEL = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";

test("CLI parses documented scan, reconcile, workspace, and UI command shapes", () => {
  const scan = parseCli(["scan", ".", "--format", "json", "--require-complete"]);
  assert.equal(scan.ok, true);
  if (scan.ok && scan.command.kind === "scan") {
    assert.equal(scan.command.root, ".");
    assert.equal(scan.command.format, "json");
    assert.equal(scan.command.requireComplete, true);
  }

  const reconcile = parseCli([
    "reconcile",
    "--root",
    ".",
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
  ]);
  assert.equal(reconcile.ok, true);
  if (reconcile.ok && reconcile.command.kind === "reconcile") {
    assert.equal(reconcile.command.root, ".");
    assert.equal(reconcile.command.inventory, "inventory.json");
  }

  const workspace = parseCli([
    "workspace",
    "scan",
    "--manifest",
    "workspace.jsonc",
    "--format",
    "json",
    "--require-complete",
  ]);
  assert.equal(workspace.ok, true);
  if (workspace.ok && workspace.command.kind === "workspace-scan") {
    assert.equal(workspace.command.manifest, "workspace.jsonc");
    assert.equal(workspace.command.format, "json");
    assert.equal(workspace.command.requireComplete, true);
  }

  const ui = parseCli(["ui", "--manifest", "workspace.jsonc", "--port", "0"]);
  assert.equal(ui.ok, true);
  if (ui.ok && ui.command.kind === "ui") {
    assert.equal(ui.command.manifest, "workspace.jsonc");
    assert.equal(ui.command.port, 0);
  }
});

test("CLI rejects conflicting input sources without echoing untrusted input", async () => {
  const parsed = parseCli([
    "reconcile",
    "--root",
    ".",
    "--scan-report",
    SENTINEL,
    "--inventory",
    "inventory.json",
    "--bindings",
    "bindings.json",
  ]);
  assert.equal(parsed.ok, false);

  const stderr: string[] = [];
  const status = await runCli(["unknown", SENTINEL], {}, {
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
  });
  assert.equal(status, 64);
  assert.equal(stderr.join("").includes(SENTINEL), false);
});

test("CLI shell delegates only to injected local handlers", async () => {
  let seen = false;
  const status = await runCli(
    ["scan", "."],
    {
      scan: (command) => {
        seen = command.root === ".";
        return 17;
      },
    },
    { stdout: () => undefined, stderr: () => undefined },
  );

  assert.equal(seen, true);
  assert.equal(status, 17);
});

test("workspace command rejects unsupported report formats and unsafe UI ports", () => {
  const sarif = parseCli([
    "workspace",
    "scan",
    "--manifest",
    "workspace.json",
    "--format",
    "sarif",
  ]);
  assert.equal(sarif.ok, false);

  const ui = parseCli(["ui", "--manifest", "workspace.json", "--port", "65536"]);
  assert.equal(ui.ok, false);
});
