# Secret Reference Inventory

Secret Reference Inventory is a local static-analysis tool for identifying the
logical configuration and secret keys that first-party TypeScript and
JavaScript code reads. It records references such as `env:PAYMENTS_API_TOKEN`;
it is not a secret scanner and does not report secret values.

Its central use is cleanup triage: compare static code demand with local,
value-free binding and inventory exports to identify resources worth reviewing.
An inventory item without compatible static demand is a review signal, never a
deletion instruction.

## What it does—and does not prove

- Scans only the selected first-party repository roots. Dependencies and
  outside-root imports are intentionally excluded from code demand.
- Recognizes direct and safely constant-folded environment reads, and records
  dynamic lookups as finite, pattern, or unbounded uncertainty.
- Optionally reconciles those reads with local binding and inventory documents.
- Keeps repositories distinct in workspace reports; a shared key means shared
  static demand in an explicit deployment, not shared delivery or value.
- Never executes repository code, scripts, build steps, plugins, IaC, or shell
  commands. It parses source and JSON/JSONC data only.
- Makes no runtime network requests and includes no telemetry, analytics,
  accounts, or service integration. Acquiring dependencies or cloning the
  repository is separate from running the tool.

Static evidence is not runtime proof. A declared mapping does not demonstrate
that a platform delivered a value, that a role can read it, or that a code path
executed. See [the evidence model](docs/evidence-model.md) for the exact
meaning of each conclusion.

## Quick start

Node.js 24 or newer is required.

The supported development/source path is:

```sh
git clone https://github.com/jlsegb/secret-reference-inventory.git
cd secret-reference-inventory
npm ci
npm run build
node ./dist/cli/bin.js scan ./example-repository --require-complete
```

After the project is built, use `node ./dist/cli/bin.js` for the supported
source-checkout workflow. Archive installation is not yet a supported
distribution path: release smoke validation is currently blocked because its
assertion expects a workspace report v1 while the runtime emits v2. Registry
publication is likewise not a documented installation path. Details are in the
[CLI reference](docs/cli.md#installation-and-distribution-status).

Common commands:

```sh
# Scan one first-party repository from this source checkout.
node ./dist/cli/bin.js scan ./example-repository --format json --out report.json

# Reconcile one repository against local, value-free input documents.
node ./dist/cli/bin.js reconcile --root ./example-repository \
  --bindings ./control/bindings.json \
  --inventory ./control/inventory.json \
  --format sarif --out findings.sarif

# Scan explicitly named repositories and deployments.
node ./dist/cli/bin.js workspace scan --manifest ./control/workspace.jsonc --format json

# View a derived workspace report on loopback only.
node ./dist/cli/bin.js ui --manifest ./control/workspace.jsonc
```

Use `--require-complete` when a nonzero result is needed for incomplete or
invalid analysis. It cannot turn static evidence into a runtime guarantee.

## Documentation

- [CLI reference](docs/cli.md) — commands, output formats, exit behavior, and
  local viewer.
- [Workspace manifests and reports](docs/workspaces.md) — v2 manifest
  structure, deployment member scopes, report schemas, and v1 migration.
- [Evidence and reconciliation model](docs/evidence-model.md) — demand,
  bindings, inventory, dynamic access, coverage, and closed models.
- [Privacy, boundaries, and limits](docs/privacy-and-limits.md) — local-only
  behavior, redaction, resource limits, and what remains inconclusive.
- [Programmatic API](docs/programmatic-api.md) — published package entry
  points and their boundaries.
- [Development and contributing](docs/development.md) — verification,
  documentation requirements, and the worktree workflow.
- [Technical specification](https://github.com/jlsegb/secret-reference-inventory/blob/main/SPEC.md)
  — detailed source-repository design contract and planned architecture; the
  versioned runtime contracts above describe the current implementation.

## Maintainers

Run the full local verification suite before proposing a change:

```sh
npm run verify
npm run release:check
```

Neither command publishes a package. `release:check` is the intended local
release gate, but it is currently blocked by the known report-v1-versus-v2
smoke assertion mismatch; do not treat archive installation as verified until
that release-code issue is fixed.

Changes must also follow the required function documentation contract in
[Development and contributing](docs/development.md#required-function-documentation).
