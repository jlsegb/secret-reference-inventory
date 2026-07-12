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

test("viewer binds strictly to loopback on an ephemeral port", async (t) => {
  const viewer = await startLocalReportViewer(validRequest());
  t.after(() => viewer.close());

  assert.equal(viewer.address.host, "127.0.0.1");
  assert.equal(viewer.url.hostname, "127.0.0.1");
  assert.equal(viewer.url.port, String(viewer.address.port));
  assert.notEqual(viewer.address.port, 0);
  assert.equal((await request(viewer, "/")).status, 200);
});

test("viewer serves only a self-contained document with restrictive local headers", async (t) => {
  const viewer = await startLocalReportViewer(validRequest());
  t.after(() => viewer.close());

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

test("viewer renders only an app-issued snapshot and no request fields", async (t) => {
  const viewerRequest = validRequest();
  assert.deepEqual(Object.keys(viewerRequest), []);
  assert.equal(JSON.stringify(viewerRequest), "{}");

  const viewer = await startLocalReportViewer(viewerRequest);
  t.after(() => viewer.close());
  const response = await request(viewer, "/");
  assert.match(response.body, /"label":"payments"/u);
  assert.match(response.body, /"label":"worker"/u);
  assert.match(response.body, /env:DATABASE_URL/u);
  assert.match(response.body, /Dynamic: unbounded environment lookup/u);
  assert.match(response.body, /This reference has one known consumer group\./u);
  assert.match(response.body, /No environment key name is inferred for this lookup\./u);
});

test("viewer rejects forged raw requests without touching properties, maps, iterators, or species", async () => {
  const sentinel = "sk_live_VIEWER_REQUEST_TRAP_123456789";
  let topLevelReads = 0;
  let nestedReads = 0;
  const nested: unknown[] = [];
  Object.defineProperty(nested, "map", {
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, Symbol.iterator, {
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, "constructor", {
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(nested, Symbol.species, {
    get(): never {
      nestedReads += 1;
      throw new Error(sentinel);
    },
  });
  const forged = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(forged, "repositories", {
    get(): unknown {
      topLevelReads += 1;
      return nested;
    },
  });
  Object.defineProperty(forged, "model", {
    get(): never {
      topLevelReads += 1;
      throw new Error(sentinel);
    },
  });
  Object.defineProperty(forged, "port", {
    get(): never {
      topLevelReads += 1;
      throw new Error(sentinel);
    },
  });

  await assertFixedRequestRejection(forged, sentinel);
  assert.equal(topLevelReads, 0);
  assert.equal(nestedReads, 0);
});

test("viewer rejects Proxy and changing getter requests before any trap can expose data", async () => {
  const sentinel = "sk_live_PROXY_SENTINEL_123456789";
  let proxyReads = 0;
  const proxy = new Proxy(Object.create(null), {
    get(): never {
      proxyReads += 1;
      throw new Error(sentinel);
    },
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
    get(): unknown {
      getterReads += 1;
      return getterReads === 1 ? validRequest() : sentinel;
    },
  });
  await assertFixedRequestRejection(changing, sentinel);
  assert.equal(getterReads, 0);
});

test("internal builder rejects path-like and short credential-shaped identifiers and labels", () => {
  const sentinel = "env:sk_live_short";
  for (const operation of [
    () => appendLocalViewerRepository(createLocalViewerDocumentBuilder(), "/private/input", "safe"),
    () => appendLocalViewerRepository(createLocalViewerDocumentBuilder(), sentinel, "safe"),
    () => {
      const builder = createLocalViewerDocumentBuilder();
      const repository = appendLocalViewerRepository(builder, "safe", "safe");
      appendLocalViewerResult(repository, "safe-result", "/private/input", "informational", undefined);
    },
    () => {
      const builder = createLocalViewerDocumentBuilder();
      const repository = appendLocalViewerRepository(builder, "safe", "safe");
      appendLocalViewerResult(repository, "safe-result", sentinel, "informational", undefined);
    },
  ]) {
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof ViewerRequestError &&
        error.code === "VIEWER_REQUEST_INVALID" &&
        !error.message.includes("private") &&
        !error.message.includes("sk_live"),
    );
  }
});

test("internal builder rejects secret-like, path, and arbitrary short fact values before issuance", () => {
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
      () => appendLocalViewerFact(result, "References", value, "neutral"),
      (error: unknown) =>
        error instanceof ViewerRequestError &&
        error.code === "VIEWER_REQUEST_INVALID" &&
        !error.message.includes(value),
    );
  }
});

test("internal builder enforces limits before a viewer request can be issued", () => {
  const builder = createLocalViewerDocumentBuilder();
  for (let index = 0; index < 100; index += 1) {
    appendLocalViewerRepository(builder, "repository-" + String(index + 1), "repository-" + String(index + 1));
  }
  assert.throws(
    () => appendLocalViewerRepository(builder, "repository-101", "repository-101"),
    (error: unknown) =>
      error instanceof ViewerRequestError && error.code === "VIEWER_REPOSITORY_LIMIT_EXCEEDED",
  );
});

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

async function assertFixedRequestRejection(input: unknown, sentinel: string): Promise<void> {
  await assert.rejects(
    () => startLocalReportViewer(input),
    (error: unknown) =>
      error instanceof ViewerRequestError &&
      error.code === "VIEWER_REQUEST_INVALID" &&
      !error.message.includes(sentinel),
  );
}

async function request(
  viewer: LocalReportViewer,
  path: string,
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = get(new URL(path, viewer.url), (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
  });
}
