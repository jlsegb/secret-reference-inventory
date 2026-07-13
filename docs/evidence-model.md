# Evidence and reconciliation model

The tool answers a source-level question: which safe logical keys are read by
the selected first-party code, and which local provisioning facts are
compatible with those reads? It does not answer whether a value was delivered,
whether a role can access a provider resource, or whether a branch executed.

## Evidence relations

The analysis keeps these relations separate:

| Relation | Evidence supplied by | Meaning |
| --- | --- | --- |
| Code demand | First-party source parsing | A logical destination key is read in an execution scope. |
| Dynamic lookup | First-party source parsing | A key expression is finite, patterned, or unbounded; it is not automatically a certain read. |
| Binding candidate | Local binding manifest | A declared destination-to-resource mapping with scope, condition, and precedence facts. |
| Inventory snapshot | Local inventory document | A timestamped provider-qualified resource list. |
| Coverage | Discovery and input parsing | Whether relevant analysis was complete, skipped, malformed, opaque, or over budget. |
| Closed model | Explicit local model | A user declaration of what first-party demand/provisioning scope is closed enough for stronger static conclusions. |

Logical destination keys and provider resource IDs are different namespaces. A
binding relates them only when it carries the mapping. Provider resource joins
require exact equality of both `authorityId` and `canonicalId`; matching a
human-readable name is not enough.

## Source demand

The current syntax-only TypeScript backend inspects selected TypeScript and
JavaScript files. It recognizes environment-object reads through `process.env`,
`import.meta.env`, `Bun.env`, and `Deno.env`, including direct properties,
element access, destructuring, safe aliases, and bounded constant folding. It
does not execute the code, construct a TypeScript Program, resolve modules, or
inspect runtime dependencies.

Direct reads produce demand. A declaration, wrapper definition, string literal,
or configuration-file key is not automatically code demand. This distinction
prevents a schema or a dotenv-style list from making every declared key appear
used.

Source locations and logical identifiers are sanitized before they enter facts
or reports. The tool records safe root-relative locations, not snippets,
canonical paths, raw parser errors, or values.

## Dynamic access

A lookup such as `process.env[key]` is always an important signal, but it is
not necessarily evidence for a named key. The report classifies its domain:

| Domain | Example shape | Report effect |
| --- | --- | --- |
| Exact | A literal or safely folded name | Normal direct demand. |
| Finite | A statically bounded map or set of names | Possible keys are reported; they are not promoted to certain reads. |
| Pattern | A constrained prefix/suffix form with fixed safe text | Matching known keys may be shown as likely candidates. |
| Unbounded | Opaque, over-budget, or user-controlled input | No arbitrary key names are guessed; affected environment-key absence claims are inconclusive. |

If a user controls the selector but static code proves it indexes a finite
literal map, the finite domain is still useful as a possible-key domain. If the
selector itself is unknown, a cast, comment, or naming convention does not
bound it. The tool does not expand an unbounded access from the inventory.

## Binding selection

Bindings are candidates, not immediate truth. For a destination and scope, the
Core resolver evaluates compatible selector coverage, finite conditions, and
declared precedence. A selected candidate can be effective; other candidates
may be shadowed, inapplicable, conflicting, or unresolved.

`exact-declared` requires an effective, compatible mapping that covers the
relevant scope. A build mapping does not satisfy a runtime demand; a
mounted-file mapping does not satisfy an environment-channel demand; and a
conditional branch winner does not prove an unconditional demand unless all
relevant finite branches are covered. Provider access is deliberately recorded
as not evaluated.

## Inventory and absence

An inventory item can be joined only through an effective binding with an exact
provider-qualified identity. The result axes make this visible:

| Axis | Examples | Interpretation |
| --- | --- | --- |
| `demand` | `present`, `finite-dynamic`, `unbounded-user-controlled`, `absent` | Static source evidence, not execution. |
| `binding` | `exact-declared`, `conflicting`, `unresolved`, `no-static-evidence` | Declared mapping selection, not delivery. |
| `inventory` | `bound`, `inventory-listed-no-static-read`, `missing-under-declared-model`, `unknown` | Local inventory relation, not authorization. |
| `coverage` | `complete`, `incomplete` | Whether relevant static evidence is sufficient. |
| `disposition` | `informational`, `review`, `inconclusive` | Conservative summary; consult reasons and gaps. |

`inventory-listed-no-static-read` identifies an inventory resource with no
compatible first-party static demand in the analyzed scope. It is useful for a
legacy-secret review queue, but it is not approval to delete, rotate, revoke,
or alter that resource. A resource can have consumers outside the selected
roots, in unsupported languages, in dynamic code, or in a platform setting
absent from the local export.

`missing-under-declared-model` is stronger but still static: it requires the
closed-model conditions below. It means the declared first-party model lacks a
compatible local relation; it does not prove platform delivery or provider
permission.

## Coverage and inconclusive results

Coverage is scoped. Relevant ignored/generated files, unreadable files,
symlink or containment failures, oversized files, parser failures, malformed
provisioning documents, opaque bindings, dynamic uncertainty, and bounded-work
exhaustion contribute gaps or incomplete state for the affected scope. One
repository's failure does not make a different workspace repository incomplete.

Use `--require-complete` to make incomplete results fail the command. Without
it, a report still preserves its incomplete state and reasons. Never interpret
the absence of a report group as proof that no code reads the key without first
checking `scopeCoverage`, dynamic lookups, and reconciliation reasons.

## Closed provisioning models

A strong static absence conclusion is opt-in. A `closed-provisioning-model/v1`
scope is useful only when all relevant requirements hold:

1. The scope explicitly has `closed: true` and describes a compatible execution
   scope, stage, and channel.
2. The model declares the approved first-party roots, binding roots, expected
   local input identities, inventory authorities, permitted exclusions, and
   outside-root policy.
3. Relevant source, binding, and inventory coverage is complete within that
   declared scope; no applicable skip, parse failure, dynamic/broad binding,
   budget failure, or unresolved selection remains.
4. The required binding and inventory relation is exact and provider-qualified.
5. No allowed external mechanism applies to the candidate scope.

For a direct `reconcile` invocation, the caller must additionally provide an
explicit absolute verification base. The current working directory is never an
implicit verification authority. A workspace uses its verified manifest input
boundary instead.

Even then, the conclusion is limited to the declared first-party scope. It does
not state that no dashboard setting, external service, separate repository,
runtime dependency, or unmodeled platform consumer uses the provider resource.

## Report interpretation

Single-repository JSON reports use `secret-reference-inventory/report/v1` and
contain:

- `groups`: logical key groups, their static source occurrences, consumer
  scopes, and demand/inventory uses with axes and reasons;
- `dynamicLookups`: the non-exact accesses, safe domain classification, likely
  keys where justified, sources, and reasons; and
- `scopeCoverage`: complete/incomplete coverage state and safe gap IDs for each
  scope.

SARIF results carry the same axes, safe scope/key information when applicable,
and reasons as result properties. It is a static-analysis interchange format,
not a provider audit log.

Workspace JSON wraps independent repository reports and deployment member
partitions in `secret-reference-inventory/workspace-report/v2`. See
[Workspace manifests and reports](workspaces.md#workspace-report-format).
