import assert from "node:assert/strict";
import test from "node:test";

import {
  readBoundedLocalText,
  type BoundedFileHandle,
  type BoundedFileStat,
  type BoundedLocalFileOperations,
} from "../src/app/bounded-local-file.js";

test("bounded local reads bind the result to the opened file and close its handle", /**
 * Verifies the stable fixture returns text/canonical path and closes the opened handle.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when the success result and closure assertions pass.
 * Does not handle: Growth, replacement, or size-limit failure fixtures.
 * Side effects: Exercises only in-memory fake filesystem operations.
 */ async () => {
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

test("bounded local reads fail deterministically when the opened file grows", /**
 * Verifies post-read size growth becomes the fixed read-failed result and still closes the fake handle.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when failure/closure assertions pass.
 * Does not handle: Path swaps or byte-limit rejection.
 * Side effects: Exercises only in-memory fake filesystem operations.
 */ async () => {
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

test("bounded local reads fail deterministically when the canonical path is swapped", /**
 * Verifies a changed canonical-path inode is rejected even when the opened descriptor stays stable.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when fixed failure and closure assertions pass.
 * Does not handle: Parent-directory swaps or growth.
 * Side effects: Exercises only in-memory fake filesystem operations.
 */ async () => {
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

test("bounded local reads reject over-limit handles before allocating their content", /**
 * Verifies an initial descriptor size above the cap returns too-large and closes the handle.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when too-large and closure assertions pass.
 * Does not handle: Short reads or path stability checks.
 * Side effects: Exercises only in-memory fake filesystem operations.
 */ async () => {
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

test("bounded local reads fail when the canonical parent directory is replaced", /**
 * Verifies a parent-directory inode change invalidates an otherwise stable file read.
 *
 * Inputs: The Node test context with no used arguments.
 * Outputs: A fulfilled promise when read-failed and closure assertions pass.
 * Does not handle: File inode swaps or byte-limit rejection.
 * Side effects: Exercises only in-memory fake filesystem operations.
 */ async () => {
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

/**
 * Builds a regular-file stat double with deterministic identity and timestamp fields.
 *
 * Inputs: Required size and optional device/inode numbers.
 * Outputs: A `BoundedFileStat` whose type predicates report regular file/not directory.
 * Does not handle: Filesystem permissions, realistic timestamps, or nonnumeric identity fields.
 * Side effects: Allocates one in-memory test double.
 */
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
    isFile: /**
     * Reports that this test stat represents a regular file.
     *
     * Inputs: None.
     * Outputs: Always `true`.
     * Does not handle: Dynamic filesystem types.
     * Side effects: None.
     */ () => true,
    isDirectory: /**
     * Reports that this test stat does not represent a directory.
     *
     * Inputs: None.
     * Outputs: Always `false`.
     * Does not handle: Dynamic filesystem types.
     * Side effects: None.
     */ () => false,
  };
}

/**
 * Builds a directory stat double with deterministic identity and timestamp fields.
 *
 * Inputs: Optional device/inode numbers, defaulting to `1`.
 * Outputs: A `BoundedFileStat` whose type predicates report directory/not regular file.
 * Does not handle: Filesystem permissions, realistic timestamps, or content size.
 * Side effects: Allocates one in-memory test double.
 */
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
    isFile: /**
     * Reports that this directory test double is not a regular file.
     *
     * Inputs: None.
     * Outputs: Always `false`.
     * Does not handle: Dynamic filesystem types.
     * Side effects: None.
     */ () => false,
    isDirectory: /**
     * Reports that this test stat represents a directory.
     *
     * Inputs: None.
     * Outputs: Always `true`.
     * Does not handle: Dynamic filesystem types.
     * Side effects: None.
     */ () => true,
  };
}

/**
 * Creates deterministic fake filesystem operations and a close-state probe for bounded-read tests.
 *
 * Inputs: Before/after descriptor and path stats, optional parent stats, and UTF-8 file text.
 * Outputs: A fake operations port plus `closed` probe reflecting whether its handle was closed.
 * Does not handle: Real filesystem I/O, concurrent mutation outside the supplied state transitions, or write operations.
 * Side effects: Mutates private stat counters and close flag as fake operations are invoked.
 */
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
    /**
     * Returns the initial descriptor stat once and the configured post-read stat thereafter.
     *
     * Inputs: None.
     * Outputs: A promise for `before` on first call or `after` on later calls.
     * Does not handle: Real descriptor metadata or stat failures.
     * Side effects: Increments the enclosing handle-stat counter.
     */
    async stat(): Promise<BoundedFileStat> {
      handleStats += 1;
      return handleStats === 1 ? input.before : input.after;
    },
    /**
     * Copies the configured fixture text into a requested buffer range.
     *
     * Inputs: Destination buffer, offset, requested length, and ignored file position.
     * Outputs: A promise containing the number of copied bytes.
     * Does not handle: Short-read simulation, I/O errors, or content mutation.
     * Side effects: Mutates the caller-provided destination buffer.
     */
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
    /**
     * Records closure of the fake descriptor.
     *
     * Inputs: None.
     * Outputs: A fulfilled `undefined` promise.
     * Does not handle: Real descriptor cleanup failures.
     * Side effects: Sets the enclosing `closed` flag to `true`.
     */
    async close(): Promise<void> {
      closed = true;
    },
  };
  return {
    operations: {
      realpath: /**
       * Returns the canonical fake input location.
       *
       * Inputs: The ignored requested path.
       * Outputs: A promise for `/local/input.json`.
       * Does not handle: Path aliases or failures.
       * Side effects: None.
       */ async () => "/local/input.json",
      open: /**
       * Returns the deterministic fake descriptor.
       *
       * Inputs: Ignored path and flags.
       * Outputs: A promise for the enclosing handle double.
       * Does not handle: Open failures or multiple descriptors.
       * Side effects: None.
       */ async () => handle,
      stat: /**
       * Returns configured parent or path stat transitions for the requested fake path.
       *
       * Inputs: The canonical path queried by the bounded-read implementation.
       * Outputs: A promise for the next configured directory or file stat.
       * Does not handle: Unknown-path failures or real filesystem metadata.
       * Side effects: Increments enclosing base/path stat counters.
       */ async (path) => {
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
    closed: /**
     * Exposes whether the fake descriptor's close method has run.
     *
     * Inputs: None.
     * Outputs: The current private close flag.
     * Does not handle: Forcing closure or checking a real descriptor.
     * Side effects: None.
     */ () => closed,
  };
}
