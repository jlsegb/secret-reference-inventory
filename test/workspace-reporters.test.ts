import assert from "node:assert/strict";
import test from "node:test";

import type {
  SafeDiagnosticCode,
  SafeIdentifier,
} from "../src/core/index.js";
import {
  WORKSPACE_REPORT_SCHEMA_VERSION,
  buildWorkspaceJsonReport,
  renderWorkspaceJson,
  renderWorkspaceTerminal,
  type WorkspaceReportingInput,
} from "../src/reporters/index.js";

const id = (value: string): SafeIdentifier => value as SafeIdentifier;
const diagnostic = (value: string): SafeDiagnosticCode => value as SafeDiagnosticCode;

test("workspace reports are deterministic, versioned, and sort independent results", () => {
  const input: WorkspaceReportingInput = {
    repositories: [
      {
        id: id("worker"),
        state: "incomplete",
        diagnostics: [diagnostic("APP_SOURCE_EXTRACTION_INCOMPLETE")],
      },
      { id: id("api"), state: "complete" },
    ],
    deployments: [
      {
        id: id("production"),
        repositoryIds: [id("worker"), id("api")],
        state: "incomplete",
        sharedKeys: [
          { namespace: "env", name: id("DATABASE_URL") },
          { namespace: "env", name: id("API_KEY") },
          { namespace: "env", name: id("DATABASE_URL") },
        ],
        members: [
          { repositoryId: id("worker"), state: "incomplete" },
          { repositoryId: id("api"), state: "complete" },
        ],
      },
    ],
  };

  const first = renderWorkspaceJson(input);
  const second = renderWorkspaceJson(input);
  assert.equal(first, second);

  const report = buildWorkspaceJsonReport(input);
  assert.equal(report.schemaVersion, WORKSPACE_REPORT_SCHEMA_VERSION);
  assert.deepEqual(report.repositories.map((repository) => repository.id), ["api", "worker"]);
  assert.equal(report.summary.incomplete, true);
  assert.deepEqual(report.deployments[0]?.repositoryIds, ["api", "worker"]);
  assert.deepEqual(
    report.deployments[0]?.sharedKeys.map((key) => key.name),
    ["API_KEY", "DATABASE_URL"],
  );
  assert.deepEqual(
    report.deployments[0]?.members.map((member) => member.repositoryId),
    ["api", "worker"],
  );
  assert.equal("report" in (report.deployments[0] ?? {}), false);
  const terminal = renderWorkspaceTerminal(input);
  assert.match(terminal, /    api  complete  groups=0  dynamic=0/u);
  assert.match(terminal, /    worker  incomplete  groups=0  dynamic=0/u);
  assert.match(terminal, /One or more workspace results are incomplete/u);
});

test("workspace reporter rejects contradictory deployment member identities", () => {
  const input: WorkspaceReportingInput = {
    repositories: [],
    deployments: [{
      id: id("production"),
      repositoryIds: [id("api")],
      state: "invalid",
      sharedKeys: [],
      members: [
        { repositoryId: id("api"), state: "invalid" },
        { repositoryId: id("api"), state: "invalid" },
      ],
    }],
  };

  assert.throws(
    () => buildWorkspaceJsonReport(input),
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_DUPLICATE_DEPLOYMENT_MEMBER",
  );
});

test("workspace reporter rejects duplicate declared deployment repository identities", () => {
  const input: WorkspaceReportingInput = {
    repositories: [],
    deployments: [{
      id: id("production"),
      repositoryIds: [id("api"), id("api")],
      state: "invalid",
      sharedKeys: [],
      members: [{ repositoryId: id("api"), state: "invalid" }],
    }],
  };

  assert.throws(
    () => buildWorkspaceJsonReport(input),
    (error: unknown) =>
      error instanceof Error && error.message === "WORKSPACE_REPORT_INVALID_INPUT",
  );
});

test("workspace reporter redacts malformed safe brands instead of serializing a sentinel", () => {
  const sentinel = "sk_live_51Jf2QfZxR3AqVbC8NwY";
  const input: WorkspaceReportingInput = {
    repositories: [{ id: id(sentinel), state: "invalid" }],
    deployments: [],
  };

  const output = renderWorkspaceJson(input);
  assert.equal(output.includes(sentinel), false);
  assert.match(output, /<opaque>/u);
});
