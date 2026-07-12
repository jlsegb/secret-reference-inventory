# Secret Reference Inventory

## Status

Draft technical specification for a public, local-only command-line tool.

## 1. Purpose

The tool builds a static inventory of logical secret and configuration
references in a repository. Its core claim is:

> These source files reference these keys; here is the evidence of which
> components can consume them and whether a compatible injection path was
> statically declared.

It is deliberately not a claim that a value was read in production, that a
branch executed, or that a configured secret is safe to delete.

The primary analysis unit is a logical reference, never a secret value:

~~~
env:DATABASE_URL
env:STRIPE_SECRET_KEY
secret-manager:aws:prod/payments#api-key
~~~

The tool MUST never retain, display, hash, cache, or transmit the
corresponding value.

## 2. Goals

- Find secret/configuration references in first-party code, not documentation.
- Group findings by stable, explainable code and deployment components.
- Mark references consumed by multiple components as shared.
- Distinguish exact, statically resolved references from dynamic accesses.
- Determine whether a reference has compatible static injection/provisioning
  evidence for the relevant component, phase, and environment.
- Reconcile code demand with local-only secret-inventory and binding exports.
- Scale to large TypeScript/JavaScript monorepos without executing repository
  code or contacting an external service.
- Produce deterministic terminal, JSON, and SARIF output.

## 3. Non-goals

- Proving runtime execution, production reachability, or recent access.
- Reading secret values from source, process state, environment files, or a
  provider.
- Deleting, rotating, revoking, or changing secrets.
- Loading project modules, build scripts, package hooks, shell scripts,
  executable configuration, or TypeScript language-service plugins.
- Replacing audit logs or a secret provider's inventory.

## 4. Core evidence model

The analyzer keeps four typed relations, not interchangeable name sets:

~~~
D = code-demand edges: execution scope -> logical destination key
B = binding edges: execution scope + destination key -> provider resource
S = locally supplied provider-resource inventory
U = scoped uncertainty: dynamic access, opaque binding, or incomplete coverage
~~~

An execution scope includes a canonical execution unit, phase, stage predicate,
and delivery channel. A provider resource is a canonical
provider/account-or-project/region-or-namespace/resource/field identity.
Logical destination keys and provider resources are different namespaces.

Reconciliation only follows explicit, compatible edges:

| Relation | Interpretation |
| --- | --- |
| Demand bound to inventory | A compatible effective binding maps a demanded destination key to an inventory resource. |
| Inventory-listed with no static demand | A bound inventory resource has no compatible first-party code demand. It is a legacy-review candidate for the snapshot scope. |
| Demand with no inventory relation | The app requests a key with no matching local inventory/binding evidence; investigate external or missing provisioning. |
| Inventory with no binding | An inventory resource has no binding in the declared scope; it may belong to another scope or be legacy. |
| Any relation affected by U | Inconclusive; it must not support a strong absence claim. |

A provider's inventory is evidence of what is managed or provisioned. Code is
evidence of first-party source-level demand. Neither is a substitute for the
other, and neither authorizes deletion.

### 4.1 Join, demand, and absence contract

The reconciler MUST use typed equality, never raw string equality:

- a logical key matches only when its namespace and normalized name match;
- an execution scope matches only when its canonical ID, phase, stage coverage,
  and delivery channel are compatible; and
- a provider resource matches only when its adapter-produced authority ID and
  canonical resource ID both match exactly.

An unknown stage, channel, target, selector, or provider namespace cannot
produce an exact-declared relation. It produces scoped uncertainty instead.

Only direct reads and adapter-proven eager validation enter code demand by
default. Passive schema declarations, wrapper definitions, comments, and
literal indicators remain evidence but do not suppress a
inventory-listed-no-static-read result.

Broad/dynamic binding uncertainty is scoped, not global. It records the
execution scope, phase, stage predicate, delivery channel, and any bounded
source/key domain. For example, an envFrom-like binding with a locally known
key inventory may expand only those keys in that one scope; otherwise it makes
only that scope's absence results inconclusive.

### 4.2 Dynamic environment-key domains

Every process.env[key]-style access is reported. The analyzer first attempts
bounded, non-executing inference and classifies the key expression into one of
these domains:

| Domain | Reported result | Reconciliation effect |
| --- | --- | --- |
| exact | A normal exact reference after constant folding. | Normal demand edge. |
| finite | A safe, statically enumerable set such as FOO and BAR, including a user-controlled selector of a literal map. | Each listed key is a possible demand; only those keys are protected from strong absence. |
| pattern | A constrained prefix/suffix pattern with at least one fixed safe segment, such as SERVICE_*. | Show matching in-scope binding destination keys and explicit model-domain keys as likely candidates; do not invent names. |
| unbounded | The key is opaque, over the finite-domain budget, or depends on unmodeled input/execution. | Show no candidate keys; every environment-key absence claim in that execution scope is inconclusive. |

Finite/pattern candidates are not promoted to certain reads. They are visible
as likely or possible keys and block only the matching in-scope absence claims.
An unbounded lookup is never expanded from the entire inventory because doing
so would misleadingly imply that every listed key is known to be read.

User control is an origin tag, not a domain by itself. A user-controlled
selector of a finite literal map remains finite; a user-controlled interpolation
with a safe fixed template can remain pattern. Only an interpolation with no
safe fixed pattern, or with an unsafe/opaque template, is unbounded. An
unbounded lookup with user-controlled origin is emitted as a prominent
security-review finding: arbitrary environment lookup is possible in that
scope. It is not by itself reported as secret exfiltration; the tool separately
needs evidence that the retrieved value reaches an output or network sink.

### 4.3 Terminology

| Term | Meaning |
| --- | --- |
| Reference key | Case-preserving logical name such as env:DATABASE_URL. |
| Reference | One source location that reads, validates, or names a key. |
| Execution unit | A deployable app, function, worker, job, CLI, test process, build step, or resolved library consumer. |
| Component | A package, service, application, or explicit boundary that may own one or more execution units. |
| Execution scope | Canonical execution unit plus phase, stage predicate, and delivery channel. |
| Binding | Static declaration that maps a provider/external source to a named slot in an execution scope. |
| Provider secret | Optional provider-specific identity, distinct from an environment-variable name. |
| Dynamic access | A read or binding whose key, target, or source cannot be resolved exactly. |

