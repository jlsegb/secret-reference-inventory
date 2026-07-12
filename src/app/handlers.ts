import { realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  CliHandlers,
  CliIo,
  ExplainCommand,
  OutputFormat,
  ReconcileCommand,
  ScanCommand,
  UiCommand,
  WorkspaceScanCommand,
} from "../cli/types.js";
import {
  buildWorkspaceJsonReport,
  renderJson,
  renderSarif,
  renderTerminal,
  renderWorkspaceJson,
  renderWorkspaceTerminal,
} from "../reporters/index.js";
import {
  startLocalReportViewer,
  type LocalReportViewer,
  type LocalReportViewerRequest,
} from "../viewer/index.js";
import { isViewerRequestLimitError } from "../viewer/internal.js";
import {
  createLocalWorkspaceScanPort,
} from "../workspace/index.js";
import type { InternalPath } from "../discovery/index.js";

import { reconcileLocalRoot, scanLocalRoot } from "./analysis.js";
import { explainRenderedJsonReport } from "./explain.js";
import { readLocalJson } from "./local-json.js";
import { readLocalWorkspaceManifest } from "./local-workspace-manifest.js";
import { AppError, type LocalAnalysis } from "./types.js";
import type {
  WorkspaceScanPort,
  WorkspaceScanReportSource,
} from "./workspace-port.js";
import { workspaceScanToReportingInput } from "./workspace-reporting.js";
import { workspaceReportToViewerRequest } from "./workspace-view-model.js";

export interface LocalCliHandlerOptions {
  /**
   * Tests or alternate local composition roots may override N3's default
   * local-only orchestration port.
   */
  readonly workspaceScan?: WorkspaceScanPort<WorkspaceScanReportSource>;
  /** Test seam; production uses the loopback-only viewer implementation. */
  readonly startViewer?: (
    request: LocalReportViewerRequest,
  ) => Promise<LocalReportViewer>;
}

export function createLocalCliHandlers(
  options: LocalCliHandlerOptions = {},
): CliHandlers {
  const workspaceScan = options.workspaceScan ?? createLocalWorkspaceScanPort();
  return {
    scan: (command, io) => handleScan(command, io),
    reconcile: (command, io) => handleReconcile(command, io),
    explain: (command, io) => handleExplain(command, io),
    "workspace-scan": (command, io) =>
      handleWorkspaceScan(command, io, workspaceScan),
    ui: (command, io) =>
      handleUi(command, io, workspaceScan, options.startViewer ?? startLocalReportViewer),
  };
}

async function handleScan(command: ScanCommand, io: CliIo): Promise<number> {
  try {
    const analysis = await scanLocalRoot(command.root);
    await emitAnalysis(command.format, command.out, analysis, io);
    return command.requireComplete && analysisIsIncomplete(analysis) ? 2 : 0;
  } catch (error) {
    return emitAppError(error, io);
  }
}

async function handleReconcile(command: ReconcileCommand, io: CliIo): Promise<number> {
  if (command.scanReport !== undefined) {
    io.stderr("APP_SCAN_REPORT_REHYDRATION_UNSUPPORTED\n");
    return 64;
  }
  if (command.root === undefined) {
    io.stderr("APP_SCAN_REPORT_REHYDRATION_UNSUPPORTED\n");
    return 64;
  }

  const verificationBase = command.closedModel === undefined
    ? undefined
    : await resolveClosedModelVerificationBase(command.verificationBase);
  if (
    (command.closedModel !== undefined && verificationBase === undefined) ||
    (command.closedModel === undefined && command.verificationBase !== undefined)
  ) {
    io.stderr("APP_CLOSED_MODEL_VERIFICATION_BASE_INVALID\n");
    return 65;
  }

  try {
    const bindings = await readLocalJson(command.bindings);
    const inventory = await readLocalJson(command.inventory);
    const closedModel = command.closedModel === undefined
      ? undefined
      : await readLocalJson(command.closedModel);
    const analysis = await reconcileLocalRoot(command.root, {
      bindings,
      inventory,
      ...(closedModel === undefined ? {} : { closedModel }),
      ...(verificationBase === undefined ? {} : { verificationBase }),
    });
    await emitAnalysis(command.format, command.out, analysis, io);
    return command.requireComplete && analysisIsIncomplete(analysis) ? 2 : 0;
  } catch (error) {
    return emitAppError(error, io);
  }
}

async function handleExplain(command: ExplainCommand, io: CliIo): Promise<number> {
  if (command.scanReport === undefined) {
    io.stderr("APP_EXPLAIN_REQUIRES_SCAN_REPORT\n");
    return 64;
  }
  try {
    const report = await readLocalJson(command.scanReport);
    if (!report.ok) {
      io.stderr(`${report.code}\n`);
      return 65;
    }
    const rendered = explainRenderedJsonReport(command, report.value);
    await emitText(command.out, rendered, io);
    return 0;
  } catch (error) {
    return emitAppError(error, io);
  }
}

async function handleWorkspaceScan(
  command: WorkspaceScanCommand,
  io: CliIo,
  workspaceScan: WorkspaceScanPort<WorkspaceScanReportSource> | undefined,
): Promise<number> {
  const scanned = await scanWorkspaceManifest(command.manifest, workspaceScan);
  if (!scanned.ok) {
    io.stderr(scanned.code + "\n");
    return scanned.status;
  }

  try {
    const reporting = workspaceScanToReportingInput(scanned.value);
    const report = buildWorkspaceJsonReport(reporting);
    await emitText(
      command.out,
      command.format === "json"
        ? renderWorkspaceJson(reporting)
        : renderWorkspaceTerminal(reporting),
      io,
    );
    return workspaceExitStatus(report, command.requireComplete);
  } catch (error) {
    return emitWorkspaceError(error, io);
  }
}

