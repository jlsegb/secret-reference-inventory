# Secret Reference Inventory

Secret Reference Inventory is a local static-analysis CLI for finding logical
secret and configuration keys that first-party TypeScript and JavaScript code
reads. It reports references such as env:DATABASE_URL, not secret values.

It answers a focused cleanup question: “which provisioned secrets still have
static code demand?” A resource with no compatible static read is a review
candidate, never a deletion instruction.

## Local-only security model

- The CLI makes no runtime network requests and has no telemetry, analytics,
  accounts, or service integration.
- It does not execute repository code, package scripts, build scripts, shell
  commands, or plugins. Source parsing uses the TypeScript compiler API in
  syntax-only mode.
- It does not read values from the process environment or dotenv files. Local
  JSON inputs are value-free binding/inventory exports, validated before facts
  or reports are produced.
- Reports contain sanitized logical keys, paths, positions, and evidence
  categories; they contain no source snippets or secret values. Credential-like
  and high-entropy malformed identifiers are redacted.

Static evidence is deliberately narrower than runtime truth. An
exact-declared binding describes a compatible declared mapping; it does not
prove delivery, authorization, reachability, or execution.

## Get and run it

Requires Node.js 24 or newer.

### Source clone — supported today

The public GitHub repository is one supported distribution path for the full
command set:

~~~sh
git clone https://github.com/jlsegb/secret-reference-inventory.git
cd secret-reference-inventory
npm ci
npm run build
node ./dist/cli/bin.js scan ./my-repository
~~~

Obtaining dependencies can contact GitHub or npm. Once built, the CLI itself
makes no runtime network requests.

The command examples below use the installed-binary spelling,
secret-usage. From a source clone, replace that prefix with
node ./dist/cli/bin.js.

### Locally packed install — supported today

The release tarball bundles its runtime dependencies and includes the complete
CLI surface, including workspace scan and the local browser viewer. It can be
installed from a local tarball with an empty npm cache and offline mode:

~~~sh
npm run build
npm pack --ignore-scripts
npm install --prefix ./local-install --offline --ignore-scripts \
  ./secret-reference-inventory-<version>.tgz
./local-install/node_modules/.bin/secret-usage workspace scan \
  --manifest ./control/workspace.jsonc
~~~

Replace <version> with the version in the tarball filename. A global install
uses the same local archive with npm install --global --offline
--ignore-scripts.

### npm registry install — future

The project has not yet been published to the npm registry. After its first
registry publication, the standard install will be:

~~~sh
npm install --global secret-reference-inventory
secret-usage scan ./my-repository
~~~

Until then, use a source clone or a locally packed tarball.

## Scan one repository

Scan code and write a local JSON report:

~~~sh
secret-usage scan ./my-repository \
  --format json \
  --out scan-report.json \
  --require-complete
~~~

Supported single-repository output formats are terminal (the default), json,
and sarif.

Reconcile code demand with local, value-free exports of bindings and inventory:

~~~sh
secret-usage reconcile \
  --root ./my-repository \
  --bindings ./bindings.json \
  --inventory ./inventory.json \
  --closed-model ./closed-model.json \
  --format sarif \
  --out secret-usage.sarif \
  --require-complete
~~~

Explain a finding from a JSON scan or reconciliation report:

~~~sh
secret-usage explain env:DATABASE_URL --scan-report scan-report.json
~~~

The reconcile --scan-report form is reserved but is not implemented; use
--root today.

### Local reconciliation inputs

reconcile accepts only local JSON files:

- binding manifest: binding-manifest/v1;
- inventory snapshot: inventory-snapshot/v1; and
- optional closed provisioning model: closed-provisioning-model/v1.

They describe logical destinations, execution scope, delivery channel,
conditions, precedence, and provider-qualified resource IDs. They must not
contain secret values. The tool does not call provider APIs or inspect provider
permissions or roles.

## Scan a workspace

Workspace scanning is an explicit multi-repository code-demand view. The
manifest is JSON or JSONC and uses schema version workspace-manifest/v1:

~~~jsonc
{
  "schemaVersion": "workspace-manifest/v1",
  "repositories": [
    { "id": "api", "root": "../api" },
    { "id": "worker", "root": "../worker" }
  ],
  "deployments": [
    {
      "id": "production",
      "repositories": ["api", "worker"],
      "inputs": {
        "bindings": "../infra/production/bindings.json",
        "inventory": "../infra/production/inventory.json",
        "closedModel": "../infra/production/closed-model.json"
      }
    }
  ]
}
~~~

Repository IDs, roots, deployment IDs, and deployment membership are explicit;
the tool never discovers repositories from names, imports, or filesystem
layout. A root is resolved relative to the manifest directory and must resolve
to an existing directory. Explicit sibling roots such as ../api are valid.

