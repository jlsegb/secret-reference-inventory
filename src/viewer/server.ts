import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  LocalReportViewer,
} from "./types.js";
import {
  resolveIssuedLocalReportViewerRequest,
  ViewerRequestError,
  type ViewerDocumentModel,
} from "./internal.js";

const LOOPBACK_HOST = "127.0.0.1" as const;

/**
 * Starts a self-contained viewer from an issued opaque request and binds it only to IPv4 loopback.
 *
 * Inputs: An opaque request previously issued by the local viewer builder.
 * Outputs: A frozen outer local-viewer handle with a frozen loopback address, mutable URL object, and idempotent close method. Mutating the URL object does not reconfigure the listener.
 * Does not handle: Reading repository paths, requesting remote data, accepting raw model objects, or launching a browser.
 * Side effects: Allocates randomness, opens an HTTP listener, and must be closed by the caller.
 */
export async function startLocalReportViewer(
  request: unknown,
): Promise<LocalReportViewer> {
  // This lookup is intentionally the first operation on caller input. It
  // checks only object identity, never a property, iterator, or proxy trap.
  const issued = resolveIssuedLocalReportViewerRequest(request);
  if (issued === undefined) {
    throw new ViewerRequestError("VIEWER_REQUEST_INVALID");
  }
  const model = issued.document;
  const port = issued.port;
  const nonce = randomBytes(16).toString("base64");
  const document = renderDocument(model, nonce);
  const server = createServer(
    /**
     * Serves the pre-rendered document for one accepted local HTTP request.
     *
     * Inputs: Node's incoming request and response objects.
     * Outputs: Nothing after the response helper sends a terminal response.
     * Does not handle: Request-body parsing, routing beyond root, or remote callers.
     * Side effects: Writes HTTP headers and body to the supplied response.
     */
    (request, response) => {
      serveDocument(request, response, document, nonce);
    }
  );

  server.on(
    "clientError",
    /**
     * Terminates malformed HTTP clients with a fixed response without inspecting their parser error.
     *
     * Inputs: Node's parser error, deliberately ignored, and the client socket.
     * Outputs: Nothing after ending the socket.
     * Does not handle: Logging malformed request details, retries, or protocol recovery.
     * Side effects: Writes a fixed 400 response and closes the supplied socket.
     */
    (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  );

  try {
    await listenOnLoopback(server, port);
  } catch {
    try {
      await closeServer(server);
    } catch {
      // The fixed error below is the only caller-visible bind failure.
    }
    throw new ViewerRequestError("VIEWER_BIND_FAILED");
  }
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST ||
    !Number.isSafeInteger(address.port)
  ) {
    await closeServer(server);
    throw new ViewerRequestError("VIEWER_BIND_FAILED");
  }

  let closed = false;
  return Object.freeze({
    address: Object.freeze({ host: LOOPBACK_HOST, port: address.port }),
    url: new URL("http://" + LOOPBACK_HOST + ":" + String(address.port) + "/"),
    /**
     * Closes this handle's server at most once, setting its terminal closed state before awaiting Node's close result.
     *
     * Inputs: None; the handle closes over its server and lifecycle flag.
     * Outputs: The first call resolves after server closure or rejects with its non-ignored close failure; every later call resolves immediately, including after that first failure.
     * Does not handle: Reopening the listener, aborting in-flight requests, swallowing close failures, or retrying a failed first close.
     * Side effects: Sets the closure's `closed` flag before awaiting `closeServer` and invokes the HTTP server close operation once.
     */
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server);
    },
  });
}

/**
 * Restricts HTTP handling to GET/HEAD requests for the root document and returns a fixed 404 otherwise.
 *
 * Inputs: A Node request/response pair plus pre-rendered document and nonce strings.
 * Outputs: Nothing after one HTTP response is sent.
 * Does not handle: Request bodies, assets, API routes, redirects, or host authorization.
 * Side effects: Writes response headers and a body to the supplied Node response.
 */