The same environment-variable name does not prove the same underlying value
across components or stages. The report calls it the same reference key unless
an exact provider resource identity is statically known.

## 5. Injection and provisioning analysis

Injection analysis is a first-class requirement. A read of process.env.FOO
proves only that code requests env:FOO; it does not prove that FOO can be
supplied to that runtime.

### 5.1 Binding graph

The tool models a typed graph without values:

~~~
SecretReference    --produces--> DemandEdge
DemandEdge         --requests--> LogicalKey
DemandEdge         --targets-->  ExecutionScope
BindingCandidate   --declares--> LogicalKey
BindingCandidate   --targets-->  ExecutionScope
BindingResolution  --selects-->  BindingCandidate
InventorySnapshot  --lists-->    ProviderResourceId
~~~

A BindingResolution is compatible with a DemandEdge only when all applicable
dimensions are compatible:

1. The target execution unit matches.
2. The phase matches: runtime, build, test, development, or CI.
3. The binding covers every relevant environment/stage demand; mere predicate
   overlap is insufficient for an exact result.
4. The delivery channel is compatible.
5. The destination key is exact, or the result is explicitly non-exact.
6. The binding is effective after adapter-specific precedence and conditions
   are resolved.

For example, a mounted secret file does not satisfy a process.env.FOO read
unless a statically observed loader maps that file to FOO. A managed-service
SDK role does not satisfy an environment-variable read unless the adapter
knows it exposes that environment variable.

The version-one tool does not inspect provider authorization/identity policy.
It therefore reports an exact mapping as exact-declared, not as delivered,
accessible, or guaranteed to succeed at runtime.

### 5.2 Independent target and binding statuses

The tool MUST not report a lack of repository evidence as proof that injection
is impossible. It records independent target, demand, binding, inventory,
coverage, constraint, and disposition axes.

#### Target status

| Status | Meaning |
| --- | --- |
| deployable | A concrete application, function, job, or entrypoint is known. |
| consumer-derived | A shared library reaches a known deployable consumer through the import graph. |
| internal-only | Code belongs to a library/internal package and no deployable consumer was found. |
| external-consumer-possible | A library may be consumed beyond approved roots; this does not add out-of-scope demand. |
| unknown-target | No reliable component or entrypoint could be inferred. |

#### Binding status

| Status | Meaning |
| --- | --- |
| exact-declared | An effective static declaration maps this exact key to this target and scope. Provider access is not evaluated. |
| possible | A compatible broad mechanism exists, such as envFrom or inherited environment, but the key is not proven. |
| indirect | A loader or binding is known but its final key or target is unresolved. |
| conflicting | Applicable candidates cannot be ordered or resolve to incompatible sources. |
| unresolved | A dynamic condition/key/target prevents effective binding selection. |
| no-static-evidence | A target is known but no compatible in-repository binding was found. |
| external-unknown | Injection is expected outside scanned files, such as a platform dashboard. |
| static-constrained | A known runtime/framework rule prevents this key from being injected or exposed in the observed context. |
| dynamic | The key, target, or source is computed or otherwise opaque. |
| not-applicable | The finding is not an environment-injection request. |

#### Inventory/absence status

| Status | Meaning |
| --- | --- |
| bound | An effective binding and inventory item have an exact provider-resource identity match. |
| inventory-listed-no-static-read | A snapshot-listed bound resource has no compatible first-party code demand. |
| missing-under-declared-model | A required resource/binding is absent only after a closed model is complete. |
| unknown | Inventory, binding, or coverage uncertainty prevents a conclusion. |

The final status is emitted with the evidence and uncertainty that produced it.
The scanner MUST NOT infer a closed provisioning model merely because it found
a deployment manifest.

Binding status is independent from target discovery, code-demand evidence,
coverage, inventory relation, and runtime constraints. Reports expose those
axes separately; they do not overload one status column.

### 5.3 Binding selection and conflicts

Binding adapters emit ordered, conditional candidates rather than treating any
matching declaration as effective. Platform precedence is adapter-owned:
examples include a step-level CI environment overriding a workflow-level one,
Compose environment overriding env_file, and final-image ENV differing from a
builder-stage ARG.

For each execution scope, destination key, and finite stage/condition
partition, BindingResolution records both:

- a partition outcome: effective, conflicting, or unresolved; and
- a selection for every applicable candidate: effective, shadowed,
  inapplicable, conflicting, or unresolved.

Only an effective partition with exactly one effective selection can produce
exact-declared. This preserves both the winning Compose environment mapping and
the shadowed env_file mapping as evidence. Conditions must be finite normalized
predicates; unsupported/disjunctive/dynamic conditions become unknown and make
the affected partition unresolved. Conflicting and unresolved partitions
contribute scoped uncertainty.

### 5.4 Closed provisioning models

Strong absence classifications are an explicit opt-in. They require a
versioned closed-model manifest passed to the reconcile command and a complete
scan of the manifest's declared scope.

The manifest MUST declare:

- canonical execution-unit IDs, phases, and stage predicates;
- approved first-party roots and the binding/configuration roots to scan;
- expected source extensions plus supported adapters/formats for every declared
  demand and provisioning mechanism;
- optional finite key domains for specific dynamic pattern IDs, scoped to an
  execution scope, subject to maxFiniteKeyDomain, and usable only with
  adapter-proven selector constraints;
- permitted exclusions, each with an explicit scope selector and rationale;
- provider inventory namespace(s) and the local inventory export that is
  authoritative for each namespace;
- any allowed external mechanism, which makes the affected scope inconclusive;
- whether dependencies and outside-root imports are intentionally out of scope;
- an explicit closed flag for each scope.

The tool emits missing-under-declared-model or a strong
inventory-listed-no-static-read candidate only when all of these hold for its scope:

