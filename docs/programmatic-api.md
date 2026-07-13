# Programmatic API

The package is ESM and requires Node.js 24 or newer. This page lists the entry
points exported by the current package manifest. Import only these paths;
`src/`, `dist/` deep paths, application composition, binding adapters, Core,
and reporters are implementation details even when they exist in a source
checkout.

The package is currently pre-1.0. Treat exported contracts as versioned
package API and pin an appropriate version range in consuming tools.

## Published entry points

| Import | Exports | Intended use |
| --- | --- | --- |
| `secret-reference-inventory` | CLI parser/runner types and functions | Same surface as `./cli`. |
| `secret-reference-inventory/cli` | `parseCli`, `runCli`, `HELP_TEXT`, command/handler/I/O types | Embed or test command parsing and dispatch. |
| `secret-reference-inventory/discovery` | Discovery contracts, `PathGuard`, `discoverSources` | Discover a bounded set of local first-party source files. |
| `secret-reference-inventory/safety` | Safety brands, `SafeFactFactory`, provisioning-budget helpers | Build/report only sanitized identifiers and facts. |
| `secret-reference-inventory/workspace` | Workspace contracts, parser, runtime, request types | Parse and run an application-issued workspace scan flow. |
| `secret-reference-inventory/viewer` | `startLocalReportViewer` and viewer types | Start an already-issued loopback viewer request. |

The `main` and `types` fields point to the CLI surface. `secret-usage` is the
binary entry point.

## CLI module

```ts
import { parseCli, runCli, type CliHandlers } from "secret-reference-inventory/cli";

const parsed = parseCli(["scan", "./example-repository"]);
if (parsed.ok) {
  // Supply only local handlers appropriate for the embedding application.
  const handlers: CliHandlers = {};
  const status = await runCli(["--help"], handlers);
  void status;
}
```

`parseCli(argv)` only parses bounded command-line text. It does not open paths,
load manifests, write output, start a viewer, or print input. Its result is a
discriminated `CliParseResult` with either a command or fixed `CliErrorCode`.

`runCli(argv, handlers?, io?)` parses, emits help/errors through the supplied
I/O callbacks, and dispatches to a handler for the parsed command. It returns
a process-style numeric status. The default I/O writes to stdout/stderr; an
embedding can provide its own callbacks. The CLI module does not itself create
the local analysis handlers—those remain app composition details.

## Discovery module

`discoverSources(options, safety?)` resolves explicit roots and returns a
bounded `DiscoveryResult`: approved roots, discovered source files, skips,
total bytes, and a budget-exhausted flag. It does not execute or parse the
discovered source files. `SourceDiscoveryOptions` allows explicit roots,
extensions, a partial budget, and an ignore-file name.

`PathGuard` and the associated `ApprovedRoot`, `GuardedPath`, and `InternalPath`
contracts are lower-level utilities for containment-aware local discovery.
Canonical paths are intentionally internal data; do not serialize them or pass
them into a reporting layer.

## Safety module

`SafeFactFactory` is the boundary for turning untrusted source or local-input
strings into reportable identifiers, locations, paths, diagnostics, Core facts,
and provisioning facts. A failed identifier materialization becomes a fixed
opaque result rather than an escaped raw string.

The module also exports provisioning-budget helpers and constants used by
value-free provisioning parsers. They are useful for adapters that must bound
repository-controlled structural input before producing normalized facts. They
do not validate a provider configuration or retrieve a value.

Consumers should keep raw source and provider data on their side of this
boundary, and pass only validated facts to reporting-oriented code.

## Workspace module

`parseWorkspaceManifestText(text)` accepts JSON or JSONC text and returns a
versioned, token-backed `WorkspaceManifestParseResult`. The result does not
authorize a caller to replace its paths or construct an equivalent object: the
runtime flow verifies parser-issued identity and local read provenance.

`scanWorkspace(request)` runs a verified workspace request and returns a
repository- and deployment-partitioned `WorkspaceScanResult`. It does not take
arbitrary JavaScript configuration objects or paths. The helper
`createLocalWorkspaceScanPort()` exposes the same local scan operation through
the narrow application port.

The request/token types are intentionally issuance-only. A consumer that needs
the full CLI experience should use the binary rather than trying to construct
a workspace request from public fields.

## Viewer module

`startLocalReportViewer(request)` accepts only an application-issued
`LocalReportViewerRequest`; it rejects object literals, deserialized values,
and forged/proxy-shaped requests before dereferencing them. On success it
returns a `LocalReportViewer` with a loopback URL, address, and `close()`.

The public module intentionally does not export a request constructor or a way
to supply arbitrary report data. This makes the standalone viewer export useful
to the internal application composition boundary, while preventing a consumer
from turning it into an arbitrary local file server.

## Compatibility and boundaries

- Package exports are ESM-only.
- Imports outside the table above are not supported API.
- The API performs local parsing and bounded filesystem work only; it does not
  contact providers, resolve runtime configuration, or execute user code.
- Returned result types are static evidence. Preserve their coverage, dynamic,
  and reason fields when presenting results; do not collapse them into a
  deletion or authorization decision.

For command behavior and schemas, use the [CLI reference](cli.md) and
[workspace reference](workspaces.md). For status semantics, use the
[evidence model](evidence-model.md).
