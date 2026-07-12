# Secret Reference Inventory — Implementation Tracker

## Operating mode

The coordinator owns task decomposition, dependency management, review intake,
verification scheduling, and this tracker. Implementation changes are made only
by delegated agents.

Repository baseline: architectural specification only; no application scaffold
exists yet. The initial target is the MVP in SPEC.md. Work must remain local:
no telemetry, networking, repository-code execution, or secret-value output.

## Delivery rules

- Each workstream owns its listed paths and must not reformat or alter another
  workstream's files without coordination.
- Agents must add focused automated tests with their work and report commands
  run, changed files, unresolved decisions, and handoff dependencies.
- Shared contracts belong to Core. Other workstreams should depend only on
  exported Core interfaces and flag any needed contract before changing them.
- The coordinator records integration order and assigns a separate agent to
  integration verification after the first wave.

## Workstream board

| ID | Workstream | Owner | Owned paths | Depends on | Status | Completion evidence |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Tool foundation and safe local boundary | verify_security_fixes | package files, src/cli, src/discovery, src/safety | none | complete | build/test commands, root containment and no-value-leak tests |
| W2 | Normalized core model, dynamic-domain validation, aggregation, reconciliation | verify_reconciliation_fixes | src/core | none | complete; integration verification queued | unit tests for exact/finite/pattern/unbounded and typed joins |
| W3 | Binding/closed-model manifest adapter | validate_injection | src/binding-adapters | W2 contracts | complete | manifest parsing and scope/precedence/coverage tests |
| W4 | TypeScript/JavaScript reference extraction | ts_extraction | src/ts-adapter, test fixtures for source extraction | W1 scaffold/source materializer, W2 contracts | complete | exact/static/dynamic extraction tests |
| W5 | Reporters and end-to-end CLI integration | verify_reconciliation_fixes + verify_security_fixes | src/reporters, src/app, CLI wiring, integration fixtures | W1–W4 | complete | terminal/JSON output and end-to-end acceptance tests |
| W6 | Adversarial integration verification and tracker closeout | integration_review + verify_security_fixes | tests only unless a delegated fix is explicitly assigned | W1–W5 | complete; remediations verified | regression matrix, coverage report, remaining-risk summary |
| W7 | Public-package/release readiness | verify_security_fixes | package metadata and release-only docs/tests | W1–W6 | complete; not published | publishable package metadata, local-only defaults, release checklist |

## First-wave coordination

1. W2 publishes stable TypeScript contracts early; W1 and W3 use them without
   changing Core-owned files.
2. W1 establishes the executable project skeleton and safety primitives.
3. W3 implements only data-only binding/model ingestion and leaves reporting to
   W5.
4. Once W1 and W2 expose their contracts, W4 starts immediately with the most
   relevant available agent.

## Status log