1. The closed flag is explicit.
2. Every declared root/adapter completed without relevant skip, parse, budget,
   opaque-binding, or dynamic uncertainty that overlaps the candidate key
   domain. Finite/pattern uncertainty does not block unrelated keys.
3. The effective consumers and binding candidates are resolved.
4. A provider-qualified inventory-to-binding relation is exact.
5. No allowed external mechanism applies.

Otherwise the result is inconclusive-coverage or external-unknown. A closed
model is a claim about a user-declared first-party scope, never a claim that no
other system in the world uses the provider resource.

### 5.5 Internal code and libraries

A package or internal module is not an injection target simply because it has
an environment read.

- Record the direct package read.
- Resolve bounded import reachability to deployable leaf execution units.
- Propagate the request to each resolved consumer, retaining its library
  provenance.
- Mark a key shared only when it reaches two or more distinct leaf execution
  units in the same relevant phase.
- If no consumer is found locally, report internal-only or
  external-consumer-possible;
  do not classify it as missing, production-used, uninjectable, or unused.

Test, build, CLI, and production consumers stay distinct. A CI/test binding
does not satisfy a production runtime request.

### 5.6 Client and build-time access

Client and build-time variables have different semantics from server secrets.
Framework adapters MUST classify their exposure rules. A build-time substitution
or a publicly exposed client variable is not counted as a server-secret
injection requirement. A non-exposable client key is reported as
static-constrained with the responsible adapter rule.

### 5.7 Binding evidence sources

| Source | Facts collected | Key limitation |
| --- | --- | --- |
| TypeScript/JavaScript | Reads, wrappers, provider SDK calls, runtime classification | Static access only. |
| Environment files | Key names only | Presence is not injection evidence until a loader/target is known. |
| IaC | Target, destination key, source ID, stage, delivery channel | Parse syntax only; opaque expressions remain unresolved. |
| Docker/Compose | Container target, ENV, ARG, environment, env_file, secrets, loaders | Build args and runtime environment are distinct. |
| Kubernetes | Container, env, secretKeyRef, envFrom, volumes, mappings | envFrom is non-exact unless key set is visible. |
| CI config | Job/step target, env, secret context, workflow inputs | Satisfies CI/build/test demand, not production runtime demand. |
| Package scripts and launchers | dotenv, env-file, cross-env, shell assignments, forwarding | Parse command syntax; never run it. |
| Managed service bindings | Target, identity/role metadata, channel, exposed key | Mapping only; version one does not verify provider permission. |

Adapters parse data only. Terraform, Pulumi, CDK, shell, or other executable
configuration MUST NOT be evaluated.

## 6. Architecture

~~~mermaid
flowchart LR
  A["Discover files and boundaries"] --> B["Parallel syntax extraction"]
  B --> C["Normalized reference facts"]
  C --> D["Optional TypeScript precision resolution"]
  D --> E["Import graph and binding correlation"]
  E --> F["Aggregate, reconcile, and report"]
~~~

The codebase is organized around these logical modules:

| Module | Responsibility |
| --- | --- |
| core | Normalized facts, graph operations, aggregation, confidence, and reconciliation. |
| cli | File discovery, budgets, configuration, commands, output, and exit codes. |
| safety | SafeFactFactory, identifier validation, opaque facts, and diagnostic sanitization. |
| ts-adapter | TypeScript/JavaScript extraction, local resolution, and module resolution. |
| binding-adapters | Data-only extraction from configured deployment/injection sources. |
| reporters | Deterministic terminal, JSON, SARIF, and explanation output. |

Parser ASTs are private to adapters. Adapters emit compact normalized facts so
parsers and languages can change without changing the reporting model.

## 7. Parsing and resolution strategy

### 7.1 Stack

| Layer | Decision |
| --- | --- |
| Runtime | Supported Node LTS, ESM, and TypeScript. |
| Fast syntax pass | OXC parser for JS, JSX, TS, and TSX, behind an adapter. |
| Precision/fallback | Raw TypeScript Compiler API for exact project/module semantics. |
| Traversal | Native file-system APIs plus gitignore-compatible filtering. |
| Parallelism | Bounded Node worker-thread pool. |
| Configuration | Schema-validated JSON or JSONC, never executable configuration. |
| Later polyglot support | Tree-sitter or equivalent language adapters. |

The optimized parser is a performance path, not a public data-model
dependency. The TypeScript parser remains available as a portability fallback.
For every supported syntax form, parser adapters MUST emit equivalent
normalized facts, locations, resolution classes, and coverage outcomes, or
emit an explicit unsupported-syntax coverage failure. If parser recovery
disagrees, the tool applies the documented fallback or records scoped
parser-disagreement/incomplete coverage; it never silently selects partial
facts. The project maintains a differential conformance corpus for the OXC and
TypeScript adapters.

### 7.2 Fast reference extraction

The scanner recognizes at least:

- process.env.NAME, bracket access, optional chaining, and destructuring;
- aliases such as const env = process.env;
- import.meta.env, Bun, and Deno environment APIs;
- safe static string concatenation and constant variables used as keys;
- known configuration/schema accessors; and
- direct static secret-manager resource IDs.

Environment-object enumeration or forwarding, including Object.keys(process.env),
for-in iteration, and unbounded object spread, produces an unbounded dynamic
lookup unless an adapter proves a narrower key domain.

The following are separate facts:

- a dotenv or configuration loader;
- a definition of a key; and
- an actual code read.

Loading an environment file must not cause every key in it to be reported as
used.

Dynamic key analysis runs after constant folding and before aggregation. It
uses bounded local dataflow, finite branch/union analysis, known schema
enumerations, and resolved first-party callers. It recognizes user-controlled
sources through framework adapters for request/query/body/route input,
webhooks, CLI arguments, stdin, and exported parameters with unresolved
callers. Type assertions, string unions, comments, naming conventions, and
casts do not prove a finite runtime domain. It never executes the code.

