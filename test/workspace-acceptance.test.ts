import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import { createLocalCliHandlers } from "../src/app/index.js";
import { runCli } from "../src/cli/index.js";
import type { WorkspaceJsonReport } from "../src/reporters/index.js";
import {
  startLocalReportViewer,
  type LocalReportViewer,
} from "../src/viewer/index.js";

import {
  withWorkspaceFixture,
  writeFixtureLayout,
  type WorkspaceFixture,
} from "./helpers/workspace-fixture.js";

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runWorkspaceCli(
  args: readonly string[],
  options: Parameters<typeof createLocalCliHandlers>[0] = {},
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runCli(args, createLocalCliHandlers(options), {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

function parseWorkspaceReport(run: CliRun): WorkspaceJsonReport {
  return JSON.parse(run.stdout) as WorkspaceJsonReport;
}

function findRepository(report: WorkspaceJsonReport, id: string) {
  const entry = report.repositories.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected repository " + id);
  return entry;
}

function findDeployment(report: WorkspaceJsonReport, id: string) {
  const entry = report.deployments.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, "expected deployment " + id);
  return entry;
}

function assertNoFixtureLeak(text: string, fixture: WorkspaceFixture): void {
  assert.equal(text.includes(fixture.root), false);
  assert.equal(text.includes(fixture.manifestPath), false);
  assert.equal(text.includes(fixture.privateSourceMarker), false);
}

test("workspace CLI keeps duplicate keys separate until deployment sharing is explicit", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const unrelated = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "json",
      "--require-complete",
    ]);
    assert.equal(unrelated.status, 2);
    assert.equal(unrelated.stderr, "");
    assertNoFixtureLeak(unrelated.stdout, fixture);

    const unrelatedReport = parseWorkspaceReport(unrelated);
    assert.equal(findRepository(unrelatedReport, "api")?.state, "complete");
    assert.equal(findRepository(unrelatedReport, "worker")?.state, "complete");
    assert.equal(findRepository(unrelatedReport, "broken")?.state, "incomplete");
    assert.equal(findDeployment(unrelatedReport, "api-production")?.state, "complete");
    assert.equal(findDeployment(unrelatedReport, "broken-production")?.state, "incomplete");
    assert.deepEqual(findDeployment(unrelatedReport, "api-production")?.sharedKeys, []);
    assert.deepEqual(findDeployment(unrelatedReport, "worker-production")?.sharedKeys, []);

    const dynamic = findRepository(unrelatedReport, "dynamic");
    assert.equal(dynamic?.state, "incomplete");
    assert.equal(dynamic?.report?.dynamicLookups.length, 1);
    assert.equal(dynamic?.report?.dynamicLookups[0]?.domain.kind, "unbounded");
    assert.equal(dynamic?.report?.dynamicLookups[0]?.domain.reason, "user-controlled");
    assert.deepEqual(dynamic?.report?.dynamicLookups[0]?.likelyKeys, []);
    assert.equal(unrelated.stdout.includes("query.key"), false);

    await writeFixtureLayout(fixture, "shared");
    const shared = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "json",
    ]);
    assert.equal(shared.status, 0);
    assert.equal(shared.stderr, "");
    assertNoFixtureLeak(shared.stdout, fixture);

    const sharedDeployment = findDeployment(parseWorkspaceReport(shared), "shared-production");
    assert.deepEqual(sharedDeployment?.repositoryIds, ["api", "worker"]);
    assert.deepEqual(
      sharedDeployment?.members.map((member) => member.repositoryId),
      ["api", "worker"],
    );
    assert.equal("report" in (sharedDeployment ?? {}), false);
    assert.deepEqual(sharedDeployment?.sharedKeys, [
      { namespace: "env", name: "DATABASE_URL" },
    ]);

    const terminal = await runWorkspaceCli([
      "workspace",
      "scan",
      "--manifest",
      fixture.manifestPath,
      "--format",
      "terminal",
    ]);
    assert.equal(terminal.status, 0);
    assert.match(terminal.stdout, /Workspace secret reference inventory/u);
    assertNoFixtureLeak(terminal.stdout, fixture);
  });
});

test("workspace UI serves only derived fixture data over loopback", async (t) => {
  await withWorkspaceFixture(async (fixture) => {
    const launched: LocalReportViewer[] = [];
    t.after(async () => {
      await Promise.all(launched.map((viewer) => viewer.close()));
    });

    const run = await runWorkspaceCli(
      ["ui", "--manifest", fixture.manifestPath, "--port", "0"],
      {
        startViewer: async (request) => {
          const viewer = await startLocalReportViewer(request);
          launched.push(viewer);
          return viewer;
        },
      },
    );

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assertNoFixtureLeak(run.stdout, fixture);
    const url = new URL(run.stdout.trim());
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.notEqual(url.port, "");

    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(typeof response.headers["content-security-policy"], "string");
    assert.match(String(response.headers["content-security-policy"]), /connect-src 'none'/u);
    assert.match(response.body, /aria-label="Repositories"/u);
    assert.match(response.body, /"label":"api"/u);
    assert.doesNotMatch(response.body, /https?:\/\//u);
    assertNoFixtureLeak(response.body, fixture);
  });
});

async function request(url: URL): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
