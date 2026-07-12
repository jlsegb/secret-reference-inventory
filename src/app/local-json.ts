import type { InternalPath } from "../discovery/index.js";

import { readBoundedLocalText } from "./bounded-local-file.js";
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
  const read = await readBoundedLocalText(path, MAX_LOCAL_JSON_BYTES);
  if (!read.ok) {
    return {
      ok: false,
      code: read.code === "too-large"
        ? "APP_LOCAL_INPUT_TOO_LARGE"
        : "APP_LOCAL_INPUT_READ_FAILED",
    };
  }

  try {
    const document = {
      ok: true,
      value: JSON.parse(read.text) as unknown,
    } as LocalJsonDocument;
    Object.defineProperty(document, "canonicalPath", {
      value: read.canonicalPath,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(document);
  } catch {
    return { ok: false, code: "APP_LOCAL_INPUT_INVALID_JSON" };
  }
}
