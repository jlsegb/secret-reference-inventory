import type {
  ReconciliationInput,
  ReconciliationResult,
  SafeDiagnosticCode,
} from "../core/index.js";
import type { ReportingInput } from "../reporters/index.js";

export type AppErrorCode =
  | "APP_DISCOVERY_FAILED"
  | "APP_LOCAL_INPUT_READ_FAILED"
  | "APP_LOCAL_INPUT_TOO_LARGE"
  | "APP_LOCAL_INPUT_INVALID_JSON"
  | "APP_OUTPUT_WRITE_FAILED"
  | "APP_SCAN_REPORT_REHYDRATION_UNSUPPORTED"
  | "APP_EXPLAIN_REQUIRES_SCAN_REPORT"
  | "APP_EXPLAIN_REPORT_INVALID"
  | "APP_EXPLAIN_FORMAT_UNSUPPORTED"
  | "APP_SAFETY_MATERIALIZATION_FAILED";

/** Error text is always a fixed code; never attach a path, parser message, or value. */
export class AppError extends Error {
  readonly code: AppErrorCode;

  public constructor(code: AppErrorCode) {
    super(code);
    this.name = "AppError";
    this.code = code;
  }
}

export interface LocalAnalysis {
  readonly reconciliationInput: ReconciliationInput;
  readonly result: ReconciliationResult;
  readonly reportingInput: ReportingInput;
  readonly diagnostics: readonly SafeDiagnosticCode[];
}

export interface LocalJsonReadFailure {
  readonly ok: false;
  readonly code:
    | "APP_LOCAL_INPUT_READ_FAILED"
    | "APP_LOCAL_INPUT_TOO_LARGE"
    | "APP_LOCAL_INPUT_INVALID_JSON";
}
