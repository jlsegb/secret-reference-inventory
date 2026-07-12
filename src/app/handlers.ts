import { writeFile } from "node:fs/promises";

import type {
  CliHandlers,
  CliIo,
  ExplainCommand,
  OutputFormat,
  ReconcileCommand,
  ScanCommand,
} from "../cli/types.js";
import {
  renderJson,
  renderSarif,
  renderTerminal,
} from "../reporters/index.js";

import { reconcileLocalRoot, scanLocalRoot } from "./analysis.js";
import { explainRenderedJsonReport } from "./explain.js";
import { readLocalJson } from "./local-json.js";
import { AppError, type LocalAnalysis } from "./types.js";

export function createLocalCliHandlers(): CliHandlers {
  return {
    scan: (command, io) => handleScan(command, io),
    reconcile: (command, io) => handleReconcile(command, io),
    explain: (command, io) => handleExplain(command, io),
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

  try {
    const bindings = await readLocalJson(command.bindings);
    const inventory = await readLocalJson(command.inventory);
    const closedModel = command.closedModel === undefined
      ? undefined
      : await readLocalJson(command.closedModel);
    const analysis = await reconcileLocalRoot(command.root, { bindings, inventory, ...(closedModel === undefined ? {} : { closedModel }) });
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