| Time | Update |
| --- | --- |
| 2026-07-12 | Tracker created; first-wave implementation delegation pending. |
| 2026-07-12 | W1, W2, and W3 delegated to existing agents with relevant validation context. W4 waits for W1/W2 contracts. |
| 2026-07-12 | Contract ownership clarified: W1 owns safety brands/factory and remains Core-independent; W2 imports or re-exports them and owns normalized facts/reconciliation; W3 uses an injected adapter boundary until W2 lands. |
| 2026-07-12 | Circular-dependency guard added: src/safety/types.ts is Core-independent; Core imports/re-exports only those brands and exposes structural validation hooks; src/safety/factory.ts may implement those hooks after importing Core. |
| 2026-07-12 | W3 parsing boundary recorded: schema parsers emit only validated candidate shapes through injected materializers; binding resolution stays an injected Core port. No raw source/config strings cross the boundary. |
| 2026-07-12 | W1 landed the TypeScript/package scaffold and Core-independent safety primitive exports. W3 landed its adapter contract façade. W2 has been directed to consume the safety import path before publishing Core facts. |
| 2026-07-12 | W2 published its Core type boundary. W1 and W3 were given the import path. W4 is now dependency-ready and will be assigned to a fresh extractor-focused agent when a concurrency slot opens. |
| 2026-07-12 | Dynamic-model trust decision: a user-provided closed-model manifest cannot prove a selector bound. Its declared domains must not become Core finite expansions; only a future trusted source adapter may supply adapter-proven constraints. A well-formed unproven declaration produces a fixed diagnostic, not a coverage gap; malformed/unsupported model input that blocks validation maps to binding coverage, preserving the Core demand/binding/inventory vocabulary. |
| 2026-07-12 | W4 integration gate added: source AST extraction must enter facts through a Core-declared source materialization port implemented by Safety, rather than constructing references/dynamic edges directly. W2 and W1 are extending their contracts before W4 begins. |
| 2026-07-12 | W2 published CoreSourceFactBuilder/FullCoreFactBuilder. W1 is now implementing the corresponding safety materializer; W4 remains queued until that implementation and an agent slot are both available. |
| 2026-07-12 | W3 completed with six focused tests passing. Its closed-model metadata retention gap was assigned to W2. A fresh W4 TypeScript-extraction agent was launched using the freed concurrency slot. |
| 2026-07-12 | W1 repaired the NodeNext test workflow by switching the test script to tsx. W2 and W4 were notified to use the repaired full test path. |
| 2026-07-12 | W2 added ClosedModelCoverageContract and strict strong-absence gates: a bare closed flag is insufficient without complete expected inputs, authority provenance, and permitted-boundary checks. W1 is wiring the validated materializer; W3 bridge follow-up is deferred until a slot opens. |
| 2026-07-12 | Closed-model follow-up identified: expected adapter inputs need an explicit unique inputId. AdapterId must never be substituted, because that could falsely satisfy coverage after an ID collision. W1/W2 keep the strict Core contract; W3 will add schema/parser support when capacity opens. |
| 2026-07-12 | W2 handed off with 11 focused Core tests passing. W3 was reactivated for the explicit inputId schema/bridge correction; full integration verification remains queued after W1/W3/W4 land. |
| 2026-07-12 | W3 follow-up completed: expected adapter input IDs/domains are explicit, validated, deduplicated, and preserved through the Core bridge. Full suite, typecheck, and build passed (32 tests). |
| 2026-07-12 | W1 completed safety, discovery, CLI shell, and source-fact materialization. Baseline repository verification passed (32 tests). W4 received the concrete handoff. |
| 2026-07-12 | Release note recorded: the scaffold currently has private package metadata. Before handoff as a public local tool, W7 must make an explicit publishability decision and verify that exports/defaults remain local-only. |
| 2026-07-12 | W4 published its safe TypeScript extractor interface and initial passing integration test. W5 reporters published terminal/JSON/SARIF/explain functions with four focused tests. W1 was reactivated to compose the local CLI end-to-end. |
| 2026-07-12 | W5 reporter implementation completed with four focused tests. An independent W6 adversarial integration review started while W4 extraction and W5 CLI composition remain active. |
| 2026-07-12 | W6 found a P1 closed-model integration defect: safety materialization dropped inventory inputId required by Core authority gating. A narrow W1 fix with an end-to-end regression has been assigned. |
| 2026-07-12 | W1 preserved/validated inventory inputId in Safety; authoritative closed-model regression remains part of W5. W6 also found a P1 coverage propagation gap from discovery/extraction diagnostics; W1 owns composition-level scoped CoverageGap and --require-complete handling. |
| 2026-07-12 | W6 found a P2 report-boundary no-value-leak bypass: reporter redaction diverges from Safety’s secret-like classifier. The reporter owner will be reactivated to use the shared policy and add terminal/JSON/SARIF/explain sentinel coverage after W6 hands off. |
| 2026-07-12 | W6 found a Core P1 dynamic-domain ambiguity: multiple compatible adapter-proven domains for one pattern currently select the first. Core must reject/conflict-downgrade non-identical declarations so no key is silently omitted from absence/legacy analysis. |
| 2026-07-12 | W6 completed with three remediation items: shared reporter redaction, conflicting finite-domain handling, and conditional binding partition semantics. Agent-capacity limits prevented reactivating the completed Core/reporting agent, so the active W1 integration owner received the focused remediation task. |
| 2026-07-12 | W4’s prioritized direct, finite/pattern, user-controlled unbounded, enumeration, and unsafe-literal cases are green in the shared suite (42 tests). It is finishing edge cases before handoff. |
| 2026-07-12 | W4 found and is fixing per-file fact-ID collision risk. Extraction now accepts a safe composition-provided source ID; W5 must supply a unique non-path ID and test same-key aggregation across files. |
| 2026-07-12 | W4 completed with TypeScript Compiler API extraction plus future OXC seam. It covers direct/static/dynamic/user-controlled/enumeration behavior and source-ID safety; final full verification passed (58 tests). |
| 2026-07-12 | W5/W6 completed: local CLI composition and end-to-end coverage landed; all review remediations passed. Full verify passed with 59 tests, typecheck, and build. W7 release-readiness work is active; no publication authority has been granted. |
| 2026-07-12 | W7 completed: public package metadata, explicit exports/bin, README, MIT license, and release:check are in place. Full verify and package dry-run passed; nothing was staged, committed, or published. |
| 2026-07-12 | Coordinator independently reran npm run verify (59 passing tests, typecheck, build) and npm run release:check (77 allowlisted package files). Working tree remains unstaged and uncommitted. |
