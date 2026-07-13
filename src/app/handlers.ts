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

/**
 * Builds the local-only command handlers and wires their optional test seams.
 *
 * Inputs: Optional workspace scan and loopback-viewer implementations.
 * Outputs: A `CliHandlers` dispatch object whose methods resolve to process exit-status numbers.
 * Does not handle: Argument parsing, process termination, network viewers, or direct process I/O.
 * Side effects: Creates a default local workspace port when none is supplied; returned handlers later read/write local resources.
 */
export function createLocalCliHandlers(
  options: LocalCliHandlerOptions = {},
): CliHandlers {
  const workspaceScan = options.workspaceScan ?? createLocalWorkspaceScanPort();
  return {
    scan: /**
     * Dispatches one parsed scan command to its local handler.
     *
     * Inputs: A scan command and CLI output port.
     * Outputs: A promise for scan's documented exit status.
     * Does not handle: Command parsing or output transport failures itself.
     * Side effects: Delegates local source reading and CLI emission to `handleScan`.
     */ (command, io) => handleScan(command, io),
    reconcile: /**
     * Dispatches one parsed reconciliation command to its local handler.
     *
     * Inputs: A reconcile command and CLI output port.
     * Outputs: A promise for reconciliation's documented exit status.
     * Does not handle: Command parsing or provisioning-file validation itself.
     * Side effects: Delegates local reads and CLI emission to `handleReconcile`.
     */ (command, io) => handleReconcile(command, io),
    explain: /**
     * Dispatches one parsed explain command to its local handler.
     *
     * Inputs: An explain command and CLI output port.
     * Outputs: A promise for explain's documented exit status.
     * Does not handle: Command parsing or report-file reading itself.
     * Side effects: Delegates local report I/O and output to `handleExplain`.
     */ (command, io) => handleExplain(command, io),
    "workspace-scan": /**
     * Dispatches a workspace manifest scan through the selected local scan port.
     *
     * Inputs: A workspace scan command and CLI output port.
     * Outputs: A promise for workspace scan's documented exit status.
     * Does not handle: Manifest parsing or runtime scanning itself.
     * Side effects: Delegates local manifest I/O and reporting to `handleWorkspaceScan`.
     */ (command, io) =>
      handleWorkspaceScan(command, io, workspaceScan),
    ui: /**
     * Dispatches a workspace UI command through the selected local scan and viewer ports.
     *
     * Inputs: A UI command and CLI output port.
     * Outputs: A promise for UI's documented exit status.
     * Does not handle: Browser launch or command parsing.
     * Side effects: Delegates local manifest scanning, viewer startup, and URL output to `handleUi`.
     */ (command, io) =>
      handleUi(command, io, workspaceScan, options.startViewer ?? startLocalReportViewer),
  };
}

/**
 * Executes one code-only scan command and emits its selected report format.
 *
 * Inputs: A parsed scan command and output port.
 * Outputs: Exit `0` on success, `2` for required-complete incompleteness, or `70` for normalized application failure.
 * Does not handle: CLI argument parsing, process exit, or secret retrieval.
 * Side effects: Traverses and reads local source files through analysis; writes report text to stdout or a local output file.
 */
async function handleScan(command: ScanCommand, io: CliIo): Promise<number> {
  try {
    const analysis = await scanLocalRoot(command.root);
    await emitAnalysis(command.format, command.out, analysis, io);
    return command.requireComplete && analysisIsIncomplete(analysis) ? 2 : 0;
  } catch (error) {
    return emitAppError(error, io);
  }
}

/**
 * Executes one local reconciliation command after enforcing its explicit verification-base rules.
 *
 * Inputs: A parsed reconcile command and output port.
 * Outputs: `0`, `2`, usage `64`/`65`, or normalized application `70` according to the branch reached.
 * Does not handle: Scan-report rehydration, implicit CWD authority, remote provisioning APIs, or process exit.
 * Side effects: Canonicalizes the explicit base, reads bounded local JSON documents/source files, and emits report or error text.
 */
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

/**
 * Executes an explain command against a bounded local rendered-report file.
 *
 * Inputs: A parsed explain command and output port.
 * Outputs: `0` after rendering, `64`/`65` for missing or unreadable input, or `70` for normalized explanation failure.
 * Does not handle: Core fact rehydration, non-terminal explain formats, or process exit.
 * Side effects: Reads one bounded local JSON file and writes explanation text to stdout or an output file.
 */
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

