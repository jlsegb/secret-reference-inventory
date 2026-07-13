#!/usr/bin/env node

import { createLocalCliHandlers } from "../app/index.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runCli } from "./run.js";

/**
 * Runs the public command-line entry point with production-local application handlers.
 *
 * Inputs: Optional argv tokens, defaulting to the current process arguments after the executable.
 * Outputs: The numeric status returned by the CLI runner.
 * Does not handle: Catching startup/import errors or replacing process exit-code assignment when invoked directly.
 * Side effects: Creates local handlers and may cause the runner to emit terminal output or access local files.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createLocalCliHandlers());
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
