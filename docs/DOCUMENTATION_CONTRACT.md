# Documentation contract

`npm run docs:check` enforces structured function documentation for the local
implementation. It is intentionally a local static check: it performs no
network activity, sends no telemetry, and does not print source excerpts or
function names.

## Scope

The checker parses every tracked executable function-like implementation in:

- `src/**/*.ts`, excluding `.d.ts` declarations;
- `scripts/**/*.mjs`;
- `test/**/*.ts`.

For an exact Git repository root, `git ls-files -z -- src scripts test` is the
authoritative logical candidate inventory. Git values must be canonical,
slash-delimited logical identifiers; a literal backslash, absolute path, empty
segment, or dot segment fails closed with a fixed Git discovery diagnostic. The
checker filters extensions and its declared fixture exclusion from that list
before it resolves any file;
untracked files and untracked symlinks have no effect. Each tracked logical
candidate is then resolved and read locally. A missing, broken, unreadable, or
unresolvable candidate causes a fixed discovery failure rather than silently
dropping it. A local root that is not itself a Git repository uses a
deterministic filesystem fallback, which keeps standalone fixtures usable.

The checker excludes generated `dist`, dependencies, declaration/type-only
signatures, and the static fixtures solely used by this documentation checker at
`test/fixtures/docs-contract`. Tests and nested callbacks are in scope. A
function is never excused merely because it is anonymous, test-only, or nested.

Every selected candidate keeps its logical `src`, `scripts`, or `test` identity
for reporting, while its canonical target is used only for containment, reading,
and loop detection. This means a tracked `src` symlink can safely point to an
in-root target outside those three directories without changing the report
identity. A target must remain inside the canonical scan root. Outside-root
links cause the fixed `SOURCE_DISCOVERY_SYMLINK_INVALID` diagnostic; missing or
unreadable candidates cause fixed discovery diagnostics. Invalid `--root`
values likewise return `SOURCE_DISCOVERY_ROOT_UNAVAILABLE`, never a raw
filesystem error. A root must resolve and stat as a directory: a regular file
or symlink to a regular file produces the same fixed failure.

## Required block

Every function declaration, method, constructor, accessor, function expression,
and arrow function must have its own immediately associated JSDoc block. A
block on a variable, property, or export container never documents the function
stored inside it. Document anonymous and nested callbacks directly at the
function node.

```ts
/**
 * Produces the report consumed by the local terminal command.
 *
 * Inputs: A validated scan request and local source facts.
 * Outputs: A normalized, value-free report.
 * Does not handle: Network calls, secret retrieval, or mutation of input facts.
 * Side effects: None.
 */
export function buildReport(request: ScanRequest, facts: Fact[]): Report {
  // ...
}
```

For an anonymous arrow, put the block after the assignment token so it directly
precedes the arrow node:

```ts
const render = /**
 * Renders one local result row.
 *
 * Inputs: A normalized result row.
 * Outputs: A display-safe row string.
 * Does not handle: HTML escaping outside this local renderer.
 * Side effects: None.
 */ (row: ResultRow) => row.status;
```

The first prose line is the purpose. It must be one explicit sentence. The four
case-sensitive sections `Inputs:`, `Outputs:`, `Does not handle:`, and `Side effects:`
must each have nonempty content. State `None.` explicitly when a section has no
applicable behavior.

## Template guard and review requirement

The checker also rejects a small, explicit list of hollow templates found during
the initial documentation migration. These are mechanical rejection rules, not
natural-language understanding. Each rule compares one complete purpose or
named section value after trimming, collapsing internal whitespace, and
lowercasing it; it never rejects a phrase merely because it starts similarly.
The strictly bounded values cover scenario-only exclusions for production
workspace execution, helper input/output text that defers only to a caller or
body, generic callback-result prose, and test-local collection/cache mutation
phrased only as "named in its body". The stable diagnostic identifies the
rejected template family but never prints the documentation text.

Passing this check is necessary but not sufficient. It proves only direct
attachment, required structure, and the absence of those known templates. It
does not prove that a block accurately describes its function, that an omission
is appropriate, or that a side effect is complete. Every documentation change
therefore still requires fresh semantic review against the implementation.

## Diagnostics and adoption

Diagnostics contain only a privacy-safe logical path, line, function category,
and rule code. Credential-like, path-shaped, or otherwise unsafe logical
filenames are replaced with `<opaque-file>`. Fixed source-discovery diagnostics
use `<discovery>:0` instead of an untrusted path. They never contain source
text, function names, comments, supplied roots, absolute paths, symlink targets,
or secret-shaped values.

The command is expected to report missing blocks until every existing source,
script, and test implementation has been documented. This is deliberate: the
fixture suite verifies the checker independently, while documentation migration
lands in separate implementation-owned changes. It intentionally stays outside
`verify` until the repository-wide migration reaches zero diagnostics; the
dedicated integration task will wire it into the required CI command only then.

## Local usage

Run the repository check:

```sh
npm run docs:check
```

Run an explicit local lane by repeating `--file` after npm's argument separator.
Each value must be a canonical, repository-relative implementation path under
`src`, `scripts`, or `test`; it is selected from the same tracked inventory as a
full run. An invalid, ignored, untracked, missing, unreadable, or unsafe
requested target fails closed with a fixed discovery diagnostic. The checker
never supports `--scope`.

```sh
npm run docs:check -- --file src/workspace/runtime.ts --file test/workspace-runtime.test.ts
```

Run the same checker against another local checkout or a fixture root:

```sh
node scripts/docs-check.mjs --root /absolute/path/to/repository --file src/core.ts
```