If the analyzer proves a finite set of no more than maxFiniteKeyDomain safe
keys, it reports that set. It never truncates an oversized set; the lookup
becomes over-budget unbounded uncertainty. If it proves only a prefix/suffix
pattern with at least one fixed safe segment, it may show matching logical
destination keys already known from the same scope's bindings or explicit model
domain as likely candidates, but those observations do not prove the pattern is
closed or create individual certain demand edges. A zero-fixed-segment
expression is unbounded, never a pattern.

An explicit closed model may supply a finite domain for one specific patternId
and execution scope; matching prefix/suffix text alone is insufficient. It may
expand that pattern only when code or a trusted adapter proves the selector is
constrained to the declared domain. A manifest declaration alone cannot bound
user-controlled or opaque input. Any expansion remains subject to the same cap.
If a key is unbounded, it reports the lookup, its safe provenance category, and
its affected execution scope without claiming that any named environment key is
used.

SafeFactFactory owns the raw-text boundary. No parser, adapter, custom-wrapper
rule, inventory reader, or reporter may construct a normalized fact directly.
All untrusted strings from ASTs, configuration/IaC parsers, worker messages,
and inputs pass through SafeFactFactory before entering facts, evidence,
diagnostics, caches, or reports.

SafeFactFactory returns either a namespace-specific safe identifier or the
fixed opaque record "opaque / unsafe-identifier". The opaque record contains no
raw or derived text, hash, quoted token, length, or entropy score. Raw parser
errors are replaced with fixed diagnostic codes and sanitized positions before
leaving a worker.

The default source-derived environment-key grammar is
[A-Z_][A-Z0-9_]{0,255}. It applies equally to dot properties, bracket
literals, destructuring keys, constant-folded values, and accessor arguments.
A project may allow additional key forms only through a trusted declarative
allowlist, never by accepting arbitrary source literals. Provider resource IDs
require an adapter-specific structured format. Unsupported/lower-confidence
literals become opaque uncertainty rather than reported identifiers. A value
can coincidentally match a valid key grammar, so this rule protects the
untrusted literal boundary; it does not claim to semantically distinguish every
possible secret-shaped string.

SafePath is a root-relative display path produced by SafeFactFactory under the
versioned root-relative-segment-v1 policy. Each displayed segment must match
[A-Za-z0-9][A-Za-z0-9._-]{0,127} and pass the versioned secret-like
path-segment classifier. The classifier redacts known credential-prefix forms
and high-entropy credential-like segments before SafePath materialization; it
retains no raw segment, score, or match detail. Any failure produces the fixed
opaque path marker, not a raw, escaped, hashed, or partially retained path.
Canonical real paths stay internal to PathGuard and never cross into facts,
diagnostics, worker messages, reporters, or cache filenames. Cache filenames
use non-reportable fingerprints and internal IDs, never raw paths.

### 7.3 Precision phase

The default scan MUST NOT construct a whole-repository TypeScript type checker.
It performs local lexical-scope checks, constant folding, and bounded aliases
syntactically.

An opt-in precision phase groups ambiguous candidates by discovered TypeScript
project/reference graph and uses the raw Compiler API for:

- module and path-alias resolution;
- imported/re-exported wrappers;
- symbol and shadowing verification; and
- bounded cross-file evidence chains.

It does not emit code, execute modules, invoke language-service plugins, or
create a TypeScript program per file. It uses a non-delegating, root-aware
CompilerHost: every source/config read, directory enumeration, realpath,
tsconfig extends/project-reference, type-root, package-exports, and module
resolution result is checked against canonical real approved roots before use.
Containment uses segment-aware real-path ancestry, never string-prefix matching.
It MUST NOT fall back to ts.sys, default-host I/O, or Node resolution for an
outside-root path. Tool-owned TypeScript libraries, if needed, are an explicit
immutable allowlist and can never produce demand facts. Outside-root targets
are opaque diagnostics; their source and configuration are not read. Cache
lookup occurs only after current real-path/root-membership validation.

### 7.4 Custom wrappers

Users may define schema-validated declarative accessor rules, including module
name, exported symbol, argument index, reference kind, and runtime context.
The initial release has no arbitrary JavaScript plugin API and no remote rule
packs. An accessor rule that accepts a key argument must preserve its
DynamicKeyDomain; it cannot turn an unresolved or user-controlled argument into
an exact key.

## 8. Discovery, boundaries, and scale

- Traverse only beneath explicit user-approved roots after resolving their real
  paths. A user can add another first-party root explicitly; it is never
  inferred from an import.
- Respect gitignore and an explicit tool ignore file as traversal policy.
- Exclude VCS metadata, dependencies, submodules, build output, generated and
  minified artifacts, binaries, special files, and directory symlinks by
  default.
- Exclude prose/documentation extensions by default.
- Discover workspace packages, package entrypoints, TypeScript projects, and
  explicit component declarations.
- Prefer explicit component configuration, then workspace packages, then
  clearly labeled conventional directory inference.
- Tag server, client, edge, worker, build, test, CLI, and unknown surfaces
  when evidence exists.
- Emit a coverage manifest for skipped/unreadable files and parse failures.

Outside-root imports and runtime dependencies are intentionally out of scope.
They are reported as out-of-scope diagnostics but never become first-party
demand, dynamic uncertainty, or an inventory-reconciliation result. This tool
answers which secrets the operator of the approved first-party code must
configure; it does not inventory incidental configuration requirements of
third-party packages.

Coverage is tracked per execution scope and adapter as complete or incomplete.
Relevant ignored/generated source, parse failures, budget exhaustion, unreadable
files, unsupported formats, dynamic bindings, opaque broad bindings, and
unbounded DynamicLookupEdges create scoped uncertainty. Finite/pattern dynamic
lookups affect only their candidate key domain; unbounded lookups affect every
environment key in their own scope. A result with relevant uncertainty is
inconclusive and cannot become a strong absence,
missing-under-declared-model, or strong legacy-candidate result. The command
exposes --require-complete for CI and closed-model reconciliation.

Dynamic inference has an explicit maxFiniteKeyDomain and pattern-expansion
budget. Exceeding either limit produces one scoped over-budget uncertainty; the
tool never reports a truncated first subset of possible keys.

