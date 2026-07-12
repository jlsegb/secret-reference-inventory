import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = resolve(root, "dist", "cli", "bin.js");

await mkdir(dirname(launcher), { recursive: true });
await writeFile(
  launcher,
  [
    "#!/usr/bin/env node",
    'import { main } from "./main.js";',
    "process.exitCode = await main();",
    "",
  ].join("\n"),
  { encoding: "utf8", mode: 0o755 },
);
