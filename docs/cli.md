# CLI reference

This reference describes the current `secret-usage` command. All filesystem
inputs are local paths selected by the caller. The command never sends source,
reports, identifiers, or input-document contents to a service.

## Installation and distribution status

The source checkout is the supported workflow. Node.js 24 or newer is required.

```sh
git clone https://github.com/jlsegb/secret-reference-inventory.git
cd secret-reference-inventory
npm ci
npm run build
node ./dist/cli/bin.js scan ./example-repository
```

The package can be inspected with `npm pack --dry-run --ignore-scripts`, but
archive installation is not currently a supported distribution path. The
release smoke assertion still expects a workspace report v1 while the runtime
emits v2, so installed-archive validation is blocked. The package bundles its
runtime dependencies, but that fact does not make archive installation
verified. It has not been published to the npm registry, so a registry-install
command is intentionally not documented as a current workflow.

The command signatures below use the conventional `secret-usage` spelling to
name the CLI. It is not a currently supported installation route; in a source
checkout use `node ./dist/cli/bin.js` instead.

## Commands

### `scan`

```text
secret-usage scan <root> [--format terminal|json|sarif] [--out <path>] [--require-complete]
```

Scans one explicit first-party root. The default format is `terminal`; `json`
uses `secret-reference-inventory/report/v1`, and `sarif` uses SARIF 2.1.0.
When `--out` is supplied, the report is written as UTF-8. For a newly created
target, the CLI requests owner-only (`0600`) permissions where the platform
honors them; overwriting an existing file does not tighten that file's existing
permissions. Otherwise the report is written to stdout.

```sh
secret-usage scan ./example-repository --format json --out report.json
secret-usage scan ./example-repository --require-complete
```

`--require-complete` returns exit status 2 if relevant source coverage is
incomplete. It does not add files to the scan or change a review finding into a
runtime assertion.

### `reconcile`

```text
secret-usage reconcile (--root <root> | --scan-report <file>) \
  --inventory <file> --bindings <file> \
  [--closed-model <file> --verification-base <absolute-directory>] \
  [--format terminal|json|sarif] [--out <path>] [--require-complete]
```

Reconciliation scans the selected root and compares its static demand with two
local, value-free documents:

- a `binding-manifest/v1` document; and
- an `inventory-snapshot/v1` document.

`--closed-model` is optional. When used, it must be accompanied by an absolute
`--verification-base`; the CLI does not infer this authority from the current
working directory. The closed model is an explicit scope contract, not a claim
that a provider delivered a secret or that no other system uses a resource.

Although the parser accepts `--scan-report` as the mutually exclusive input
form, report rehydration is not implemented in this version. Use `--root` for
working reconciliation.

```sh
secret-usage reconcile --root ./example-repository \
  --bindings ./control/bindings.json \
  --inventory ./control/inventory.json \
  --closed-model ./control/closed-model.json \
  --verification-base "$(pwd)/control" \
  --format json --out reconciliation.json --require-complete
```

### `explain`

```text
secret-usage explain <env:KEY|dynamic:ID> --scan-report <file> [--out <path>]
```

Explains a safe selector from a previously rendered single-repository JSON
report. It re-validates the report before display and emits terminal text only.
The report must be supplied explicitly; the command does not scan or infer a
report path. The current parser accepts `--format`, but `explain` ignores it as
a renderer choice: explain remains terminal-only, and a non-terminal format is
rejected by the handler with `APP_EXPLAIN_FORMAT_UNSUPPORTED`.

```sh
secret-usage explain env:PAYMENTS_API_TOKEN --scan-report report.json
```

### `workspace scan`

```text
secret-usage workspace scan --manifest <file> \
  [--format terminal|json] [--out <path>] [--require-complete]
```

Scans an explicit JSON or JSONC workspace manifest. Its JSON report schema is
`secret-reference-inventory/workspace-report/v2`; workspace SARIF is not
available. Read [Workspace manifests and reports](workspaces.md) before using
this command with provisioning inputs.

```sh
secret-usage workspace scan --manifest ./control/workspace.jsonc \
  --format json --out workspace-report.json --require-complete
```

### `ui`

```text
secret-usage ui --manifest <file> [--port <0-65535>] [--require-complete]
```

Builds the same derived workspace report and serves it only at
`http://127.0.0.1:<port>/`. Omit `--port`, or use `--port 0`, to request an
ephemeral port. The process remains available until it is interrupted, and the
command prints the loopback URL to stdout.

The viewer has no repository picker and cannot scan paths selected by a
browser. It receives a derived display model, not source text, raw manifest
data, canonical filesystem paths, or input-document contents. Its page uses
no external assets or browser-side network connections.

`ui` does not accept `--format` or `--out`. With `--require-complete`, it does
not start when the workspace result is incomplete or invalid.

## Exit behavior and errors

| Status | Meaning |
| --- | --- |
| `0` | Command completed; without `--require-complete`, the report may still contain scoped incomplete evidence. |
| `2` | `--require-complete` found incomplete coverage, or a workspace result is invalid. |
| `64` | Invalid command line, unsupported command option, or an unavailable command form. |
| `65` | Invalid local workspace input or invalid closed-model verification base. |
| `70` | Analysis, local I/O, output, viewer, or internal operation failure. |

Failures are emitted as fixed codes rather than echoing source, input paths,
parser messages, or values. Treat a fixed error code as an operational signal,
not as evidence that a key is unused.

## Supported source scope

The scanner considers first-party `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, and `.cjs` files below the selected root. It uses a syntax-only
TypeScript Compiler API backend. It does not construct a TypeScript Program,
resolve modules, execute code, read environment values, load dotenv files, or
run repository/package scripts.

Direct reads, aliases, destructuring, safely constant-folded keys, and bounded
dynamic expressions are handled conservatively. `process.env[key]`-style
access with an unknown or user-controlled key becomes scoped uncertainty; the
tool reports likely keys only when static analysis proves a finite or safely
constrained domain. The details and consequences for reconciliation are in the
[evidence model](evidence-model.md#dynamic-access).
