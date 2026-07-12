#!/usr/bin/env node

import { createLocalCliHandlers } from "../app/index.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runCli } from "./run.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createLocalCliHandlers());
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
