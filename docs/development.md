# Development and contributing

This project is a local static-analysis tool. Changes must preserve its
value-free, no-execution, and no-telemetry boundaries as carefully as they
preserve feature behavior.

## Prerequisites and verification

Use Node.js 24 or newer. From a selected task checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify
```

`npm run verify` runs type checking, the test suite, and the build. For package
changes or a release candidate, also run:

```sh
npm run release:smoke
npm run release:check
```

These commands build and inspect local artifacts; they do not publish a
package. At the current revision, the installed-package smoke assertion still
expects a workspace report v1 while the runtime emits v2, so archive-release
validation is known to be blocked. Keep generated `dist/` output out of a
source change unless the repository's release process explicitly requires it.

Before handoff, also run `git diff --check` and review the exact diff. For
documentation-only changes, verify Markdown links and command examples against
the current CLI parser/help and package scripts.

## Required function documentation

Every tracked executable function definition must have a documentation block
immediately above it. This applies to `src/**/*.ts`, `scripts/**/*.mjs`, and
`test/**/*.ts`, including exported and non-exported function declarations,
class methods, constructors, and function/arrow expressions assigned to named
bindings or passed as callbacks. Generated files, dependency files,
declaration-only files, and dedicated checker fixtures are excluded. There are
no "too small to document" exceptions: a terse contract is still required for
a one-line helper or test callback.

Each block must start with one plain-language purpose sentence, then use these
exact canonical headings with accurate local names:

1. `Inputs:` — each meaningful parameter, assumptions, and validation or
   normalization performed. Write `None.` when it has none.
2. `Outputs:` — return value, mutation/throw/rejection behavior, and important
   invariants. Write `None.` for a void-only effect.
3. `Does not handle:` — meaningful exclusions, delegated responsibilities, or
   explicit out-of-scope cases. Write `None beyond its documented contract.`
   only when that is genuinely true.
4. `Side effects:` — filesystem, network/listener, cache, logging, global
   state, mutation, or resource-lifecycle effects. Write `None.` when pure.

Use this structure:

```ts
/**
 * Creates a sanitized report record from already validated facts.
 *
 * Inputs:
 * - `facts`: value-free Core facts that have crossed the safety boundary.
 *
 * Outputs:
 * - Returns a deterministic display record; throws no raw input text.
 *
 * Does not handle:
 * - Filesystem reads, provider access, or validation of raw source input.
 *
 * Side effects:
 * - None.
 */
function buildDisplayRecord(facts: readonly Fact[]): DisplayRecord {
  // ...
}
```

Do not use a generic sentence such as "helper function" as a substitute for
the contract. Update the block whenever behavior, failure modes, validation,
or side effects change. Documentation must not repeat unsafe raw values, full
paths, or source excerpts that the runtime would redact.

Type aliases, interfaces, enums, namespaces, and type-only declarations are
not function definitions. A callback type documents a callable contract but
does not replace the block on an implementation. Test helpers should also be
documented when their setup/cleanup or hidden side effects are non-obvious.

## Documentation map and maintenance

Keep the documentation layered:

- [README](../README.md): scope, quick start, and navigation.
- [CLI reference](cli.md): accepted command forms and current behavior.
- [Workspace reference](workspaces.md): JSON/JSONC and report contracts.
- [Evidence model](evidence-model.md): conclusions and uncertainty.
- [Privacy and limits](privacy-and-limits.md): safety boundaries and caps.
- [Programmatic API](programmatic-api.md): package export surface.
- [Technical specification](https://github.com/jlsegb/secret-reference-inventory/blob/main/SPEC.md):
  detailed source-repository design and target architecture.

When implementation changes, update the narrowest authoritative document in
the same change. Do not describe a planned parser, adapter, provider check, or
runtime guarantee as current behavior. Keep examples value-free and use safe
placeholder identifiers such as `PAYMENTS_API_TOKEN`, never credential-shaped
literals or real local paths.

## Worktree workflow

The workspace intentionally separates the primary checkout from task
worktrees. The workspace-level `AGENTS.md` is the operational source of truth;
follow it before any repository mutation, test repair, rebase, or pull-request
operation.

Expected layout:

```text
<workspace>/
├── secret-reference-inventory/            # primary checkout; local main mirror
└── secret-reference-inventory-worktrees/  # isolated task worktrees
    └── <task>/                            # one branch/task owner
```

Before work, explicitly select the checkout and report its absolute path,
branch and `HEAD`, upstream when configured, clean/dirty state, and why it is
the correct task checkout. Never rely on the ambient current directory.

For a new implementation task:

1. Fetch `origin` from the primary checkout.
2. Fast-forward primary `main` only when it is clean and safe to advance.
3. Create a fresh `codex/<task-name>` branch from `origin/main` under the
   sibling worktrees directory.
4. Keep all source edits, tests, and commits in that one task worktree.

For an existing task worktree, fetch first; preserve local changes and use a
safe fast-forward or reported rebase when appropriate. Do not reset, force
update, force-push, or merge solely to sync without explicit authorization.

Each writer owns its task worktree and creates a task-only transferable commit
before handoff. A handoff names the absolute worktree path, branch, base and
final commit, changed artifacts, clean status, and verification evidence.
Only remove a clean worktree once its commit is reachable from the intended
integration branch; use `git worktree remove` from another checkout followed
by `git worktree prune`.

## Review checklist

- Does the change preserve value-free facts and fixed/sanitized diagnostics?
- Does it avoid code execution, remote calls, and unbounded input expansion?
- Are incomplete coverage, dynamic access, and provider/runtime limits still
  visible rather than collapsed into an absence claim?
- Do public package exports, CLI help, schemas, tests, and documentation agree?
- Does every changed or added executable function have the required contract
  block, including its non-handled cases and side effects?
- Were the required verification commands run from the exact task worktree?