A deployment can omit inputs for a scan-only declaration. When present,
bindings and inventory must appear together; closedModel is optional. The
descriptors are resolved relative to the manifest and loaded only as local,
value-free JSON.

When a deployment has exactly one declared repository and its local inputs are
valid, those inputs are reconciled against that repository’s code demand. For a
deployment with two or more declared repositories, the tool still scans every
member and calculates shared code demand, but it intentionally does **not**
manufacture a merged cross-root reconciliation. That deployment is reported as
incomplete with WORKSPACE_DEPLOYMENT_MULTI_REPOSITORY_UNAGGREGATED. This
remains true even when all member scans and local inputs are otherwise valid.

Run it with:

~~~sh
secret-usage workspace scan \
  --manifest ./control/workspace.jsonc \
  --format json \
  --out workspace-report.json \
  --require-complete
~~~

Workspace output supports terminal (default) and json and uses the versioned
JSON shape secret-reference-inventory/workspace-report/v1. Workspace SARIF
output is not currently supported.

Each declared repository is scanned independently, with bounded concurrency.
An invalid or incomplete repository does not change another repository’s
evidence; deployment status reflects the status of its explicit members and
any applicable reconciliation limit.

### Multi-repository sharing means only shared code demand

A workspace report marks a key as shared only when the same logical key has
static demand in at least two repositories that are explicitly listed in the
same deployment. It does not infer sharing from matching names, directory
layout, import relationships, or separate deployments.

A shared key does **not** establish that repositories receive the same value,
share a provider resource, have a compatible binding, or can receive a value at
runtime. It is a code-demand relationship only.

## Local browser viewer

Use the workspace manifest to create a transient local report view:

~~~sh
secret-usage ui --manifest ./control/workspace.jsonc
~~~

The command prints a URL such as http://127.0.0.1:43123/ and keeps the local
server open until it is stopped (for example, with Ctrl-C). Omit --port to use
an ephemeral loopback port, or set a specific local port:

~~~sh
secret-usage ui --manifest ./control/workspace.jsonc --port 43123
~~~

The viewer binds only to IPv4 loopback (127.0.0.1) and has no telemetry,
external assets, API calls, or browser-side network connections. It serves a
self-contained report under a restrictive content-security policy. The browser
receives a derived display model only; it does not receive source text, source
locations, canonical filesystem paths, raw manifest descriptors, or raw input
files. The browser has no mechanism to select repositories or scan arbitrary
paths.

With --require-complete, ui does not start a server when the workspace result
is incomplete or invalid.

## Coverage, dynamic access, and absence findings

The scanner considers first-party files under the supplied root with these
extensions: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, and .cjs. It intentionally
analyzes code rather than documentation.

- Direct and safely constant-folded environment reads are code demand.
- Finite or pattern dynamic lookups are reported as bounded candidates.
- Unbounded or user-controlled lookups (for example, process.env[key] when
  key cannot be resolved) are flagged as scoped uncertainty. The tool may
  identify likely keys only when static evidence bounds them; it never guesses
  values or arbitrary user input.
- Ignored, generated, unreadable, oversized, symlinked, parser-failed, or
  budget-exhausted first-party paths also produce scoped incomplete coverage.

--require-complete exits with status 2 when incomplete coverage prevents a
complete conclusion. For workspace scans, an invalid repository or deployment
also exits with status 2. Without that flag, the report keeps the scoped
incomplete or invalid state visible rather than turning it into absence.

An inventory-listed resource with no compatible first-party static read can be
labeled inventory-listed-no-static-read for review. A strong absence conclusion
requires the relevant code scope to have complete coverage and an explicit,
closed provisioning model for that same scope. It still does not prove runtime
delivery or authorization.

## Important limitations

- Static analysis cannot prove a branch executed, an environment value was
  delivered, a provider role can read a resource, or a dashboard-only setting
  exists.
- Outside-root imports and runtime dependencies are intentionally excluded
  from code demand. The result is about the code and local inputs within the
  requested root.
- Dynamic reflection, runtime-generated code, unsupported languages, and
  platform configuration not represented in a local binding export can leave
  findings inconclusive.
- Deployment-local inputs reconcile only for a one-repository deployment.
  Multi-repository input reconciliation is deliberately incomplete rather than
  an inferred cross-root result.
- The tool never deletes, rotates, revokes, or validates a secret. Review
  candidates alongside deployment configuration and operational evidence.

## Programmatic surface

The package root and secret-reference-inventory/cli export the parser and CLI
runner. secret-reference-inventory/discovery and
secret-reference-inventory/safety are the explicitly supported lower-level
exports. All other paths are private implementation details.

## Development and release status

~~~sh
npm run verify
npm run release:check
~~~

These are maintainer checks; neither publishes a package. release:check
verifies the release file set and runs an isolated offline installed-package
smoke that includes workspace scan. Registry publication remains a separate,
future step.
