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
 * Starts a self-contained report viewer. The socket is deliberately bound to
 * IPv4 loopback and the process never opens repository paths or makes network
 * requests. Callers own the returned close lifecycle.
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
  const server = createServer((request, response) => {
    serveDocument(request, response, document, nonce);
  });

  server.on("clientError", (_error, socket) => {
    // Do not expose malformed request data or parser errors to terminal output.
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

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
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server);
    },
  });
}

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

async function listenOnLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function renderDocument(model: ViewerDocumentModel, nonce: string): string {
  return DOCUMENT_TEMPLATE
    .replaceAll("__NONCE__", nonce)
    .replace("__MODEL__", serializeForScript(model));
}

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
    (() => {
      const modelNode = document.getElementById("viewer-model");
      const model = JSON.parse(modelNode?.textContent || '{"repositories":[]}');
      const repositoryNav = document.getElementById("repository-nav");
      const content = document.getElementById("viewer-content");
      const state = { repositoryIndex: 0, resultIndex: 0 };

      const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };

      const toneForDisposition = (disposition) =>
        disposition === "inconclusive" || disposition === "review" ? "warning" : "positive";

      const renderRepositories = () => {
        repositoryNav.replaceChildren();
        model.repositories.forEach((repository, index) => {
          const item = element("li");
          const button = element("button", "nav-button", repository.label);
          button.type = "button";
          button.setAttribute("aria-current", index === state.repositoryIndex ? "page" : "false");
          button.addEventListener("click", () => {
            state.repositoryIndex = index;
            state.resultIndex = 0;
            render();
          });
          item.append(button);
          repositoryNav.append(item);
        });
      };

      const renderResultList = (repository) => {
        const panel = element("section", "panel");
        const heading = element("h2", "panel-heading", "Results");
        const nav = element("nav");
        nav.setAttribute("aria-label", "Results");
        const list = element("div", "result-list");
        repository.results.forEach((result, index) => {
          const button = element("button", "result-button");
          button.type = "button";
          button.setAttribute("aria-current", index === state.resultIndex ? "true" : "false");
          button.append(
            element("span", "", result.label),
            element("span", "result-meta", result.disposition),
          );
          button.addEventListener("click", () => {
            state.resultIndex = index;
            render();
          });
          list.append(button);
        });
        nav.append(list);
        panel.append(heading, nav);
        return panel;
      };

      const renderDetail = (result) => {
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
          result.facts.forEach((fact) => {
            facts.append(element("dt", "", fact.label), element("dd", "", fact.value));
          });
          detail.append(facts);
        }
        panel.append(detail);
        return panel;
      };

      const renderContent = () => {
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

      const render = () => {
        renderRepositories();
        renderContent();
      };
      render();
    })();
  </script>
</body>
</html>`;
