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
  stdout:
    /**
     * Writes one CLI success or help fragment to the process standard-output stream.
     *
     * Inputs: Text already selected by the CLI layer.
     * Outputs: Node's synchronous write return value.
     * Does not handle: Awaiting stream backpressure or catching write failures.
     * Side effects: Writes to the host process standard output.
     */
    (text) => process.stdout.write(text),
  stderr:
    /**
     * Writes one fixed CLI diagnostic fragment to the process standard-error stream.
     *
     * Inputs: Text already selected by the CLI layer.
     * Outputs: Node's synchronous write return value.
     * Does not handle: Awaiting stream backpressure or catching write failures.
     * Side effects: Writes to the host process standard error.
     */
    (text) => process.stderr.write(text),
};

/**
 * Parses local CLI input, routes supported commands to injected handlers, and maps handler failures.
 *
 * Inputs: Raw argv tokens, optional command handlers, and synchronous output callbacks.
 * Outputs: A conventional numeric exit status after direct invocation or awaited handler completion.
 * Does not handle: Filesystem analysis itself, validation of handler contracts, or awaited thenables from I/O callbacks.
 * Side effects: Calls the selected handler and invokes stdout/stderr synchronously; synchronous I/O throws escape.
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
