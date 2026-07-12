import type {
  CliCommand,
  CliErrorCode,
  CliParseResult,
  ExplainCommand,
  OutputFormat,
  ReconcileCommand,
  ScanCommand,
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
]);
const BOOLEAN_OPTIONS = new Set(["--require-complete", "--help"]);

/** Parses only; it never opens a path, loads configuration, or prints input. */
export function parseCli(argv: readonly string[]): CliParseResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { ok: true, command: { kind: "help" } };
  }

  const commandName = argv[0];
  if (commandName !== "scan" && commandName !== "reconcile" && commandName !== "explain") {
    return failure("CLI_UNKNOWN_COMMAND");
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
  }
}

function parseScan(options: ParsedOptions): CliParseResult {
  if (hasAny(options.values, ["--root", "--scan-report", "--inventory", "--bindings", "--closed-model"])) {
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
  if (inventory === undefined || bindings === undefined) {
    return failure("CLI_MISSING_ARGUMENT");
  }
  if (![root, scanReport, inventory, bindings, closedModel].every(isOptionalSafeCliValue)) {
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
      : { closedModel }),
    ...output.value,
    requireComplete: options.booleans.has("--require-complete"),
  };
  return { ok: true, command };
}

function parseExplain(options: ParsedOptions): CliParseResult {
  if (hasAny(options.values, ["--root", "--inventory", "--bindings", "--closed-model"])) {
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

function hasAny(values: ReadonlyMap<string, string>, keys: readonly string[]): boolean {
  return keys.some((key) => values.has(key));
}

function isOptionalSafeCliValue(value: string | undefined): boolean {
  return value === undefined || isSafeCliValue(value);
}

function isSafeCliValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CLI_VALUE_LENGTH && !/[\0\r\n]/.test(value);
}

function failure(code: CliErrorCode): { readonly ok: false; readonly error: { readonly code: CliErrorCode } } {
  return { ok: false, error: { code } };
}