For scale, discovery streams files and filters by extension before reading.
Parsing uses a bounded worker pool; workers discard ASTs and source text after
producing facts. The import graph is built only for relevant source and
entrypoint paths. Optional cache entries contain facts only. Syntax facts are
cached separately from semantic/correlation facts. Syntax-cache identity
includes schema revision, extraction-contract revision, parser/backend semantic
revision, non-reportable file-content fingerprint, canonical real path/root
membership, language, SafeFactFactory grammar/allowlist/safe-path-policy
revisions, and applicable declarative extractor rules. Semantic
cache identity includes syntax identities plus every transitive resolver,
tsconfig/reference, component, root/ignore, wrapper-rule, adapter,
binding-model, and scan-mode input.

Entries are schema- and input-fingerprint-validated before use; deleted,
renamed, or no-longer-approved files cannot be replayed. Persistent entries use
a versioned schema and atomic write/replace semantics; corrupt, truncated,
version-mismatched, or wrong-fingerprint entries are discarded and recomputed.

## 9. Normalized data model

The conceptual model is:

~~~ts
type ReferenceResolution =
  | "literal"
  | "constant-folded"
  | "wrapper-resolved"
  | "dynamic";

type Phase = "runtime" | "build" | "test" | "dev" | "ci" | "unknown";

type StagePredicate =
  | { kind: "exact"; values: SafeIdentifier[] }
  | { kind: "all" }
  | { kind: "unknown" };

type DeliveryChannel =
  | "environment"
  | "build-substitution"
  | "mounted-file"
  | "provider-sdk"
  | "unknown";

type SafeIdentifier = string & { readonly __brand: "SafeIdentifier" };
type SafePath = string & { readonly __brand: "SafePath" };
type SafeDiagnosticCode = string & { readonly __brand: "SafeDiagnosticCode" };
type SafeTimestamp = string & { readonly __brand: "SafeTimestamp" };

interface OpaqueIdentifier {
  kind: "opaque";
  reason: "unsafe-identifier";
}

type Identifier = SafeIdentifier | OpaqueIdentifier;

interface Position {
  line: number;
  column: number;
}

interface Location {
  file: SafePath;
  start: Position;
  end: Position;
}

interface Evidence {
  ruleId: SafeIdentifier;
  diagnosticCode: SafeDiagnosticCode;
  locations: Location[];
}

interface LogicalKey {
  namespace: "env" | "config" | "secret-manager";
  name: Identifier;
}

interface ExecutionScope {
  id: SafeIdentifier; // Canonical component/workload/container-or-entrypoint identity.
  componentId: SafeIdentifier;
  phase: Phase;
  stage: StagePredicate;
  channel: DeliveryChannel;
}

interface ConditionClause {
  key: SafeIdentifier;
  operator: "equals" | "not-equals";
  value: SafeIdentifier;
}

type ConditionPredicate =
  | { kind: "always" }
  | { kind: "all"; clauses: ConditionClause[] }
  | { kind: "unknown" };

interface ScopeSelector {
  executionUnitIds?: SafeIdentifier[];
  phases?: Phase[];
  stage: StagePredicate;
  channels?: DeliveryChannel[];
  condition: ConditionPredicate;
}

type DemandKind =
  | "direct-read"
  | "eager-validation"
  | "declaration-only"
  | "wrapper-definition"
  | "literal-indicator";

interface ProviderResourceId {
  authorityId: SafeIdentifier; // Adapter-defined provider/account/project/endpoint authority.
  canonicalId: SafeIdentifier; // Adapter-defined full resource identity, including selector.
}

interface SecretReference {
  id: SafeIdentifier;
  requested: LogicalKey;
  demand: DemandKind;
  operation: "read" | "validate" | "wrapper" | "literal";
  resolution: ReferenceResolution;
  confidence: "high" | "medium" | "review";
  location: Location;
  exposure: "server" | "client" | "worker" | "tooling" | "unknown";
  evidenceChain: Evidence[];
}

interface DemandEdge {
  id: SafeIdentifier;
  referenceId: SafeIdentifier;
  scope: ExecutionScope;
  origin: "direct" | "consumer-derived";
  evidenceChain: Evidence[];
}

type SafeKeyPattern =
  | {
      kind: "prefix";
      patternId: SafeIdentifier;
      prefix: SafeIdentifier;
    }
  | {
      kind: "suffix";
      patternId: SafeIdentifier;
      suffix: SafeIdentifier;
    }
  | {
      kind: "surrounded";
      patternId: SafeIdentifier;
      prefix: SafeIdentifier;
      suffix: SafeIdentifier;
    };

type DynamicKeyDomain =
  | { kind: "finite"; keys: SafeIdentifier[] }
  | { kind: "pattern"; pattern: SafeKeyPattern }
  | { kind: "unbounded"; reason: "user-controlled" | "opaque" | "over-budget" };

type DynamicKeyOrigin = "lexical" | "user-controlled" | "opaque";

interface DynamicLookupEdge {
  id: SafeIdentifier;
  referenceId: SafeIdentifier;
  scope: ExecutionScope;
  domain: DynamicKeyDomain;
  origin: DynamicKeyOrigin;
  patternConstraint?: "adapter-proven" | "not-proven";
  likelyKeys: LogicalKey[]; // Empty for an unbounded domain.
  evidenceChain: Evidence[];
}

interface BindingCandidate {
  id: SafeIdentifier;
  adapterId: SafeIdentifier;
  scope: ExecutionScope;
  destination: LogicalKey;
  sourceKind: "manifest" | "secret-manager" | "external";
  providerResourceId?: ProviderResourceId;
  appliesWhen: ScopeSelector;
  precedence: {
    source: SafeIdentifier;
    rank?: number;
    comparable: boolean;
  };
  resolution: "exact" | "dynamic";
  location?: Location;
}

interface BindingResolution {
  scope: ExecutionScope;
  destination: LogicalKey;
  partitions: Array<{
    appliesWhen: ScopeSelector;
    outcome: "effective" | "conflicting" | "unresolved";
    selections: Array<{
      candidateId: SafeIdentifier;
      status: "effective" | "shadowed" | "inapplicable" | "conflicting" | "unresolved";
    }>;
  }>;
  accessEvidence: "not-evaluated"; // Version one never claims provider access.
}