/**
 * Scans a local workspace manifest and emits a JSON or terminal workspace report.
 *
 * Inputs: A workspace-scan command, CLI output port, and optional local scan port.
 * Outputs: The manifest/runtime failure status or the report-derived `0`/`2` status.
 * Does not handle: Viewer startup, manifest command parsing, or external workspace services.
 * Side effects: Reads the manifest and repository inputs through the scan port; writes report or fixed error text.
 */
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

/**
 * Scans a local workspace and starts a loopback report viewer only after a status-eligible report also materializes a viewer request.
 *
 * Inputs: A UI command, CLI output port, optional workspace scan port, and a viewer starter.
 * Outputs: `0` only after emitting the loopback URL; a nonzero scan-derived status skips viewer work, while request/start/URL-emission failures produce `70` with the applicable fixed viewer diagnostic when `stderr` succeeds. Status zero is launch eligibility rather than proof that a listener was constructed: incomplete reports remain eligible without `requireComplete`, and `workspaceReportToViewerRequest` may throw before startup.
 * Does not handle: Opening a browser, serving non-loopback clients, retaining a viewer after failed URL emission, or observing promise-returning stream callbacks outside `CliIo`'s `void` contract.
 * Side effects: Reads local workspace inputs; materializes a viewer request; starts and may close a local HTTP viewer; writes the URL to `stdout`; and writes fixed diagnostics to `stderr`. A synchronous `stdout` exception during URL emission is caught as a viewer failure after a close attempt and maps to `APP_WORKSPACE_VIEWER_FAILED`/`70` if `stderr` works; synchronous `stderr` exceptions propagate.
 */
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

/**
 * Reads and executes one verified local workspace manifest through the configured scan port.
 *
 * Inputs: A manifest path and an optional implementation of the workspace scan capability.
 * Outputs: A success report source or a fixed error code paired with status `65` or `70`.
 * Does not handle: Manifest path disclosure, runtime exception details, or fallback to a remote scan service.
 * Side effects: Reads bounded manifest text; invokes the local scan port, which may inspect declared repositories.
 */
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
 * Canonicalizes an explicitly absolute closed-model verification base without ever consulting the process CWD.
 *
 * Inputs: An optional base path from a parsed standalone reconcile command.
 * Outputs: A branded canonical directory path or `undefined` for absent, relative, unreadable, or non-directory input.
 * Does not handle: Directory containment of provisioning files, base snapshot revalidation, or error detail reporting.
 * Side effects: Resolves and stats one local filesystem path.
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

/**
 * Recognizes the viewer's fixed request-size/shape failure class.
 *
 * Inputs: An unknown value caught from viewer request construction or startup.
 * Outputs: `true` only for the viewer's local request-limit error.
 * Does not handle: Other viewer, network, or application error categories.
 * Side effects: Delegates to the viewer's type guard.
 */
function isViewerLimitError(error: unknown): boolean {
  return isViewerRequestLimitError(error);
}

/**
 * Derives the CLI status from workspace invalidity and the caller's completeness requirement.
 *
 * Inputs: A built workspace JSON report and `requireComplete` flag.
 * Outputs: `2` for invalid reports or required incomplete reports; otherwise `0`.
 * Does not handle: Report construction failures or output emission.
 * Side effects: Iterates in-memory repository and deployment states.
 */
function workspaceExitStatus(
  report: ReturnType<typeof buildWorkspaceJsonReport>,
  requireComplete: boolean,
): number {
  const invalid =
    report.repositories.some(/**
     * Detects one invalid repository partition for the aggregate exit decision.
     *
     * Inputs: One rendered repository report.
     * Outputs: `true` when its state is `invalid`.
     * Does not handle: Incomplete or deployment states.
     * Side effects: None.
     */ (repository) => repository.state === "invalid") ||
    report.deployments.some(/**
     * Detects one invalid deployment partition for the aggregate exit decision.
     *
     * Inputs: One rendered deployment report.
     * Outputs: `true` when its state is `invalid`.
     * Does not handle: Repository or member states.
     * Side effects: None.
     */ (deployment) => deployment.state === "invalid");
  if (invalid) {
    return 2;
  }
  return requireComplete && report.summary.incomplete ? 2 : 0;
}

