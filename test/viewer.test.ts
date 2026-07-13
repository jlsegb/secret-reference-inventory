import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import {
  appendLocalViewerFact,
  appendLocalViewerRepository,
  appendLocalViewerResult,
  createLocalViewerDocumentBuilder,
  issueLocalReportViewerRequest,
  ViewerRequestError,
} from "../src/viewer/internal.js";
import {
  startLocalReportViewer,
  type LocalReportViewer,
  type LocalReportViewerRequest,
} from "../src/viewer/index.js";

test("viewer binds strictly to loopback on an ephemeral port",
  /**
   * Verifies an issued request starts a reachable IPv4-loopback server on an assigned port.
   *
   * Inputs: Node's async test context and a valid opaque viewer request.
   * Outputs: Assertions over address, URL, and root response status.
   * Does not handle: Browser launch or non-loopback listener behavior.
   * Side effects: Opens a local HTTP server and registers a cleanup hook.
   */
  async (t) => {
  const viewer = await startLocalReportViewer(validRequest());
  t.after(
    /**
     * Closes the local viewer after this test completes.
     *
     * Inputs: None; invoked by the Node test lifecycle.
     * Outputs: The viewer close promise.
     * Does not handle: Assertion failures from the test body.
     * Side effects: Closes the test HTTP listener.
     */
    () => viewer.close()
  );

  assert.equal(viewer.address.host, "127.0.0.1");
  assert.equal(viewer.url.hostname, "127.0.0.1");
  assert.equal(viewer.url.port, String(viewer.address.port));
  assert.notEqual(viewer.address.port, 0);
  assert.equal((await request(viewer, "/")).status, 200);
});

