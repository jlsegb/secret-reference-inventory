import type {
  CliCommand,
  CliErrorCode,
  CliParseResult,
  ExplainCommand,
  OutputFormat,
  ReconcileCommand,
  ScanCommand,
  UiCommand,
  WorkspaceOutputFormat,
  WorkspaceScanCommand,
} from "./types.js";

const MAX_CLI_VALUE_LENGTH = 4_096;

interface ParsedOptions {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

const VALUE_OPTIONS = new Set([
  "--format",
  "--out",
  "--root",
  "--scan-report",
  "--inventory",
  "--bindings",
  "--closed-model",
  "--verification-base",
  "--manifest",
  "--port",
]);
const BOOLEAN_OPTIONS = new Set(["--require-complete", "--help"]);

/** Parses only; it never opens a path, loads configuration, or prints input. */
export function parseCli(argv: readonly string[]): CliParseResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { ok: true, command: { kind: "help" } };
  }

  const commandName = argv[0];
  if (
    commandName !== "scan" &&
    commandName !== "reconcile" &&
    commandName !== "explain" &&
    commandName !== "workspace" &&
    commandName !== "ui"
  ) {
    return failure("CLI_UNKNOWN_COMMAND");
  }

  if (commandName === "workspace") {
    return parseWorkspace(argv);
  }

  const options = parseOptions(argv.slice(1));
  if (options.ok === false) {
    return options;
  }
  if (options.value.booleans.has("--help")) {
    return { ok: true, command: { kind: "help" } };
  }

  switch (commandName) {
    case "scan":
      return parseScan(options.value);
    case "reconcile":
      return parseReconcile(options.value);
    case "explain":
      return parseExplain(options.value);
    case "ui":
      return parseUi(options.value);
  }
}

function parseScan(options: ParsedOptions): CliParseResult {
  if (
    hasAny(options.values, [
      "--root",
      "--scan-report",
      "--inventory",
      "--bindings",
      "--closed-model",
      "--verification-base",
      "--manifest",
      "--port",
    ])
  ) {
    return failure("CLI_UNKNOWN_OPTION");
  }
  if (options.positionals.length !== 1) {
    return failure("CLI_MISSING_ARGUMENT");
  }

  const root = options.positionals[0];
  if (root === undefined || !isSafeCliValue(root)) {
    return failure("CLI_INVALID_ARGUMENT");
  }

  const output = parseOutputOptions(options.values);
  if (output.ok === false) {
    return output;
  }

  const command: ScanCommand = {
    kind: "scan",
    root,
    ...output.value,
    requireComplete: options.booleans.has("--require-complete"),
  };
  return { ok: true, command };
}

function parseReconcile(options: ParsedOptions): CliParseResult {
  if (options.positionals.length !== 0) {
    return failure("CLI_INVALID_ARGUMENT");
  }

  const root = options.values.get("--root");
  const scanReport = options.values.get("--scan-report");
  if ((root === undefined && scanReport === undefined) || (root !== undefined && scanReport !== undefined)) {
    return failure("CLI_CONFLICTING_INPUTS");
  }

  const inventory = options.values.get("--inventory");
  const bindings = options.values.get("--bindings");
  const closedModel = options.values.get("--closed-model");
  const verificationBase = options.values.get("--verification-base");
  if (inventory === undefined || bindings === undefined) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  if (closedModel !== undefined && verificationBase === undefined) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  if (closedModel === undefined && verificationBase !== undefined) {
    return failure("CLI_CONFLICTING_INPUTS");
  }
  if (
    hasAny(options.values, ["--manifest", "--port"]) ||
    ![root, scanReport, inventory, bindings, closedModel, verificationBase]
      .every(isOptionalSafeCliValue)
  ) {
    return failure("CLI_INVALID_ARGUMENT");
  }

  const output = parseOutputOptions(options.values);
  if (output.ok === false) {
    return output;
  }

  const command: ReconcileCommand = {
    kind: "reconcile",
    ...(root === undefined ? {} : { root }),
    ...(scanReport === undefined ? {} : { scanReport }),
    inventory,
    bindings,
    ...(closedModel === undefined
      ? {}
      : { closedModel, verificationBase: verificationBase as string }),
    ...output.value,
    requireComplete: options.booleans.has("--require-complete"),
  };
  return { ok: true, command };
}

function parseExplain(options: ParsedOptions): CliParseResult {
  if (
    hasAny(options.values, [
      "--root",
      "--inventory",
      "--bindings",
      "--closed-model",
      "--verification-base",
      "--manifest",
      "--port",
    ])
  ) {
    return failure("CLI_UNKNOWN_OPTION");
  }
  const reference = options.positionals[0];
  if (options.positionals.length !== 1 || reference === undefined || !isSafeCliValue(reference)) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  const scanReport = options.values.get("--scan-report");
  if (!isOptionalSafeCliValue(scanReport)) {
    return failure("CLI_INVALID_ARGUMENT");
  }
  const output = parseOutputOptions(options.values);
  if (output.ok === false) {
    return output;
  }

  const command: ExplainCommand = {
    kind: "explain",
    reference,
    ...(scanReport === undefined ? {} : { scanReport }),
    ...output.value,
  };
  return { ok: true, command };
}

