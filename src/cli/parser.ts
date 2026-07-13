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

/**
 * Converts supported command-line tokens into a value-safe command or a fixed parse error.
 *
 * Inputs: The argv tokens after the executable name.
 * Outputs: A discriminated CLI command, help request, or fixed error code.
 * Does not handle: Filesystem access, configuration loading, command execution, or terminal output.
 * Side effects: None.
 */
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

/**
 * Validates scan-specific positional and output options.
 *
 * Inputs: Generic tokens already split into positional, boolean, and valued options.
 * Outputs: A scan command or a fixed syntax/option error.
 * Does not handle: Verifying that the requested root exists or can be scanned.
 * Side effects: None.
 */
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

/**
 * Validates the mutually exclusive reconcile source and its provisioning file options.
 *
 * Inputs: Previously tokenized options for the reconcile command.
 * Outputs: A reconcile command after each supplied free-form value passes `isSafeCliValue`'s bounded, nonempty, single-line lexical filter, or a fixed parse error.
 * Does not handle: Path containment, reference grammar, or manifest/provisioning semantics; downstream readers and handlers own those checks.
 * Side effects: None.
 */
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

/**
 * Validates a single reference identifier and optional scan-report location for explain.
 *
 * Inputs: Previously tokenized explain options.
 * Outputs: An explain command after its reference, optional report path, and optional output destination pass `isSafeCliValue`'s bounded, nonempty, single-line lexical filter, or a fixed syntax/option error.
 * Does not handle: Reference grammar, path containment, report lookup, or rendering; downstream readers and handlers own those checks.
 * Side effects: None.
 */
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

/**
 * Parses the workspace subcommand independently from single-repository commands.
 *
 * Inputs: Full argv tokens beginning with the workspace command.
 * Outputs: A workspace-scan command, help request, or fixed parse error.
 * Does not handle: Loading the manifest or deciding repository coverage.
 * Side effects: None.
 */
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

/**
 * Validates the manifest and optional loopback port for the local UI command.
 *
 * Inputs: Previously tokenized UI options.
 * Outputs: A UI command after the manifest path passes `isSafeCliValue`'s bounded, nonempty, single-line lexical filter and any port passes decimal range validation, or a fixed parse error.
 * Does not handle: Path containment, manifest semantics, starting a server, opening a browser, or reading the manifest; downstream readers and handlers own those checks.
 * Side effects: None.
 */
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

/**
 * Splits a command's remaining tokens into positionals, flags, and one-value options.
 *
 * Inputs: Tokens after a command name or workspace subcommand.
 * Outputs: Newly allocated but mutable arrays, maps, and sets exposed through readonly TypeScript types, or one fixed lexical error.
 * Does not handle: Command-specific combinations, filesystem/path validity, canonicalization, or root containment; every path-like token remains only lexically filtered here.
 * Side effects: Allocates mutable local arrays, maps, and sets only.
 */
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

/**
 * Chooses a permitted single-repository output format and optional destination.
 *
 * Inputs: Valued options collected for scan, reconcile, or explain.
 * Outputs: Terminal, JSON, or SARIF output settings, or a fixed error.
 * Does not handle: Creating the destination file or serializing a report.
 * Side effects: None.
 */
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

/**
 * Chooses a permitted workspace output format and optional destination.
 *
 * Inputs: Valued options collected for workspace scan.
 * Outputs: Terminal or JSON workspace output settings, or a fixed error.
 * Does not handle: Writing output or supporting SARIF for workspace reports.
 * Side effects: None.
 */
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

/**
 * Tests whether any disallowed option name is present in a parsed value map.
 *
 * Inputs: A map of supplied valued options and the names to test.
 * Outputs: True when at least one tested name is present.
 * Does not handle: Boolean flags or validation of option values.
 * Side effects: None.
 */
function hasAny(values: ReadonlyMap<string, string>, keys: readonly string[]): boolean {
  return keys.some(
    /**
     * Tests one candidate option name against the supplied map.
     *
     * Inputs: A single option name from the caller's disallow list.
     * Outputs: True when that name is mapped to a value.
     * Does not handle: Parsing or validating the mapped value.
     * Side effects: None.
     */
    (key) => values.has(key)
  );
}

/**
 * Accepts an absent optional setting or delegates validation of a supplied text value.
 *
 * Inputs: An optional token-derived string.
 * Outputs: True for absence or a value allowed by the CLI text policy.
 * Does not handle: Semantic validation of paths, references, or ports.
 * Side effects: None.
 */
function isOptionalSafeCliValue(value: string | undefined): boolean {
  return value === undefined || isSafeCliValue(value);
}

/**
 * Applies the CLI's bounded single-line lexical filter to one command-line text value.
 *
 * Inputs: One raw command-line token or option value.
 * Outputs: True only for a nonempty string of at most 4,096 code units with no NUL, carriage return, or line feed.
 * Does not handle: Safe-path policy, canonical containment, manifest semantic validation, command-specific grammar, or secret-shaped-text rejection; command handlers own the later safety checks.
 * Side effects: None.
 */
function isSafeCliValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CLI_VALUE_LENGTH && !/[\0\r\n]/.test(value);
}

/**
 * Parses a decimal TCP port within the inclusive host-port range.
 *
 * Inputs: A CLI option value containing decimal digits.
 * Outputs: A safe integer port or undefined for invalid text or range.
 * Does not handle: Testing port availability or binding a listener.
 * Side effects: None.
 */
function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/u.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

/**
 * Builds the parser's value-free failure variant.
 *
 * Inputs: A fixed CLI error code selected by the caller.
 * Outputs: The unsuccessful parse-result shape containing that code.
 * Does not handle: Formatting, logging, or converting errors into exit statuses.
 * Side effects: Allocates a small result object.
 */
function failure(code: CliErrorCode): { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  return { ok: false, error: { code } };
}