async function handleUi(
  command: UiCommand,
  io: CliIo,
  workspaceScan: WorkspaceScanPort<WorkspaceScanReportSource> | undefined,
  startViewer: (request: LocalReportViewerRequest) => Promise<LocalReportViewer>,
): Promise<number> {
  const scanned = await scanWorkspaceManifest(command.manifest, workspaceScan);
  if (!scanned.ok) {
    io.stderr(scanned.code + "\n");
    return scanned.status;
  }

  try {
    const reporting = workspaceScanToReportingInput(scanned.value);
    const report = buildWorkspaceJsonReport(reporting);
    const status = workspaceExitStatus(report, command.requireComplete);
    if (status !== 0) {
      return status;
    }
    const request = workspaceReportToViewerRequest(report, command.port);
    let viewer: LocalReportViewer | undefined;
    try {
      viewer = await startViewer(request);
      io.stdout(viewer.url.href + "\n");
      return 0;
    } catch (error) {
      if (viewer !== undefined) {
        try {
          await viewer.close();
        } catch {
          // Preserve the fixed viewer failure signal below.
        }
      }
      throw error;
    }
  } catch (error) {
    if (isViewerLimitError(error)) {
      io.stderr("APP_WORKSPACE_VIEWER_LIMIT_EXCEEDED\n");
      return 70;
    }
    io.stderr("APP_WORKSPACE_VIEWER_FAILED\n");
    return 70;
  }
}

interface WorkspaceScanSuccess {
  readonly ok: true;
  readonly value: WorkspaceScanReportSource;
}

interface WorkspaceScanFailure {
  readonly ok: false;
  readonly code:
    | "APP_WORKSPACE_MANIFEST_READ_FAILED"
    | "APP_WORKSPACE_MANIFEST_TOO_LARGE"
    | "APP_WORKSPACE_MANIFEST_INVALID"
    | "APP_WORKSPACE_RUNTIME_UNAVAILABLE"
    | "APP_WORKSPACE_RUNTIME_FAILED";
  readonly status: 65 | 70;
}

type WorkspaceScanAttempt = WorkspaceScanSuccess | WorkspaceScanFailure;

async function scanWorkspaceManifest(
  manifestPath: string,
  workspaceScan: WorkspaceScanPort<WorkspaceScanReportSource> | undefined,
): Promise<WorkspaceScanAttempt> {
  const manifest = await readLocalWorkspaceManifest(manifestPath);
  if (!manifest.ok) {
    return { ok: false, code: manifest.code, status: 65 };
  }
  if (workspaceScan === undefined) {
    return { ok: false, code: "APP_WORKSPACE_RUNTIME_UNAVAILABLE", status: 70 };
  }
  try {
    return {
      ok: true,
      value: await workspaceScan.scan(manifest.request),
    };
  } catch {
    return { ok: false, code: "APP_WORKSPACE_RUNTIME_FAILED", status: 70 };
  }
}

/**
 * A standalone closed model gets no implicit CWD authority. The explicit
 * argument is canonicalized once here and supplied only as an internal base
 * for containment checks in reconciliation.
 */
async function resolveClosedModelVerificationBase(
  input: string | undefined,
): Promise<InternalPath | undefined> {
  if (input === undefined || !isAbsolute(input)) {
    return undefined;
  }
  try {
    const canonicalBase = await realpath(input);
    const metadata = await stat(canonicalBase);
    return metadata.isDirectory() ? canonicalBase as InternalPath : undefined;
  } catch {
    return undefined;
  }
}

function isViewerLimitError(error: unknown): boolean {
  return isViewerRequestLimitError(error);
}

function workspaceExitStatus(
  report: ReturnType<typeof buildWorkspaceJsonReport>,
  requireComplete: boolean,
): number {
  const invalid =
    report.repositories.some((repository) => repository.state === "invalid") ||
    report.deployments.some((deployment) => deployment.state === "invalid");
  if (invalid) {
    return 2;
  }
  return requireComplete && report.summary.incomplete ? 2 : 0;
}

function emitWorkspaceError(error: unknown, io: CliIo): number {
  if (error instanceof AppError) {
    io.stderr(error.code + "\n");
    return 70;
  }
  io.stderr("APP_WORKSPACE_RUNTIME_FAILED\n");
  return 70;
}

async function emitAnalysis(
  format: OutputFormat,
  outputPath: string | undefined,
  analysis: LocalAnalysis,
  io: CliIo,
): Promise<void> {
  const rendered = renderForFormat(format, analysis);
  await emitText(outputPath, rendered, io);
}

function renderForFormat(format: OutputFormat, analysis: LocalAnalysis): string {
  switch (format) {
    case "terminal":
      return renderTerminal(analysis.reportingInput);
    case "json":
      return renderJson(analysis.reportingInput);
    case "sarif":
      return renderSarif(analysis.reportingInput);
  }
}

async function emitText(outputPath: string | undefined, text: string, io: CliIo): Promise<void> {
  if (outputPath === undefined) {
    io.stdout(text);
    return;
  }
  try {
    await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
  } catch {
    throw new AppError("APP_OUTPUT_WRITE_FAILED");
  }
}

function analysisIsIncomplete(analysis: LocalAnalysis): boolean {
  return (
    analysis.result.scopeCoverage.some((coverage) => coverage.state === "incomplete") ||
    analysis.result.records.some((record) => record.coverage === "incomplete")
  );
}

function emitAppError(error: unknown, io: CliIo): number {
  if (error instanceof AppError) {
    io.stderr(`${error.code}\n`);
    return 70;
  }
  io.stderr("APP_DISCOVERY_FAILED\n");
  return 70;
}
