export type OutputFormat = "terminal" | "json" | "sarif";

interface OutputOptions {
  readonly format: OutputFormat;
  readonly out?: string;
}

export interface ScanCommand extends OutputOptions {
  readonly kind: "scan";
  readonly root: string;
  readonly requireComplete: boolean;
}

export interface ReconcileCommand extends OutputOptions {
  readonly kind: "reconcile";
  readonly root?: string;
  readonly scanReport?: string;
  readonly inventory: string;
  readonly bindings: string;
  readonly closedModel?: string;
  /** Required with a closed model; never inferred from the process CWD. */
  readonly verificationBase?: string;
  readonly requireComplete: boolean;
}

export interface ExplainCommand extends OutputOptions {
  readonly kind: "explain";
  readonly reference: string;
  readonly scanReport?: string;
}

/** Workspace reports have a dedicated deterministic JSON schema, not SARIF. */
export type WorkspaceOutputFormat = "terminal" | "json";

export interface WorkspaceScanCommand {
  readonly kind: "workspace-scan";
  /** User-selected local manifest; it is never passed to browser code. */
  readonly manifest: string;
  readonly format: WorkspaceOutputFormat;
  readonly out?: string;
  readonly requireComplete: boolean;
}

export interface UiCommand {
  readonly kind: "ui";
  /** User-selected local manifest; the local server receives only derived data. */
  readonly manifest: string;
  /** Zero selects an ephemeral loopback port. */
  readonly port?: number;
  readonly requireComplete: boolean;
}

export interface HelpCommand {
  readonly kind: "help";
}

export type CliCommand =
  | ScanCommand
  | ReconcileCommand
  | ExplainCommand
  | WorkspaceScanCommand
  | UiCommand
  | HelpCommand;

export type CliErrorCode =
  | "CLI_UNKNOWN_COMMAND"
  | "CLI_UNKNOWN_OPTION"
  | "CLI_MISSING_VALUE"
  | "CLI_MISSING_ARGUMENT"
  | "CLI_INVALID_ARGUMENT"
  | "CLI_CONFLICTING_INPUTS"
  | "CLI_ENGINE_UNAVAILABLE"
  | "CLI_OPERATION_FAILED";

export interface CliError {
  readonly code: CliErrorCode;
}

export type CliParseResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly error: CliError };

/** W5 can inject analysis/reconciliation handlers without changing parsing. */
export interface CliHandlers {
  readonly scan?: (command: ScanCommand, io: CliIo) => Promise<number> | number;
  readonly reconcile?: (command: ReconcileCommand, io: CliIo) => Promise<number> | number;
  readonly explain?: (command: ExplainCommand, io: CliIo) => Promise<number> | number;
  readonly "workspace-scan"?: (
    command: WorkspaceScanCommand,
    io: CliIo,
  ) => Promise<number> | number;
  readonly ui?: (command: UiCommand, io: CliIo) => Promise<number> | number;
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
