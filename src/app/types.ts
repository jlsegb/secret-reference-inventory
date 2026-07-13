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
  | "APP_SAFETY_MATERIALIZATION_FAILED"
  | "APP_WORKSPACE_MANIFEST_READ_FAILED"
  | "APP_WORKSPACE_MANIFEST_TOO_LARGE"
  | "APP_WORKSPACE_MANIFEST_INVALID"
  | "APP_WORKSPACE_RUNTIME_UNAVAILABLE"
  | "APP_WORKSPACE_RUNTIME_FAILED"
  | "APP_CLOSED_MODEL_VERIFICATION_BASE_INVALID"
  | "APP_WORKSPACE_VIEWER_LIMIT_EXCEEDED"
  | "APP_WORKSPACE_VIEWER_FAILED";

/**
 * Creates a value-free application error whose message and name are safe for CLI normalization.
 *
 * Inputs: One allowed fixed `AppErrorCode`.
 * Outputs: An initialized `AppError` instance with matching `message` and readonly `code`.
 * Does not handle: Arbitrary Error causes, paths, parser messages, secret values, or exit-status emission.
 * Side effects: Initializes the inherited `Error` stack/message state and assigns the error name/code fields.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;

  /**
   * Initializes a value-free application error from one fixed code.
   *
   * Inputs: One allowed application error code.
   * Outputs: A fully initialized `AppError` instance with matching `code`, `message`, and name.
   * Does not handle: Error causes, dynamic messages, path attachment, or CLI emission.
   * Side effects: Initializes inherited `Error` state and assigns instance fields.
   */
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

export interface LocalWorkspaceManifestReadFailure {
  readonly ok: false;
  readonly code:
    | "APP_WORKSPACE_MANIFEST_READ_FAILED"
    | "APP_WORKSPACE_MANIFEST_TOO_LARGE"
    | "APP_WORKSPACE_MANIFEST_INVALID";
}