interface InventoryItem {
  providerResourceId: ProviderResourceId;
  declaredScopes?: ExecutionScope[];
}

interface InventorySnapshot {
  authorityId: SafeIdentifier;
  asOf: SafeTimestamp; // Schema-validated ISO-8601 timestamp supplied by the local export.
  items: InventoryItem[];
}

interface CoverageGap {
  id: SafeIdentifier;
  domain: "demand" | "binding" | "inventory";
  inputId: SafeIdentifier;
  pathOrAdapterId: SafePath | SafeIdentifier;
  potentiallyAffects: ScopeSelector;
  reason: SafeDiagnosticCode;
}

interface ScopeCoverage {
  scope: ExecutionScope;
  state: "complete" | "incomplete";
  gapIds: SafeIdentifier[]; // References CoverageGap.id.
}

interface AggregateResult {
  targetDiscovery:
    | "deployable"
    | "consumer-derived"
    | "internal-only"
    | "external-consumer-possible"
    | "unknown-target";
  demand:
    | "present"
    | "declaration-only"
    | "finite-dynamic"
    | "pattern-dynamic"
    | "unbounded-user-controlled"
    | "unbounded-unknown"
    | "absent";
  binding:
    | "exact-declared"
    | "possible"
    | "indirect"
    | "conflicting"
    | "unresolved"
    | "no-static-evidence"
    | "external-unknown"
    | "static-constrained"
    | "dynamic"
    | "not-applicable";
  inventory:
    | "bound"
    | "inventory-listed-no-static-read"
    | "missing"
    | "missing-under-declared-model"
    | "unbound"
    | "unknown";
  inventorySnapshot?: Pick<InventorySnapshot, "authorityId" | "asOf">;
  coverage: "complete" | "incomplete";
  constraint: "none" | "client-exposure" | "out-of-scope" | "other";
  disposition: "informational" | "review" | "inconclusive";
}
~~~

Values, source snippets, value hashes, and secret material are forbidden from
all types. Aggregate records retain occurrence counts, direct and effective
consumers, target/binding status, inventory relation, coverage, confidence
reasons, and dynamic warnings. Environment-key case is preserved; variants are
reported for review rather than silently merged.

OpaqueIdentifier cannot participate in equality, demand, binding, inventory, or
cache-key joins. It produces scoped uncertainty only.

One SecretReference may produce many DemandEdge records: for example, one
shared-library read can reach api/production and worker/staging. Reconciliation
operates on DemandEdge records, so a binding for one consumer never satisfies
another consumer's demand.

One dynamic source reference may likewise produce many DynamicLookupEdge
records. Finite and pattern domains retain only SafeFactFactory-approved likely
keys. An unbounded edge retains no key list and creates uncertainty over every
environment key in its own execution scope, never in a different component,
phase, stage, or channel. Its origin distinguishes user-controlled from opaque
input for reporting without changing the containment scope.

For a pattern domain, SafeFactFactory creates a deterministic safe patternId
from the access site and normalized safe pattern. It is the only identifier a
closed-model rule may use to expand that access; matching displayed pattern
text is never sufficient.

A SafeKeyPattern has exactly one wildcard and at least one non-empty fixed safe
prefix or suffix. SafeFactFactory validates every dynamic fact before it is
stored: finite likelyKeys must be the de-duplicated finite domain; pattern
likelyKeys must be safe, scope-compatible binding-destination or explicit-model
keys that match that exact pattern; and unbounded likelyKeys must be empty.
Invalid, duplicated, over-budget, or pattern-mismatched model candidates are
rejected as scoped uncertainty rather than serialized. In particular, an
arbitrary dynamic key cannot be represented as a zero-segment pattern or
expanded from an inventory.

Inventory is never a binding source. A bound inventory result requires both
authorityId and canonicalId to be byte-for-byte equal between the effective
BindingCandidate and an InventoryItem; logical-key/name equality is forbidden
as a fallback. Canonical IDs are adapter-produced and include every
provider-specific identity dimension and field/version selector. Reports phrase
inventory-only conclusions as listed in the named InventorySnapshot as of its
asOf timestamp.

BindingResolution partitions candidate stage/condition space for one execution
scope and destination, even when no code demand exists. It is exact-declared
for a DemandEdge only when every finite partition relevant to that edge has one
compatible effective winner. An unknown phase, stage, channel, condition, or
unordered cross-adapter precedence yields unresolved/possible rather than
exact-declared.

Coverage is derived from expected closed-model inputs and CoverageGap records.
A gap assigned to a scope blocks strong absence only for that scope; an
unassignable gap under a declared root blocks every closed scope under that
root. A required binding-adapter/inventory input failure blocks the affected
binding/inventory conclusions. --require-complete fails whenever a gap overlaps
its requested scope.

Input and output schemas are versioned. Binding inputs reject duplicate,
unorderable mappings for the same scope and destination rather than choosing
one arbitrarily. A conflict is a result, not an exact-declared binding.

StagePredicate exact lists concrete names; all means every stage explicitly
declared for the execution unit in the model; unknown never satisfies an
exact-declared join. Binding accessEvidence is always not-evaluated in version
one. Future policy analysis may add a separate access-evidence axis but cannot
upgrade a mapping into a runtime guarantee.

## 10. Reports and CLI

Suggested commands:

~~~text
secret-usage scan .
secret-usage explain env:DATABASE_URL
secret-usage scan . --format json --out usage.json
secret-usage reconcile --root . --inventory secrets.json --bindings bindings.json
secret-usage reconcile --scan-report usage.json --inventory secrets.json --bindings bindings.json
secret-usage reconcile --root . --inventory secrets.json --bindings bindings.json \
  --closed-model provisioning-model.json --require-complete
~~~

Reconcile accepts exactly one of --root or --scan-report. Its inventory,
binding, and closed-model inputs have a required schemaVersion and contain
logical IDs, scopes, stages, mappings, and declared authority only. They MUST
NOT contain values. Invalid, conflicting, or unsupported input is a distinct
failure from an incomplete scan or a policy finding.