function serveDocument(
  request: IncomingMessage,
  response: ServerResponse,
  document: string,
  nonce: string,
): void {
  const rootRequest = request.url === "/" || request.url?.startsWith("/?") === true;
  if (!rootRequest || (request.method !== "GET" && request.method !== "HEAD")) {
    writeResponse(response, 404, "Not found.\n", nonce, "text/plain; charset=utf-8");
    return;
  }

  writeResponse(
    response,
    200,
    request.method === "HEAD" ? "" : document,
    nonce,
    "text/html; charset=utf-8",
    request.method === "HEAD" ? Buffer.byteLength(document) : undefined,
  );
}

/**
 * Writes one no-store security-headered HTTP response with an optional precomputed body length.
 *
 * Inputs: A Node response, status, body, nonce, content type, and optional byte length.
 * Outputs: Nothing after ending the response.
 * Does not handle: Streaming, compression, error recovery, or header negotiation.
 * Side effects: Calls writeHead and end on the supplied response.
 */
function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  nonce: string,
  contentType: string,
  contentLength?: number,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength ?? Buffer.byteLength(body)),
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'nonce-" + nonce + "'",
      "style-src 'nonce-" + nonce + "'",
      "connect-src 'none'",
      "img-src 'none'",
      "font-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

/**
 * Awaits one server listen outcome after constraining the host to the fixed loopback address.
 *
 * Inputs: An unstarted Node server and a validated numeric port.
 * Outputs: A promise resolving on listening or rejecting with Node's listen error.
 * Does not handle: Retrying ports, binding IPv6/all interfaces, or checking the post-listen address.
 * Side effects: Registers one-shot listeners and invokes server.listen.
 */
async function listenOnLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>(
    /**
     * Registers paired one-shot listen listeners and starts the server.
     *
     * Inputs: Promise resolve and reject callbacks.
     * Outputs: Nothing; completion is driven by the registered event callbacks.
     * Does not handle: Removing both listeners on process shutdown or retrying after an error.
     * Side effects: Registers server listeners and starts listening on fixed loopback.
     */
    (resolve, reject) => {
      const onError =
        /**
         * Rejects the listen promise and removes the success listener after a listen failure.
         *
         * Inputs: Node's listen error.
         * Outputs: Nothing after rejecting the enclosing promise.
         * Does not handle: Error translation, logging, or server cleanup.
         * Side effects: Removes one server listener and rejects the promise.
         */
        (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
        };
      const onListening =
        /**
         * Resolves the listen promise and removes the error listener after a successful bind.
         *
         * Inputs: None; invoked by Node's listening event.
         * Outputs: Nothing after resolving the enclosing promise.
         * Does not handle: Verifying the bound address or closing the server.
         * Side effects: Removes one server listener and resolves the promise.
         */
        (): void => {
      server.off("error", onError);
      resolve();
        };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: LOOPBACK_HOST, port });
    }
  );
}

/**
 * Awaits Node server closure while treating an already-stopped server as successfully closed.
 *
 * Inputs: A Node HTTP server.
 * Outputs: A promise resolving after close or rejecting with the original close error other than not-running.
 * Does not handle: Forcing active connections closed, re-listening, or suppressing genuine close failures.
 * Side effects: Invokes server.close and registers its completion callback.
 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(
    /**
     * Requests close and resolves/rejects the enclosing promise from Node's completion callback.
     *
     * Inputs: Promise resolve and reject callbacks.
     * Outputs: Nothing; completion follows the server close callback and rejects with its original non-ignored error.
 * Does not handle: Closing individual sockets, translating the original close error, or retrying a rejected close.
     * Side effects: Calls server.close.
     */
    (resolve, reject) => {
      server.close(
        /**
         * Classifies Node's close result, treating the documented not-running code as success.
         *
         * Inputs: An optional server-close error.
         * Outputs: Nothing after resolving or rejecting the enclosing promise with the original non-ignored error.
         * Does not handle: Retrying close or normalizing other error codes.
         * Side effects: Resolves or rejects the surrounding promise.
         */
        (error) => {
      if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
      } else {
        reject(error);
      }
        }
      );
    }
  );
}

