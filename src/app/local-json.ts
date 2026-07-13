import type { InternalPath } from "../discovery/index.js";

import { readBoundedLocalText } from "./bounded-local-file.js";
import type { LocalJsonReadFailure } from "./types.js";

const MAX_LOCAL_JSON_BYTES = 5 * 1024 * 1024;

export interface LocalJsonDocument {
  readonly ok: true;
  readonly value: unknown;
  /** Exposed but non-enumerable on successful reads; internal-use convention forbids passing it to facts, diagnostics, or reporters. */
  readonly canonicalPath: InternalPath;
}

export type LocalJsonReadResult = LocalJsonDocument | LocalJsonReadFailure;

/**
 * Reads and parses one bounded local JSON document while exposing its canonical path only as a non-enumerable internal-use property.
 *
 * Inputs: A caller-selected local file path.
 * Outputs: A frozen successful document with unknown JSON value and exported `canonicalPath` interface property, or fixed read/size/JSON failure code.
 * Does not handle: JSONC, schema validation, secret lookup, or forwarding the non-enumerable internal-use canonical path to facts, diagnostics, or reports.
 * Side effects: Opens, stats, reads, and closes a bounded local file descriptor; parses text and defines the non-enumerable `canonicalPath` property.
 */
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