Default output is deterministic and contains relative locations and evidence,
not values or source snippets:

~~~text
Reference              Target             Demand       Binding          Inventory                     Coverage    Disposition
env:DATABASE_URL       api, worker        present      exact-declared   bound                         complete    informational
env:TEST_AUTH_TOKEN    api-tests          present      no-static-evidence missing                       complete    review
env:SERVICE_*          worker             pattern-dynamic possible      unknown                       complete    review
env:*                  api                unbounded-user-controlled dynamic unknown                 incomplete  inconclusive
env:LEGACY_API_KEY     api                absent       exact-declared   inventory-listed-no-static-read complete review
~~~

The tool supports name/path redaction for repositories where topology or
logical names are sensitive. JSON/SARIF include the AggregateResult axes:
target discovery, demand, binding, inventory, coverage, constraint, and
disposition. A renderer MUST NOT move a value from one axis into another.
Every inventory-derived relation includes its InventorySnapshot authorityId and
asOf value; terminal summaries display the snapshot identity without a secret
value.

Dynamic lookups have a dedicated report section and are never hidden by
aggregation. Each entry includes its location, scope, domain, safe provenance
category, and either likely keys/pattern or the explicit statement "may read
any environment key in this scope". --explain shows the bounded inference
chain without source snippets or input values. Pattern entries expose their
safe patternId so a closed model can target that access site precisely.

~~~text
Dynamic environment lookups
  api / runtime / production
    unbounded user-controlled lookup at <safe-location>
    provenance: request-query
    may read any environment key in this scope
    effect: all env-key cleanup conclusions here are inconclusive

  worker / runtime / production
    pattern lookup SERVICE_*
    likely keys: SERVICE_US, SERVICE_EU
    effect: only matching destination-key conclusions require review
~~~

CLI exit semantics are stable: invalid input is distinct from incomplete
coverage, and policy failures are opt-in through an explicit --fail-on value.
No default exit status asserts that a secret may be deleted.

## 11. Privacy and secure-locality requirements

- No HTTP, telemetry, analytics, crash reporting, update checks, cloud login,
  or remote inventory lookup.
- Never read current process-environment values.
- When environment-file inventory is explicitly requested, extract only
  left-hand-side names and immediately discard values.
- Never print source snippets, parser text, literal values, or secret-value
  hashes in output, diagnostics, fixtures, snapshots, or caches.
- Do not write a report unless requested; use owner-readable permissions where
  the platform supports them.
- Bound file count, total bytes, depth, per-file size, parse time, and worker
  count. Sanitize terminal paths and diagnostics.
- Do not follow symlinks by default and skip devices, FIFOs, sockets, and
  unreadable files.
- Cache only normalized facts, never source text or secret material. A
  non-reportable file-content cache key is permitted; a secret value or its
  hash is not.
- Ship without postinstall; pin dependencies and publish an SBOM, provenance,
  and SECURITY.md.

## 12. MVP and roadmap

### MVP

- TypeScript/JavaScript AST scan.
- Exact environment reads, destructuring, local aliases, and static strings.
- Workspace component grouping and runtime/phase tags.
- Shared-use aggregation and dynamic-access reporting.
- Local inventory and binding-manifest reconciliation.
- Approved first-party roots only; outside-root imports and dependencies are
  explicit out-of-scope diagnostics.
- Target and binding statuses, including internal-only, no-static-evidence,
  and exact-declared.
- Terminal and versioned JSON output.
- No-network, no-execution, and no-value-leak regression tests.

### Next

- One-hop wrapper/import resolution and explicit component configuration.
- Common framework/configuration accessor rules.
- Effective-consumer import-graph analysis.
- Persistent fact cache and watch mode.
- Data-only deployment/IaC adapters.
- Optional static IaC permission evidence, reported separately from a declared
  mapping and never as a runtime guarantee.

### Later

- Additional language adapters.
- A separate, opt-in redacted hard-coded-secret indicator.
- Explicit user-controlled local runtime tracing of key names only.

## 13. Acceptance criteria

- A direct process.env.FOO read aggregates under env:FOO and retains every
  source occurrence.
- A safe constant-computed key resolves; an unknown one becomes dynamic rather
  than a fabricated finding.
- A finite dynamic key set is reported as possible/likely keys and blocks
  strong absence only for those keys in that scope.
- A pattern dynamic key reports only matching in-scope binding destination keys
  or explicit model-domain keys as likely candidates; it never invents names.
- A user-controlled unbounded key is prominently flagged, reports no candidate
  keys, and makes every environment-key absence claim in its own scope
  inconclusive.
- Two distinct deployable consumers of one key are marked shared.
- A shared-library read with no local leaf consumer is internal-only or
  external-consumer-possible, never falsely marked injectable.
- A binding is exact-declared only when an effective candidate covers the
  execution unit, phase, stage, delivery channel, and destination key.
- A version-one exact-declared binding never claims provider permission,
  delivery, or runtime success.
- An inventory-listed resource with no compatible static code demand is
  reported as inventory-listed-no-static-read; a binding never suppresses that
  result.
- Strong absence findings require a valid closed-model manifest and complete
  scoped coverage. A skipped or opaque relevant input makes the result
  inconclusive.
- An outside-root import/runtime dependency does not contribute first-party
  demand or alter inventory reconciliation.
- A known client exposure restriction is static-constrained and explains the
  adapter rule.
- A mounted file/SDK binding does not satisfy an environment read without an
  observed mapping.
- No report, cache, diagnostic, or test snapshot contains a fixture secret
  value.
- The scanner makes no network request and executes no repository code.

## 14. Verification matrix

The repository MUST contain fixtures and automated assertions for every row
below. Each assertion checks terminal output, JSON output, SARIF where
applicable, coverage/disposition, and exit behavior; it does not merely inspect
an internal AST.

### 14.1 Typed join and scope

