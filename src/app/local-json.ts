import { readFile, realpath, stat } from "node:fs/promises";

import type { InternalPath } from "../discovery/index.js";
import type { LocalJsonReadFailure } from "./types.js";

const MAX_LOCAL_JSON_BYTES = 5 * 1024 * 1024;

export interface LocalJsonDocument {
  readonly ok: true;
  readonly value: unknown;
  /** Internal only: do not pass this path to facts, diagnostics, or reporters. */
  readonly canonicalPath: InternalPath;
}

export type LocalJsonReadResult = LocalJsonDocument | LocalJsonReadFailure;

/** Reads a user-selected local JSON file without evaluating it or surfacing raw errors. */
export async function readLocalJson(path: string): Promise<LocalJsonReadResult> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      return { ok: false, code: "APP_LOCAL_INPUT_READ_FAILED" };
    }
    if (metadata.size > MAX_LOCAL_JSON_BYTES) {
      return { ok: false, code: "APP_LOCAL_INPUT_TOO_LARGE" };
    }
  } catch {
    return { ok: false, code: "APP_LOCAL_INPUT_READ_FAILED" };
  }

  let text: string;
  try {
    text = await readFile(canonicalPath, "utf8");
  } catch {
    return { ok: false, code: "APP_LOCAL_INPUT_READ_FAILED" };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text) as unknown,
      canonicalPath: canonicalPath as InternalPath,
    };
  } catch {
    return { ok: false, code: "APP_LOCAL_INPUT_INVALID_JSON" };
  }
}
