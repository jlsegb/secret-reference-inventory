# Secret Reference Inventory

`secret-reference-inventory` is a local-only static analysis CLI for finding
logical secret and configuration keys that first-party TypeScript and
JavaScript code reads. It reports references such as `env:DATABASE_URL`, not
secret values.

It is designed to answer a practical cleanup question: “which provisioned
secrets still have static code demand?” A provisioned resource with no
compatible static read is a review candidate, never a deletion instruction.

## Local-only security model

- The CLI makes no runtime network requests and has no telemetry, analytics,
  account, or service integration.
- It does not execute repository code, package scripts, build scripts, shell
  commands, or plugins. Source parsing uses the TypeScript compiler API in
  syntax-only mode.
- It does not read values from the process environment or dotenv files. Local
  JSON inputs are treated as value-free binding/inventory exports and are
  validated before facts or reports are produced.
- Reports contain sanitized logical keys, paths, positions, and evidence
  categories; they contain no source snippets or secret values. Credential-like
  and high-entropy malformed identifiers are redacted.

Static evidence is intentionally narrower than runtime truth: an exact mapping
means `exact-declared`, not delivered, authorized, reachable, or executed.

## Install and run

Requires Node.js 24 or newer.

```sh
npm install --global secret-reference-inventory
secret-usage scan ./my-repository
```

Scan with JSON output and write a local report:

```sh
secret-usage scan ./my-repository --format json --out scan-report.json --require-complete
```

`--require-complete` exits with status `2` when skipped/failed first-party
coverage or an unbounded environment lookup prevents a complete conclusion.

Reconcile code demand with local exports of static bindings and inventory:

```sh
secret-usage reconcile \
  --root ./my-repository \
  --bindings ./bindings.json \
  --inventory ./inventory.json \
  --closed-model ./closed-model.json \
  --format sarif \
  --out secret-usage.sarif \
  --require-complete
```

Explain an item from a JSON scan report:

```sh
secret-usage explain env:DATABASE_URL --scan-report scan-report.json
```

Supported output formats are `terminal` (default), `json`, and `sarif`.

## Supported local inputs

The scanner considers first-party files under the supplied root with these
extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`.
It intentionally analyzes code rather than documentation.

`reconcile` accepts only local JSON files:

- binding manifest: `binding-manifest/v1`;
- inventory snapshot: `inventory-snapshot/v1`; and
- optional closed provisioning model: `closed-provisioning-model/v1`.

These inputs describe logical destinations, execution scope, delivery channel,
conditions, precedence, and provider-qualified resource IDs. They must not be
used to supply secret values. The tool does not call provider APIs or inspect
provider permissions/roles.

The `reconcile --scan-report` form is parsed for forward compatibility but is
not implemented; use `--root` today. `explain` requires a JSON report produced
by `scan` or `reconcile`.

## What it can establish

- Direct and safely constant-folded environment reads are code demand.
- Finite/pattern dynamic lookups are reported as bounded candidates; unbounded
  or user-controlled lookups remain explicit scoped uncertainty.
- Static binding candidates are reconciled only when their execution unit,
  phase, stage, delivery channel, destination, conditions, and precedence are
  compatible.
- An inventory-listed resource with no compatible first-party static read is
  labeled `inventory-listed-no-static-read` for review.

## Important limitations

- Static analysis cannot prove a branch executed, an environment value was
  delivered, a provider role can read a resource, or a dashboard-only setting
  exists.
- Outside-root imports and runtime dependencies are intentionally excluded
  from code demand. The result is about the code and local inputs within the
  requested root.
- Ignored, generated, unreadable, oversized, symlinked, or budget-exhausted
  first-party paths produce scoped incomplete coverage rather than a clean
  absence claim.
- Dynamic reflection, runtime-generated code, unsupported languages, and
  platform configuration not represented in a local binding export can leave
  findings inconclusive.
- The tool never deletes, rotates, revokes, or validates a secret. Review
  candidates alongside deployment configuration and operational evidence.

## Programmatic surface

The package root and `secret-reference-inventory/cli` export the parser and
CLI runner. `secret-reference-inventory/discovery` and
`secret-reference-inventory/safety` are the explicitly supported lower-level
exports. All other paths are private implementation details.

## Development release check

```sh
npm run verify
npm run release:check
```

`release:check` builds locally and runs `npm pack --dry-run --ignore-scripts`.
It verifies the public file list, bin/exports targets, absence of direct
telemetry/network dependencies or package configuration, and exclusion of
source, tests, fixtures, caches, and source maps from the tarball. It does not
publish a package.