/**
 * Places an issued viewer model and random nonce into the immutable local HTML template.
 *
 * Inputs: A frozen viewer document model and a nonce generated for this server instance.
 * Outputs: One complete HTML response body.
 * Does not handle: Validating model grammar, external template loading, or escaping beyond script serialization.
 * Side effects: Allocates the rendered HTML string.
 */
function renderDocument(model: ViewerDocumentModel, nonce: string): string {
  return DOCUMENT_TEMPLATE
    .replaceAll("__NONCE__", nonce)
    .replace("__MODEL__", serializeForScript(model));
}

/**
 * Serializes a vetted viewer model for an application/json script element while escaping HTML-sensitive characters.
 *
 * Inputs: A frozen viewer document model.
 * Outputs: JSON text with less-than, greater-than, ampersand, and line-separator characters escaped.
 * Does not handle: Accepting unvetted raw request objects or validating model scalar grammar.
 * Side effects: Allocates JSON and replacement strings.
 */
function serializeForScript(model: ViewerDocumentModel): string {
  return JSON.stringify(model)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

const DOCUMENT_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secret reference inventory</title>
  <style nonce="__NONCE__">
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #5b6475;
      --surface: #ffffff;
      --canvas: #f4f6fa;
      --border: #d6dbe5;
      --accent: #155eef;
      --accent-soft: #e8efff;
      --warning: #a15c00;
      --warning-soft: #fff4dc;
      --positive: #067647;
      --positive-soft: #e8f7ef;
      --focus: #7f56d9;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      min-width: 320px;
      margin: 0;
      background: var(--canvas);
      color: var(--ink);
      font-size: 16px;
      line-height: 1.5;
    }
    button { font: inherit; }
    button:focus-visible, .skip-link:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
    }
    .skip-link {
      position: fixed;
      top: 8px;
      left: 8px;
      z-index: 2;
      padding: 8px 16px;
      border-radius: 6px;
      transform: translateY(-160%);
      background: var(--ink);
      color: var(--surface);
    }
    .skip-link:focus { transform: translateY(0); }
    .shell {
      display: grid;
      min-height: 100vh;
      grid-template-columns: minmax(208px, 272px) minmax(0, 1fr);
    }
    .sidebar {
      padding: 24px 16px;
      border-right: 1px solid var(--border);
      background: var(--surface);
    }
    .brand {
      margin: 0 0 24px;
      font-size: 20px;
      line-height: 1.2;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .nav-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .nav-button, .result-button {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--ink);
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
    .nav-button:hover, .result-button:hover { background: var(--canvas); }
    .nav-button[aria-current="page"], .result-button[aria-current="true"] {
      border-color: #bdd0ff;
      background: var(--accent-soft);
      color: #103b9b;
      font-weight: 700;
    }
    main {
      width: min(100%, 1120px);
      margin: 0 auto;
      padding: 48px 32px 64px;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 32px;
    }
    h1 {
      margin: 0;
      font-size: clamp(24px, 4vw, 32px);
      line-height: 1.15;
    }
    .repository-label { color: var(--muted); }
    .content-grid {
      display: grid;
      align-items: start;
      gap: 24px;
      grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
    }
    .panel-heading {
      margin: 0;
      padding: 16px;
      border-bottom: 1px solid var(--border);
      font-size: 16px;
    }
    .result-list { padding: 8px; }
    .result-button {
      display: grid;
      gap: 4px;
      min-height: 52px;
    }
    .result-meta { color: var(--muted); font-size: 14px; }
    .detail { padding: 24px; }
    .detail h2 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
    .detail-summary { max-width: 66ch; margin: 0 0 24px; color: var(--muted); }
    .status {
      display: inline-block;
      margin-bottom: 24px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 700;
    }
    .status-positive { background: var(--positive-soft); color: var(--positive); }
    .status-warning { background: var(--warning-soft); color: var(--warning); }
    .facts {
      display: grid;
      gap: 0;
      margin: 0;
      border-top: 1px solid var(--border);
      grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    }
    .facts dt, .facts dd {
      min-width: 0;
      margin: 0;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      overflow-wrap: anywhere;
    }
    .facts dt { color: var(--muted); font-weight: 600; }
    .empty { max-width: 66ch; margin: 0; color: var(--muted); }
    @media (max-width: 640px) {
      .shell { display: block; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); }
      .nav-list { grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
      main { padding: 32px 16px 48px; }
      .content-grid, .facts { grid-template-columns: 1fr; }
      .facts dt { padding-bottom: 4px; border-bottom: 0; }
      .facts dd { padding-top: 4px; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#viewer-main">Skip to result</a>
  <div class="shell">
    <aside class="sidebar">
      <p class="eyebrow">Local viewer</p>
      <h2 class="brand">Secret reference inventory</h2>
      <nav aria-label="Repositories">
        <ul class="nav-list" id="repository-nav"></ul>
      </nav>
    </aside>
    <main id="viewer-main" tabindex="-1"><div id="viewer-content"></div></main>
  </div>
  <script id="viewer-model" type="application/json" nonce="__NONCE__">__MODEL__</script>
  <script nonce="__NONCE__">
    (/**
     * Initializes the isolated browser-side viewer.
     *
     * Inputs: The embedded JSON model and fixed document mount elements.
     * Outputs: No return value after registering local rendering helpers and painting the initial view.
     * Does not handle: Network requests, repository access, or arbitrary user data.
     * Side effects: Reads the embedded model and mutates the local document through rendering helpers.
     */ () => {
      const modelNode = document.getElementById("viewer-model");
      const model = JSON.parse(modelNode?.textContent || '{"repositories":[]}');
      const repositoryNav = document.getElementById("repository-nav");
      const content = document.getElementById("viewer-content");
      const state = { repositoryIndex: 0, resultIndex: 0 };

      const element = /**
       * Creates one document element for a local viewer row.
       *
       * Inputs: An element tag plus optional class name and text content.
       * Outputs: A newly created document element.
       * Does not handle: HTML parsing, arbitrary attribute assignment, or input validation.
       * Side effects: Allocates an element and may set its class name and text content.
       */ (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };

      const toneForDisposition = /**
       * Selects the display tone for a normalized result disposition.
       *
       * Inputs: One normalized result disposition.
       * Outputs: The warning tone for review or inconclusive and the positive tone otherwise.
       * Does not handle: Validating the disposition or selecting application state.
       * Side effects: None.
       */ (disposition) =>
        disposition === "inconclusive" || disposition === "review" ? "warning" : "positive";

      const renderRepositories = /**
       * Renders repository navigation from the current local selection state.
       *
       * Inputs: The parsed model, navigation mount, and mutable selection state.
       * Outputs: No return value after replacing the repository navigation content.
       * Does not handle: Rendering result panes or validating model records.
       * Side effects: Clears the navigation mount, appends buttons, and registers click listeners.
       */ () => {
        repositoryNav.replaceChildren();
        model.repositories.forEach(/**
         * Builds one repository navigation item at its model position.
         *
         * Inputs: A normalized repository record and its numeric model index.
         * Outputs: No return value after appending one navigation item to the mount.
         * Does not handle: Rendering result details or validating repository fields.
         * Side effects: Allocates document nodes and registers one click listener.
         */ (repository, index) => {
          const item = element("li");
          const button = element("button", "nav-button", repository.label);
          button.type = "button";
          button.setAttribute("aria-current", index === state.repositoryIndex ? "page" : "false");
          button.addEventListener("click", /**
           * Selects the captured repository and refreshes the local view.
           *
           * Inputs: The captured repository index; the click event argument is ignored.
           * Outputs: No return value after rendering the new repository selection.
           * Does not handle: Validating the repository index or fetching repository data.
           * Side effects: Mutates local selection state and replaces rendered document content.
           */ () => {
            state.repositoryIndex = index;
            state.resultIndex = 0;
            render();
          });
          item.append(button);
          repositoryNav.append(item);
        });
      };

      const renderResultList = /**
       * Builds the result-list panel for one selected repository.
       *
       * Inputs: A normalized repository record and the current local selection state.
       * Outputs: A panel element containing result buttons for the repository.
       * Does not handle: Rendering result detail or validating result records.
       * Side effects: Allocates document nodes and registers nested click listeners.
       */ (repository) => {
        const panel = element("section", "panel");
        const heading = element("h2", "panel-heading", "Results");
        const nav = element("nav");
        nav.setAttribute("aria-label", "Results");
        const list = element("div", "result-list");
        repository.results.forEach(/**
         * Builds one selectable result button at its repository position.
         *
         * Inputs: A normalized result record and its numeric repository index.
         * Outputs: No return value after appending one result button to the list.
         * Does not handle: Rendering the detail panel or validating result fields.
         * Side effects: Allocates document nodes and registers one click listener.
         */ (result, index) => {
          const button = element("button", "result-button");
          button.type = "button";
          button.setAttribute("aria-current", index === state.resultIndex ? "true" : "false");
          button.append(
            element("span", "", result.label),
            element("span", "result-meta", result.disposition),
          );
          button.addEventListener("click", /**
           * Selects the captured result and refreshes the local view.
           *
           * Inputs: The captured result index; the click event argument is ignored.
           * Outputs: No return value after rendering the new result selection.
           * Does not handle: Validating the result index or fetching result data.
           * Side effects: Mutates local selection state and replaces rendered document content.
           */ () => {
            state.resultIndex = index;
            render();
          });
          list.append(button);
        });
        nav.append(list);
        panel.append(heading, nav);
        return panel;
      };

      const renderDetail = /**
       * Builds the detail panel for one selected result.
       *
       * Inputs: A normalized selected result record.
       * Outputs: A panel element containing its label, disposition, summary, and facts.
       * Does not handle: Validating result fields or selecting another result.
       * Side effects: Allocates document nodes and appends fact elements.
       */ (result) => {
        const panel = element("section", "panel");
        const detail = element("div", "detail");
        detail.append(element("h2", "", result.label));
        detail.append(
          element(
            "span",
            "status status-" + toneForDisposition(result.disposition),
            result.disposition,
          ),
        );
        if (result.summary) detail.append(element("p", "detail-summary", result.summary));
        if (result.facts.length > 0) {
          const facts = element("dl", "facts");
          result.facts.forEach(/**
           * Appends one display-safe fact label and value pair to the detail list.
           *
           * Inputs: One normalized fact record from the selected result.
           * Outputs: No return value after appending its term and description nodes.
           * Does not handle: Validating fact text, choosing tones, or rendering other facts.
           * Side effects: Allocates and appends document nodes to the current fact list.
           */ (fact) => {
            facts.append(element("dt", "", fact.label), element("dd", "", fact.value));
          });
          detail.append(facts);
        }
        panel.append(detail);
        return panel;
      };

      const renderContent = /**
       * Renders the selected repository content or the local empty-state message.
       *
       * Inputs: The parsed model, content mount, mutable selection state, and rendering helpers.
       * Outputs: No return value after replacing the content mount with the current view.
       * Does not handle: Fetching data, validating model records, or changing selection state.
       * Side effects: Clears and appends document nodes in the content mount.
       */ () => {
        content.replaceChildren();
        const repository = model.repositories[state.repositoryIndex];
        if (!repository) {
          content.append(element("p", "empty", "No repository results are available to inspect."));
          return;
        }
        const header = element("header", "header");
        header.append(
          element("h1", "", repository.label),
          element(
            "span",
            "repository-label",
            repository.results.length + " result" + (repository.results.length === 1 ? "" : "s"),
          ),
        );
        content.append(header);
        if (repository.results.length === 0) {
          content.append(element("p", "empty", "This repository has no results to inspect."));
          return;
        }
        const selected = repository.results[state.resultIndex] || repository.results[0];
        const grid = element("div", "content-grid");
        grid.append(renderResultList(repository), renderDetail(selected));
        content.append(grid);
      };

      const render = /**
       * Refreshes repository navigation and selected content from local state.
       *
       * Inputs: The current local selection state and rendering helpers.
       * Outputs: No return value after both viewer regions are refreshed.
       * Does not handle: Loading data, validating model records, or changing selection state.
       * Side effects: Delegates document mutations and listener registration to rendering helpers.
       */ () => {
        renderRepositories();
        renderContent();
      };
      render();
    })();
  </script>
</body>
</html>`;