/**
 * Converts workspace processing failures to stable CLI diagnostics and exit status.
 *
 * Inputs: An unknown caught error and CLI output port.
 * Outputs: Returns `70` after `io.stderr` returns successfully with an `AppError` code or fixed runtime failure code; a synchronous stderr exception propagates instead.
 * Does not handle: Raw error serialization, retries, process termination, or normalization of stderr callback failures.
 * Side effects: Invokes `io.stderr` synchronously with one newline-terminated diagnostic.
 */
function emitWorkspaceError(error: unknown, io: CliIo): number {
  if (error instanceof AppError) {
    io.stderr(error.code + "\n");
    return 70;
  }
  io.stderr("APP_WORKSPACE_RUNTIME_FAILED\n");
  return 70;
}

/**
 * Renders a local analysis in the requested format and sends the text to its configured destination.
 *
 * Inputs: Output format, optional output path, analysis snapshot, and CLI output port.
 * Outputs: A fulfilled `undefined` promise after awaiting `emitText`, or rejects with its failure: local file writes are normalized by `emitText` to `AppError(APP_OUTPUT_WRITE_FAILED)`, while a synchronous stdout throw propagates.
 * Does not handle: Exit-status selection, formatter exceptions, parent directory creation, normalization of stdout callback failures, or a Promise returned contrary to the synchronous stdout callback contract.
 * Side effects: Formats in memory, then awaits `emitText`; that helper invokes stdout synchronously or awaits a local file write.
 */
async function emitAnalysis(
  format: OutputFormat,
  outputPath: string | undefined,
  analysis: LocalAnalysis,
  io: CliIo,
): Promise<void> {
  const rendered = renderForFormat(format, analysis);
  await emitText(outputPath, rendered, io);
}

/**
 * Selects the reporter that serializes one local analysis for a parsed output format.
 *
 * Inputs: A discriminated output format and a complete local analysis object.
 * Outputs: Terminal, JSON, or SARIF text.
 * Does not handle: File/stdout writing, unknown formats, or report recomputation.
 * Side effects: Invokes pure reporter serialization functions.
 */
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

/**
 * Emits prepared text to CLI stdout or the requested local output file.
 *
 * Inputs: An optional output path, complete text payload, and CLI output port.
 * Outputs: A fulfilled `undefined` promise; local file-write rejection becomes `AppError(APP_OUTPUT_WRITE_FAILED)`, while a synchronous exception from injected `io.stdout` propagates unchanged. A Promise returned contrary to `CliIo`'s synchronous stdout contract is not awaited or handled.
 * Does not handle: Creating parent directories, printing write-error details, choosing an output format, normalizing stdout callback failures, or observing runtime Promise-returning stdout callbacks.
 * Side effects: Invokes `io.stdout` synchronously when no output path is set, or writes a UTF-8 local file with mode `0600`.
 */
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

/**
 * Determines whether any analysis coverage or reconciliation record is incomplete.
 *
 * Inputs: One local analysis snapshot.
 * Outputs: `true` if a scope coverage entry or record has state/coverage `incomplete`.
 * Does not handle: Invalid workspace report partitions or provisioning policy decisions.
 * Side effects: Iterates in-memory coverage and record arrays.
 */
function analysisIsIncomplete(analysis: LocalAnalysis): boolean {
  return (
    analysis.result.scopeCoverage.some(/**
     * Detects an incomplete scope coverage entry.
     *
     * Inputs: One scope coverage record.
     * Outputs: `true` only for state `incomplete`.
     * Does not handle: Reconciliation record coverage.
     * Side effects: None.
     */ (coverage) => coverage.state === "incomplete") ||
    analysis.result.records.some(/**
     * Detects an incomplete reconciliation record.
     *
     * Inputs: One reconciliation record.
     * Outputs: `true` only for coverage `incomplete`.
     * Does not handle: Scope coverage states.
     * Side effects: None.
     */ (record) => record.coverage === "incomplete")
  );
}

/**
 * Converts scan/reconcile/explain failures to stable application diagnostics and status.
 *
 * Inputs: An unknown caught error and CLI output port.
 * Outputs: Returns `70` after `io.stderr` returns successfully with an `AppError` code or fixed discovery failure code; a synchronous stderr exception propagates instead.
 * Does not handle: Raw error output, recovery, retries, process termination, or normalization of stderr callback failures.
 * Side effects: Invokes `io.stderr` synchronously with one newline-terminated diagnostic.
 */
function emitAppError(error: unknown, io: CliIo): number {
  if (error instanceof AppError) {
    io.stderr(`${error.code}\n`);
    return 70;
  }
  io.stderr("APP_DISCOVERY_FAILED\n");
  return 70;
}