| Scenario | Required result |
| --- | --- |
| Same destination key, different provider account/project, region/namespace, resource, or selector | No inventory join. |
| Runtime environment read versus build-only ARG, mounted file, provider SDK, sidecar, or test-only binding | No exact-declared join. |
| Preview-only binding with production demand | Production scope remains uncovered. |
| Production maps to resource A and staging maps to resource B | Each finite stage partition selects and reports only its own winner. |
| Unknown stage/channel/target/provider selector | Inconclusive, never exact-declared. |
| Exact provider-resource mapping to a demanded destination | Bound only in the matching execution scope. |
| One shared-library reference reaches api/production and worker/staging | Two DemandEdge records; api binding cannot satisfy worker demand. |
| Inventory export is stale or has a different authorityId | Conclusion is labeled with snapshot authority/asOf or does not join. |

### 14.2 Demand, bindings, and coverage

| Scenario | Required result |
| --- | --- |
| Inventory resource is effectively bound but has no first-party direct/eager read | inventory-listed-no-static-read. |
| Passive schema declaration or wrapper definition names a key | Does not suppress inventory-listed-no-static-read. |
| Eager validation reads a key at startup | Counts as demand with adapter evidence. |
| Conditional local key selects FOO or BAR | Reports FOO and BAR as finite possible keys; only those absence claims are blocked. |
| SERVICE_ plus a finite/inferred region and matching SERVICE_US/SERVICE_EU binding destination keys | Reports the constrained pattern and those likely candidates, not unrelated keys. |
| SERVICE_ plus request.query.region plus a safe fixed suffix | pattern domain with user-controlled origin, not automatically unbounded. |
| Pattern has no matching in-scope binding destination/model key | Reports the pattern without inventing a candidate name. |
| Closed model supplies a finite SERVICE_* domain and a trusted adapter proves the selector enum | Expands only the declared finite safe keys; inventory observations alone never close the pattern. |
| User-controlled SERVICE_* pattern plus a finite closed-model domain but no proven selector constraint | Remains pattern uncertainty; a manifest alone cannot bound the input. |
| Two same-scope SERVICE_* accesses with different pattern IDs; closed model declares one ID | Only the declared access expands; the other remains pattern uncertainty. |
| process.env[request.query.key] or another zero-fixed-segment expression | Must serialize as unbounded, never as a pattern. |
| Closed model proposes DB_URL for a SERVICE_* pattern | Rejects the non-matching candidate; it cannot become likely or a finite expansion. |
| Dynamic fact has duplicate/over-budget candidates, or finite likelyKeys differ from its finite domain | SafeFactFactory rejects the invalid fact and records scoped uncertainty; no partial candidate list is emitted. |
| request.query.key cast to an A_KEY or B_KEY TypeScript union | Remains unbounded user-controlled; a type assertion is not finite runtime evidence. |
| process.env[request.query.key], process.env[argv[2]], stdin-derived key, exported parameter with unresolved callers, or Object.keys(process.env) | Prominent unbounded finding; no named candidates; all environment-key absence claims only in that scope are inconclusive. User-controlled origin is shown when proven. |
| Unbounded lookup in worker and a clean api scope | Worker is inconclusive; api remains independently eligible for strong absence. |
| Finite union or explicit pattern domain exceeds its budget | One scoped over-budget uncertainty; no first-N candidate list. |
| Dynamic read or binding without proven user control | unbounded-unknown; affected scope/key domain is inconclusive. |
| Kubernetes envFrom-like binding with a known key inventory | Expands only those keys in its scope. |
| Broad envFrom-like binding with no key inventory | Affects only its scope as possible/uncertain. |
| Ignored/generated source, parser failure, unreadable file, exhausted budget, or unscanned declared adapter root | Affected scope is incomplete; --require-complete fails. |
| Parse failure in api, worker-only failure, and unassignable root-level failure | Respectively block api only, worker only, and every closed scope under that root. |

### 14.3 Binding precedence and consumers

| Scenario | Required result |
| --- | --- |
| CI workflow environment overridden by job/step environment | Only the platform-effective binding can be exact-declared. |
| Compose environment overrides env_file | Partition outcome is effective; environment is selected effective and env_file is retained as shadowed evidence. |
| Docker builder-stage ARG and final-image ENV | Builder-only value cannot satisfy runtime demand. |
| Branch equals main and branch not-equals main candidates | Two disjoint finite condition partitions each select only their applicable winner. |
| Two unordered/contradictory mappings | conflicting and inconclusive, never arbitrarily selected. |
| Shared library has local consumers and a possible external consumer | Local consumers are reported; external-consumer-possible is a target fact, not binding evidence. |

### 14.4 Privacy, scope, parser, and cache

| Scenario | Required result |
| --- | --- |
| A sentinel credential appears in a computed bracket key, malformed config, parse error, or wrapper argument | Sentinel never appears in stdout, stderr, JSON, SARIF, diagnostics, snapshots, or cache. |
| A lowercase secret-shaped dot property, bracket literal, destructuring key, constant-folded key, or accessor argument | Each becomes opaque and never leaks. |
| A trusted allowlisted lowercase key | Remains a configured safe key. |
| OXC and TypeScript parse the same supported fixture | Equivalent normalized facts, locations, and dispositions. |
| One adapter cannot support a fixture | Explicit unsupported-syntax coverage failure; no silent clean result. |
| tsconfig extends/project reference/typeRoot/path alias/package export resolves outside approved roots, including root/app-old beside root/app | No outside source/config is opened; out-of-scope diagnostic only. |
| Sentinel appears in an IaC/binding input, wrapper rule, parser diagnostic, or src/sk_live_SENTINEL.ts path component | SafeFactFactory prevents it from crossing into facts, worker messages, output, or cache filenames. |
| Source, root/ignore, tsconfig reference, wrapper rule, component, binding model, parser revision, scan mode, or SafeFactFactory policy changes after a cache hit | Affected cache layer is invalidated and recomputed. |
| Interrupted, concurrent, corrupt, version-mismatched, or wrong-fingerprint cache entry | Later scan discards/recomputes it and remains deterministic. |

The test suite also runs with networking blocked and asserts that the CLI does
not execute a fixture module, package script, shell command, or plugin.
