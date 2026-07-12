import assert from "node:assert/strict";
import test from "node:test";

import {
  readBoundedLocalText,
  type BoundedFileHandle,
  type BoundedFileStat,
  type BoundedLocalFileOperations,
} from "../src/app/bounded-local-file.js";

test("bounded local reads bind the result to the opened file and close its handle", async () => {
  const stable = fileStat({ size: 3 });
  const fixture = operationsFor({
    before: stable,
    after: stable,
    firstPath: stable,
    finalPath: stable,
    text: "abc",
  });

  const result = await readBoundedLocalText("input.json", 3, fixture.operations);
  assert.deepEqual(result, {
    ok: true,
    canonicalPath: "/local/input.json",
    text: "abc",
  });
  assert.equal(fixture.closed(), true);
});

test("bounded local reads fail deterministically when the opened file grows", async () => {
  const initial = fileStat({ size: 3 });
  const grown = fileStat({ size: 4 });
  const fixture = operationsFor({
    before: initial,
    after: grown,
    firstPath: initial,
    finalPath: grown,
    text: "abc",
  });

  const result = await readBoundedLocalText("input.json", 3, fixture.operations);
  assert.deepEqual(result, { ok: false, code: "read-failed" });
  assert.equal(fixture.closed(), true);
});

test("bounded local reads fail deterministically when the canonical path is swapped", async () => {
  const opened = fileStat({ size: 3, ino: 1 });
  const swapped = fileStat({ size: 3, ino: 2 });
  const fixture = operationsFor({
    before: opened,
    after: opened,
    firstPath: opened,
    finalPath: swapped,
    text: "abc",
  });

  const result = await readBoundedLocalText("input.json", 3, fixture.operations);
  assert.deepEqual(result, { ok: false, code: "read-failed" });
  assert.equal(fixture.closed(), true);
});

test("bounded local reads reject over-limit handles before allocating their content", async () => {
  const oversized = fileStat({ size: 4 });
  const fixture = operationsFor({
    before: oversized,
    after: oversized,
    firstPath: oversized,
    finalPath: oversized,
    text: "abcd",
  });

  const result = await readBoundedLocalText("input.json", 3, fixture.operations);
  assert.deepEqual(result, { ok: false, code: "too-large" });
  assert.equal(fixture.closed(), true);
});

test("bounded local reads fail when the canonical parent directory is replaced", async () => {
  const stable = fileStat({ size: 3 });
  const fixture = operationsFor({
    before: stable,
    after: stable,
    firstPath: stable,
    finalPath: stable,
    initialBase: directoryStat({ ino: 1 }),
    finalBase: directoryStat({ ino: 2 }),
    text: "abc",
  });

  const result = await readBoundedLocalText("input.json", 3, fixture.operations);
  assert.deepEqual(result, { ok: false, code: "read-failed" });
  assert.equal(fixture.closed(), true);
});

function fileStat({
  size,
  dev = 1,
  ino = 1,
}: {
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
}): BoundedFileStat {
  return {
    size,
    dev,
    ino,
    mtimeMs: 10,
    ctimeMs: 10,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function directoryStat({
  dev = 1,
  ino = 1,
}: {
  readonly dev?: number;
  readonly ino?: number;
} = {}): BoundedFileStat {
  return {
    size: 0,
    dev,
    ino,
    mtimeMs: 10,
    ctimeMs: 10,
    isFile: () => false,
    isDirectory: () => true,
  };
}

function operationsFor(input: {
  readonly before: BoundedFileStat;
  readonly after: BoundedFileStat;
  readonly firstPath: BoundedFileStat;
  readonly finalPath: BoundedFileStat;
  readonly initialBase?: BoundedFileStat;
  readonly finalBase?: BoundedFileStat;
  readonly text: string;
}): {
  readonly operations: BoundedLocalFileOperations;
  readonly closed: () => boolean;
} {
  let closed = false;
  let handleStats = 0;
  let pathStats = 0;
  let baseStats = 0;
  const handle: BoundedFileHandle = {
    async stat(): Promise<BoundedFileStat> {
      handleStats += 1;
      return handleStats === 1 ? input.before : input.after;
    },
    async read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      _position: number | null,
    ): Promise<{ readonly bytesRead: number }> {
      const bytes = Buffer.from(input.text, "utf8");
      const bytesRead = bytes.copy(buffer, offset, 0, length);
      return { bytesRead };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
  return {
    operations: {
      realpath: async () => "/local/input.json",
      open: async () => handle,
      stat: async (path) => {
        if (path === "/local") {
          baseStats += 1;
          return baseStats === 1
            ? input.initialBase ?? directoryStat()
            : input.finalBase ?? input.initialBase ?? directoryStat();
        }
        pathStats += 1;
        return pathStats === 1 ? input.firstPath : input.finalPath;
      },
    },
    closed: () => closed,
  };
}
