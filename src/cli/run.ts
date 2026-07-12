import { parseCli } from "./parser.js";
import type { CliHandlers, CliIo } from "./types.js";

const HELP_TEXT = `secret-usage — local static secret-reference inventory

Usage:
  secret-usage scan <root> [--format terminal|json|sarif] [--out <path>] [--require-complete]
  secret-usage reconcile (--root <root> | --scan-report <file>) --inventory <file> --bindings <file> [--closed-model <file> --verification-base <absolute-directory>] [--require-complete]
  secret-usage explain <logical-key> [--scan-report <file>]
  secret-usage workspace scan --manifest <file> [--format terminal|json] [--out <path>] [--require-complete]
  secret-usage ui --manifest <file> [--port <0-65535>] [--require-complete]
`;

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * A handler-only shell. Parsing and usage output are safe and local; W5 adds
 * analysis/reconciliation handlers without changing command semantics.
 */
export async function runCli(
  argv: readonly string[],
  handlers: CliHandlers = {},
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.ok === false) {
    io.stderr(`${parsed.error.code}\n`);
    return 64;
  }

  if (parsed.command.kind === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const handler = handlers[parsed.command.kind];
  if (handler === undefined) {
    io.stderr("CLI_ENGINE_UNAVAILABLE\n");
    return 70;
  }

  try {
    return await handler(parsed.command as never, io);
  } catch {
    // Do not serialize thrown messages: parser/adapters may have retained raw input.
    io.stderr("CLI_OPERATION_FAILED\n");
    return 70;
  }
}

export { HELP_TEXT };