test("viewer serves only a self-contained document with restrictive local headers",
  /**
   * Verifies the root response has local-only security headers and traversal-like paths receive fixed 404s.
   *
   * Inputs: Node's async test context and a valid opaque request.
   * Outputs: Assertions over headers, HTML text, and rejected route behavior.
   * Does not handle: Browser CSP enforcement or arbitrary HTTP method testing.
   * Side effects: Opens a local HTTP server, makes loopback requests, and registers cleanup.
   */
  async (t) => {
  const viewer = await startLocalReportViewer(validRequest());
  t.after(
    /**
     * Closes the local viewer after header assertions complete.
     *
     * Inputs: None; invoked by the Node test lifecycle.
     * Outputs: The viewer close promise.
     * Does not handle: Retrying close failures.
     * Side effects: Closes the test HTTP listener.
     */
    () => viewer.close()
  );

  const response = await request(viewer, "/");
  const csp = response.headers["content-security-policy"];
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(typeof csp, "string");
  if (typeof csp !== "string") {
    throw new Error("Expected a string CSP header");
  }
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(response.body, /https?:\/\//u);
  assert.match(response.body, /aria-label="Repositories"/u);
  assert.match(response.body, /nav\.setAttribute\("aria-label", "Results"\)/u);

  const rejected = await request(viewer, "/../../etc/passwd");
  assert.equal(rejected.status, 404);
  assert.doesNotMatch(rejected.body, /etc\/passwd/u);
});

test("viewer renders only an app-issued snapshot and no request fields",
  /**
   * Verifies the opaque request has no public fields while its issued snapshot renders approved content.
   *
   * Inputs: Node's async test context and a locally issued request.
   * Outputs: Assertions over token shape and response content.
   * Does not handle: Forged-request safety or HTML semantic completeness.
   * Side effects: Opens a local HTTP server, requests it, and registers cleanup.
   */
  async (t) => {
  const viewerRequest = validRequest();
  assert.deepEqual(Object.keys(viewerRequest), []);
  assert.equal(JSON.stringify(viewerRequest), "{}");

  const viewer = await startLocalReportViewer(viewerRequest);
  t.after(
    /**
     * Closes the local viewer after snapshot-render assertions.
     *
     * Inputs: None; invoked by the Node test lifecycle.
     * Outputs: The viewer close promise.
     * Does not handle: Waiting for unrelated network activity.
     * Side effects: Closes the test HTTP listener.
     */
    () => viewer.close()
  );
  const response = await request(viewer, "/");
  assert.match(response.body, /"label":"payments"/u);
  assert.match(response.body, /"label":"worker"/u);
  assert.match(response.body, /env:DATABASE_URL/u);
  assert.match(response.body, /Dynamic: unbounded environment lookup/u);
  assert.match(response.body, /This reference has one known consumer group\./u);
  assert.match(response.body, /No environment key name is inferred for this lookup\./u);
});

test("viewer rejects forged raw requests without touching properties, maps, iterators, or species",
  /**
   * Verifies identity rejection does not activate property, collection, or species getters on a forged request.
   *
   * Inputs: Node's async test runner and a getter-instrumented forged object.
   * Outputs: Assertions over fixed rejection and zero getter reads.
   * Does not handle: Proxy-trap rejection, which has a separate test.
   * Side effects: Defines hostile test getters, starts no successful server, and performs assertions.
   */
  async () => {
  const sentinel = "sk_live_VIEWER_REQUEST_TRAP_123456789";
  let topLevelReads = 0;
  let nestedReads = 0;
  const nested: unknown[] = [];
  Object.defineProperty(nested, "map", {
    /**
     * Counts and fails if the forged array's map accessor is touched.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying an Array map method.
     * Side effects: Increments nested-read count and throws a sentinel error.
     */
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, Symbol.iterator, {
    /**
     * Counts and fails if the forged array iterator accessor is touched.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying an iterator.
     * Side effects: Increments nested-read count and throws a sentinel error.
     */
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, "constructor", {
    /**
     * Counts and fails if the forged array constructor accessor is touched.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying a constructor.
     * Side effects: Increments nested-read count and throws a sentinel error.
     */
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, Symbol.species, {
    /**
     * Counts and fails if the forged array species accessor is touched.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Supplying a species constructor.
     * Side effects: Increments nested-read count and throws a sentinel error.
     */
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  const forged = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(forged, "repositories", {
    /**
     * Counts access to a forged repositories property and returns the hostile nested value if read.
     *
     * Inputs: None; invoked by property access.
     * Outputs: The hostile nested array when incorrectly accessed.
     * Does not handle: Providing an authentic issued document.
     * Side effects: Increments top-level-read count.
     */
    get(): unknown {
      topLevelReads += 1;
      return nested;
    },
  });
  Object.defineProperty(forged, "model", {
    /**
     * Counts and fails if a forged model property is accessed.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Providing a model.
     * Side effects: Increments top-level-read count and throws a sentinel error.
     */
    get(): never {
      topLevelReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(forged, "port", {
    /**
     * Counts and fails if a forged port property is accessed.
     *
     * Inputs: None; invoked by property access.
     * Outputs: Never returns because it throws.
     * Does not handle: Providing a port.
     * Side effects: Increments top-level-read count and throws a sentinel error.
     */
    get(): never {
      topLevelReads += 1;
      throw new Error(sentinel);
    },
  });

  await assertFixedRequestRejection(forged, sentinel);
  assert.equal(topLevelReads, 0);
  assert.equal(nestedReads, 0);
});

test("viewer rejects Proxy and changing getter requests before any trap can expose data",
  /**
   * Verifies identity rejection does not trigger proxy traps or a changing request getter.
   *
   * Inputs: Node's async test runner plus proxy and getter-instrumented forged requests.
   * Outputs: Assertions over fixed rejection and zero trap/getter reads.
   * Does not handle: Valid issued-request rendering.
   * Side effects: Creates hostile test objects and performs async rejection assertions.
   */
  async () => {
  const sentinel = "sk_live_PROXY_SENTINEL_123456789";
  let proxyReads = 0;
  const proxy = new Proxy(Object.create(null), {
    /**
     * Fails if any property get trap is invoked during forged-request rejection.
     *
     * Inputs: Proxy trap arguments, intentionally ignored.
     * Outputs: Never returns because it throws.
     * Does not handle: Simulating a successful property read.
     * Side effects: Increments proxy-read count and throws a sentinel error.
     */
    get(): never {
      proxyReads += 1;
      throw new Error(sentinel);
    },
    /**
     * Fails if prototype inspection is attempted during forged-request rejection.
     *
     * Inputs: Proxy trap arguments, intentionally ignored.
     * Outputs: Never returns because it throws.
     * Does not handle: Returning a prototype.
     * Side effects: Increments proxy-read count and throws a sentinel error.
     */
    getPrototypeOf(): never {
      proxyReads += 1;
      throw new Error(sentinel);
    },
  });
  await assertFixedRequestRejection(proxy, sentinel);
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const changing = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(changing, "request", {
    /**
     * Counts an invalid changing request getter and would reveal differing values if accessed.
     *
     * Inputs: None; invoked by property access.
     * Outputs: A valid request on first read and sentinel text thereafter.
     * Does not handle: Issuing a stable request token.
     * Side effects: Increments getter-read count and may allocate a valid request.
     */
    get(): unknown {
      getterReads += 1;
      return getterReads === 1 ? validRequest() : sentinel;
    },
  });
  await assertFixedRequestRejection(changing, sentinel);
  assert.equal(getterReads, 0);
});

test("internal builder rejects path-like and short credential-shaped identifiers and labels",
  /**
   * Verifies identifier and label grammar rejects path-like and short credential-shaped text without echoing it.
   *
   * Inputs: Node's test runner and a local list of invalid builder operations.
   * Outputs: Assertions that each operation throws the fixed invalid-request error.
   * Does not handle: Valid label acceptance or fact-value validation.
   * Side effects: Creates short-lived opaque builders and performs assertions.
   */
  () => {
  const sentinel = "env:sk_live_short";
  for (const operation of [
    /**
     * Attempts to create a repository with a forbidden path-like identifier.
     *
     * Inputs: None.
     * Outputs: Never returns when the builder rejects the identifier.
     * Does not handle: Valid repository construction.
     * Side effects: Creates an opaque builder before throwing.
     */
    () => appendLocalViewerRepository(createLocalViewerDocumentBuilder(), "/private/input", "safe"),
    /**
     * Attempts to create a repository with a credential-shaped identifier.
     *
     * Inputs: None.
     * Outputs: Never returns when the builder rejects the identifier.
     * Does not handle: Valid repository construction.
     * Side effects: Creates an opaque builder before throwing.
     */
    () => appendLocalViewerRepository(createLocalViewerDocumentBuilder(), sentinel, "safe"),
    /**
     * Attempts to append a result with a forbidden path-like label.
     *
     * Inputs: None.
     * Outputs: Never returns when the builder rejects the label.
     * Does not handle: Valid result construction.
     * Side effects: Creates a builder and repository before throwing.
     */
    () => {
      const builder = createLocalViewerDocumentBuilder();
      const repository = appendLocalViewerRepository(builder, "safe", "safe");
      appendLocalViewerResult(repository, "safe-result", "/private/input", "informational", undefined);
    },
    /**
     * Attempts to append a result with a credential-shaped label.
     *
     * Inputs: None.
     * Outputs: Never returns when the builder rejects the label.
     * Does not handle: Valid result construction.
     * Side effects: Creates a builder and repository before throwing.
     */
    () => {
      const builder = createLocalViewerDocumentBuilder();
      const repository = appendLocalViewerRepository(builder, "safe", "safe");
      appendLocalViewerResult(repository, "safe-result", sentinel, "informational", undefined);
    },
  ]) {
    assert.throws(
      operation,
      /**
       * Matches the fixed error while asserting neither path nor credential fragment leaks in its message.
       *
       * Inputs: One thrown value from an invalid builder operation.
       * Outputs: True only for the expected safe invalid-request error.
       * Does not handle: Comparing stack traces or arbitrary error classes.
       * Side effects: Reads the fixed error message for leak assertions.
       */
      (error: unknown) =>
        error instanceof ViewerRequestError &&
        error.code === "VIEWER_REQUEST_INVALID" &&
        !error.message.includes("private") &&
        !error.message.includes("sk_live"),
    );
  }
});

test("internal builder rejects secret-like, path, and arbitrary short fact values before issuance",
  /**
   * Verifies fact values outside the closed display grammar are rejected before issuance without message leakage.
   *
   * Inputs: Node's test runner and a list of secret-like, path-like, and arbitrary values.
   * Outputs: Assertions that every fact append throws the fixed invalid-request error.
   * Does not handle: Positive fact grammar cases.
   * Side effects: Creates test builders and performs assertions.
   */
  () => {
  const sentinel = "sk_live_51Jf2QfZxR3AqVbC8NwY";
  for (const value of [sentinel, "sk_live_short", "/private/input.json", "hunter2"]) {
    const builder = createLocalViewerDocumentBuilder();
    const repository = appendLocalViewerRepository(builder, "safe", "safe");
    const result = appendLocalViewerResult(
      repository,
      "safe-overview",
      "Overview",
      "informational",
      undefined,
    );
    assert.throws(
      /**
       * Attempts one fact append with the current forbidden value.
       *
       * Inputs: None; closes over the prepared result slot and current value.
       * Outputs: Never returns when the builder rejects the value.
       * Does not handle: Appending an allowed count.
       * Side effects: Invokes the builder's validation path.
       */
      () => appendLocalViewerFact(result, "References", value, "neutral"),
      /**
       * Matches the fixed error while ensuring the current rejected value is absent from its message.
       *
       * Inputs: One thrown value from the fact append.
       * Outputs: True only for a safe invalid-request error.
       * Does not handle: Stack inspection or value redaction itself.
       * Side effects: Reads the fixed error message for assertions.
       */
      (error: unknown) =>
        error instanceof ViewerRequestError &&
        error.code === "VIEWER_REQUEST_INVALID" &&
        !error.message.includes(value),
    );
  }
});

test("internal builder enforces limits before a viewer request can be issued",
  /**
   * Verifies the repository cardinality limit rejects the 101st append before request issuance.
   *
   * Inputs: Node's test runner and an active builder.
   * Outputs: Assertions over the fixed repository-limit error.
   * Does not handle: Result or fact cardinality limits.
   * Side effects: Mutates a private builder with one hundred repository rows.
   */
  () => {
  const builder = createLocalViewerDocumentBuilder();
  for (let index = 0; index < 100; index += 1) {
    appendLocalViewerRepository(builder, "repository-" + String(index + 1), "repository-" + String(index + 1));
  }
  assert.throws(
    /**
     * Attempts the repository append that exceeds the configured limit.
     *
     * Inputs: None; closes over the already-full builder.
     * Outputs: Never returns when the builder enforces the limit.
     * Does not handle: Issuing the request.
     * Side effects: Invokes the builder's limit check.
     */
    () => appendLocalViewerRepository(builder, "repository-101", "repository-101"),
    /**
     * Matches the fixed repository-limit error.
     *
     * Inputs: One thrown value from the over-limit append.
     * Outputs: True only for the expected viewer error code.
     * Does not handle: Other limit codes or arbitrary errors.
     * Side effects: None.
     */
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED",
  );
});

/**
 * Builds the representative app-issued viewer request used by successful-server tests.
 *
 * Inputs: None.
 * Outputs: An opaque issued request containing safe sample repositories, results, and facts.
 * Does not handle: Custom request data, raw model construction, or remote viewer startup.
 * Side effects: Allocates builder state, slots, model copies, and a request WeakMap entry.
 */
function validRequest(): LocalReportViewerRequest {
  const builder = createLocalViewerDocumentBuilder();
  const payments = appendLocalViewerRepository(builder, "payments", "payments");
  const overview = appendLocalViewerResult(
    payments,
    "payments-overview",
    "Overview",
    "informational",
    "This repository finished with complete scoped coverage.",
  );
  appendLocalViewerFact(overview, "State", "complete", "positive");
  appendLocalViewerFact(overview, "References", "1", "neutral");
  const database = appendLocalViewerResult(
    payments,
    "payments-database-url",
    "env:DATABASE_URL",
    "review",
    "This reference has one known consumer group.",
  );
  appendLocalViewerFact(database, "Consumers", "1", "neutral");
  appendLocalViewerFact(database, "Findings", "1", "positive");
  const worker = appendLocalViewerRepository(builder, "worker", "worker");
  appendLocalViewerResult(
    worker,
    "worker-dynamic-key",
    "Dynamic: unbounded environment lookup",
    "inconclusive",
    "No environment key name is inferred for this lookup.",
  );
  return issueLocalReportViewerRequest(builder, 0);
}

/**
 * Asserts a forged request is rejected with the fixed error without copying a supplied sentinel into the message.
 *
 * Inputs: An arbitrary forged request and a sentinel expected to remain absent from the error message.
 * Outputs: A promise resolving after the rejection assertion succeeds.
 * Does not handle: Successful request startup or assertions about getter/trap counters.
 * Side effects: Invokes the local viewer start function and performs an async assertion.
 */
async function assertFixedRequestRejection(input: unknown, sentinel: string): Promise<void> {
  await assert.rejects(
    /**
     * Starts the viewer with the forged value to obtain the expected rejection.
     *
     * Inputs: None; closes over the forged request.
     * Outputs: The viewer-start promise, expected to reject.
     * Does not handle: Closing a successful viewer because success is invalid for this helper.
     * Side effects: Invokes the viewer startup boundary.
     */
    () => startLocalReportViewer(input),
    /**
     * Matches the fixed invalid-request error and checks it does not include the sentinel.
     *
     * Inputs: One rejection reason.
     * Outputs: True only for the fixed safe viewer error.
     * Does not handle: Asserting trap counters or original error causes.
     * Side effects: Reads the fixed error message for a leak assertion.
     */
    (error: unknown) =>
      error instanceof ViewerRequestError &&
      error.code === "VIEWER_REQUEST_INVALID" &&
      !error.message.includes(sentinel),
  );
}

/**
 * Makes one HTTP GET resolved from a supplied path or URL and collects its full response for server assertions.
 *
 * Inputs: A running local viewer and a URL reference resolved with `new URL(reference, viewer.url)`; an absolute or protocol-relative (`//`) reference can replace the viewer host.
 * Outputs: A promise for numeric status, Node headers, and UTF-8 response body.
 * Does not handle: Restricting the resolved host to loopback, redirects, request bodies, timeouts, or streaming partial results.
 * Side effects: Opens one HTTP client request to the resolved target and buffers its response body in memory.
 */
async function request(
  viewer: LocalReportViewer,
  path: string,
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}> {
  return new Promise(
    /**
     * Starts the resolved request target and wires response/error events into the promise.
     *
     * Inputs: Promise resolve and reject callbacks.
     * Outputs: Nothing; completion is controlled by client and response events.
     * Does not handle: Cancellation, timeouts, redirects, or response decompression.
     * Side effects: Opens an HTTP request and attaches event listeners.
     */
    (resolve, reject) => {
      const request = get(
        new URL(path, viewer.url),
        /**
         * Buffers one HTTP response until its end event produces the helper result.
         *
         * Inputs: Node's incoming response stream.
         * Outputs: Nothing until response events resolve or reject the enclosing promise.
         * Does not handle: Status validation, body-size limits, or non-UTF-8 decoding.
         * Side effects: Attaches stream listeners and stores received chunks.
         */
        (response) => {
      const chunks: Buffer[] = [];
      response.on(
        "data",
        /**
         * Collects one response body buffer chunk in arrival order.
         *
         * Inputs: A Node buffer emitted by the response stream.
         * Outputs: The new chunk-array length.
         * Does not handle: Parsing or size-limiting the chunk data.
         * Side effects: Mutates the local chunks array.
         */
        (chunk: Buffer) => chunks.push(chunk)
      );
      response.on("error", reject);
      response.on(
        "end",
        /**
         * Resolves the helper with the concatenated response after the stream ends.
         *
         * Inputs: None; invoked by the response end event.
         * Outputs: Nothing after resolving the enclosing promise.
         * Does not handle: Response status policy or malformed text recovery.
         * Side effects: Concatenates buffered chunks and resolves the promise.
         */
        () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        }
      );
        }
      );
    request.on("error", reject);
    }
  );
}
