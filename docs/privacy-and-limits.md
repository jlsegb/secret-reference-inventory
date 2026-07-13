# Privacy, boundaries, and limits

Secret Reference Inventory is designed for local static evidence. This page
states the data boundary and the limits that deliberately turn uncertain work
into incomplete results instead of broader claims.

## Local-only operation

At runtime the CLI has no telemetry, analytics, account, remote API, or
provider integration. It does not make network requests. The loopback viewer
is the only HTTP server it starts, and it binds exclusively to `127.0.0.1`.

The tool does not execute repository source, package lifecycle scripts, build
steps, shell commands, plugins, Terraform/Pulumi/CDK programs, or executable
configuration. It parses source syntax and explicitly selected local JSON or
JSONC documents. Installing dependencies, cloning the project, or installing
a package may use external tooling and is outside the runtime scan boundary.

## Values and reportable data

The target of analysis is a logical key or provider resource identity, not its
value. The tool does not read the process environment or dotenv files for
values. Provisioning documents are required to be value-free.

For workspace scans, a bounded, invocation-private cache holds the raw parsed
and frozen local provisioning document before binding-adapter parsing and
`SafeFactFactory` normalization. That cache is an internal input-read cache,
not a safe-fact/report cache; it can precede the safety boundary and must be
treated as potentially sensitive. It is not serialized to reports or exposed
to the browser. The value-free document requirement is therefore a real input
contract, not a promise that arbitrary raw JSON never exists transiently in
memory.

After data crosses into reportable facts or diagnostics, the safety boundary
validates it. Unsafe identifier text becomes a fixed opaque record; raw parser
errors become fixed diagnostics. The report model contains safe logical
identifiers, root-relative display paths, positions, evidence categories, and
status axes. It excludes:

- secret values and source snippets;
- canonical filesystem paths and raw manifest descriptor paths;
- raw input-document objects and unrecognized fields;
- raw parser exception text, hashes, entropy scores, and error fragments; and
- browser access to repository roots, arbitrary paths, or scan requests.

This is a report/fact containment policy, not a guarantee that a repository or
raw invocation-private input cache cannot transiently contain a value. The
safe-fact boundary avoids retaining unsafe raw text once it is recognized as
reportable data; users should still avoid placing values in filenames,
identifiers, or the value-free provisioning documents.

## Filesystem boundaries

Discovery starts with an explicit root, canonicalizes paths, and uses
containment checks. It skips symlinks and records safe, scoped diagnostics for
unreadable, outside-root, special, generated, ignored, unsupported, or
oversized files. Default excluded directories include VCS metadata,
`node_modules`, build/output folders, and coverage folders. The default tool
ignore file is `.secret-usageignore`, in addition to applicable gitignore
rules.

Outside-root imports and runtime dependencies are not inspected and never
contribute code demand. This is intentional: the report concerns the
first-party code that the operator selected, not every configuration option of
third-party packages.

Local manifests and provisioning input reads are bounded and checked for
file/path changes during the individual read. Workspace input documents share
a bounded invocation cache and are re-attested if a descriptor's observed file
identity changes. These checks protect declared local inputs; they do not make
a static scan proof that the entire source checkout stayed unchanged for every
moment of execution. Treat a moving checkout as a reason to rerun the scan
from a stable revision before making operational cleanup decisions.

## Resource limits

The current default source-discovery budget is:

| Limit | Default |
| --- | ---: |
| Directory depth | 40 |
| Source files | 100,000 |
| Total source bytes | 512 MiB |
| One source file | 5 MiB |

The maximum local JSON provisioning document is 5 MiB; a workspace manifest is
limited to 1 MiB. Provisioning parsers bound both raw structural entries and
normalized entries to 100,000 per parsed document, and a closed model limits a
finite key domain to 100 keys.

One workspace invocation bounds the materialized report graph to 100,000 facts
and local provisioning input reads to 100 MiB. It caches up to 2,048 document
payloads and tracks descriptor observations separately to fail closed on a
changed or replaced local input. The manifest itself has structural caps; see
[Workspace manifests and reports](workspaces.md#operational-limits).

An exceeded limit does not produce a truncated absence finding. The affected
scope or workspace member is marked incomplete with fixed diagnostic evidence.
`--require-complete` then returns status 2. Without that flag, inspect the
report's coverage and reasons before acting on any inventory finding.

## Local viewer boundary

`secret-usage ui` creates a viewer only from an application-issued request; a
deserialized or user-constructed request cannot supply report data or bind an
arbitrary host. The server:

- listens only on IPv4 loopback;
- serves one self-contained document at `/` using GET or HEAD;
- sets `Cache-Control: no-store`, a restrictive CSP, and no external asset or
  connection permissions; and
- exposes a derived display model rather than source text, source locations,
  canonical paths, raw workspace data, or raw provisioning documents.

The viewer is a local convenience, not a multi-user dashboard or a browser
file picker. Stop it with Ctrl-C or by closing its returned programmatic
handle.

## What remains outside the tool's claim

The tool cannot establish platform dashboard settings, provider permissions or
roles, runtime inheritance outside a declared binding export, execution reach,
or consumers outside the chosen code roots. It cannot prove that a bound
resource was delivered to a process, nor that a resource without compatible
static demand is safe to delete.

For the narrow scope of selected first-party code, an inherited variable still
needs a source-level read to be demanded by that code. If no scanned read
exists, the result is `inventory-listed-no-static-read` only after the relevant
local facts and coverage permit it. That label remains a review prompt because
the tool intentionally does not make claims about external consumers or
unscanned scopes.