function parseWorkspace(argv: readonly string[]): CliParseResult {
  const subcommand = argv[1];
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    return { ok: true, command: { kind: "help" } };
  }
  if (subcommand !== "scan") {
    return failure("CLI_UNKNOWN_COMMAND");
  }

  const options = parseOptions(argv.slice(2));
  if (options.ok === false) {
    return options;
  }
  if (options.value.booleans.has("--help")) {
    return { ok: true, command: { kind: "help" } };
  }
  if (
    options.value.positionals.length !== 0 ||
    hasAny(options.value.values, [
      "--root",
      "--scan-report",
      "--inventory",
      "--bindings",
      "--closed-model",
      "--verification-base",
      "--port",
    ])
  ) {
    return failure("CLI_UNKNOWN_OPTION");
  }

  const manifest = options.value.values.get("--manifest");
  if (manifest === undefined) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  if (!isSafeCliValue(manifest)) {
    return failure("CLI_INVALID_ARGUMENT");
  }

  const output = parseWorkspaceOutputOptions(options.value.values);
  if (output.ok === false) {
    return output;
  }
  const command: WorkspaceScanCommand = {
    kind: "workspace-scan",
    manifest,
    ...output.value,
    requireComplete: options.value.booleans.has("--require-complete"),
  };
  return { ok: true, command };
}

function parseUi(options: ParsedOptions): CliParseResult {
  if (
    options.positionals.length !== 0 ||
    hasAny(options.values, [
      "--root",
      "--scan-report",
      "--inventory",
      "--bindings",
      "--closed-model",
      "--verification-base",
      "--format",
      "--out",
    ])
  ) {
    return failure("CLI_UNKNOWN_OPTION");
  }

  const manifest = options.values.get("--manifest");
  const rawPort = options.values.get("--port");
  if (manifest === undefined) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  if (!isSafeCliValue(manifest)) {
    return failure("CLI_INVALID_ARGUMENT");
  }
  const port = rawPort === undefined ? undefined : parsePort(rawPort);
  if (rawPort !== undefined && port === undefined) {
    return failure("CLI_INVALID_ARGUMENT");
  }

  const command: UiCommand = {
    kind: "ui",
    manifest,
    ...(port === undefined ? {} : { port }),
    requireComplete: options.booleans.has("--require-complete"),
  };
  return { ok: true, command };
}

function parseOptions(tokens: readonly string[]):
  | { readonly ok: true; readonly value: ParsedOptions }
  | { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !isSafeCliValue(token)) {
      return failure("CLI_INVALID_ARGUMENT");
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(token)) {
      booleans.add(token);
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) {
      return failure("CLI_UNKNOWN_OPTION");
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      return failure("CLI_MISSING_VALUE");
    }
    if (!isSafeCliValue(value) || value.startsWith("--") || values.has(token)) {
      return failure("CLI_INVALID_ARGUMENT");
    }
    values.set(token, value);
    index += 1;
  }

  return {
    ok: true,
    value: {
      positionals,
      values,
      booleans,
    },
  };
}

function parseOutputOptions(values: ReadonlyMap<string, string>):
  | { readonly ok: true; readonly value: { readonly format: OutputFormat; readonly out?: string } }
  | { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  const formatValue = values.get("--format") ?? "terminal";
  if (formatValue !== "terminal" && formatValue !== "json" && formatValue !== "sarif") {
    return failure("CLI_INVALID_ARGUMENT");
  }
  const out = values.get("--out");
  if (!isOptionalSafeCliValue(out)) {
    return failure("CLI_INVALID_ARGUMENT");
  }
  return {
    ok: true,
    value: {
      format: formatValue,
      ...(out === undefined ? {} : { out }),
    },
  };
}

function parseWorkspaceOutputOptions(values: ReadonlyMap<string, string>):
  | {
      readonly ok: true;
      readonly value: { readonly format: WorkspaceOutputFormat; readonly out?: string };
    }
  | { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  const formatValue = values.get("--format") ?? "terminal";
  if (formatValue !== "terminal" && formatValue !== "json") {
    return failure("CLI_INVALID_ARGUMENT");
  }
  const out = values.get("--out");
  if (!isOptionalSafeCliValue(out)) {
    return failure("CLI_INVALID_ARGUMENT");
  }
  return {
    ok: true,
    value: {
      format: formatValue,
      ...(out === undefined ? {} : { out }),
    },
  };
}

function hasAny(values: ReadonlyMap<string, string>, keys: readonly string[]): boolean {
  return keys.some((key) => values.has(key));
}

function isOptionalSafeCliValue(value: string | undefined): boolean {
  return value === undefined || isSafeCliValue(value);
}

function isSafeCliValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CLI_VALUE_LENGTH && !/[\0\r\n]/.test(value);
}

function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/u.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

function failure(code: CliErrorCode): { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  return { ok: false, error: { code } };
}
