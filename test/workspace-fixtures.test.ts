import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

import { scanLocalRoot } from "../src/app/index.js";
import { isSecretLikeToken } from "../src/safety/index.js";
import { parseWorkspaceManifestText } from "../src/workspace/index.js";

import {
  withWorkspaceFixture,
  writeFixtureLayout,
} from "./helpers/workspace-fixture.js";

test("multi-repository fixture uses safe sibling roots and explicit deployment layouts",
  /**
 * Verifies the callback behavior for “multi-repository fixture uses safe sibling roots and explicit deployment layouts”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `realpath`, `join`, `split`, `relative`, `equal`, `readFile`, `parseWorkspaceManifestText`, `deepEqual`, `map`.
 * Outputs: A promise that resolves only after 5 equal, 2 deepEqual assertion groups establish “multi-repository fixture uses safe sibling roots and explicit deployment layouts”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “multi-repository fixture uses safe sibling roots and explicit deployment layouts”.
 * Inputs: Receives `fixture` from its caller. It invokes `realpath`, `join`, `split`, `relative`, `equal`, `readFile`, `parseWorkspaceManifestText`, `deepEqual`, `map`, `writeFixtureLayout`.
 * Outputs: A promise that resolves only after 5 equal, 2 deepEqual assertion groups establish “multi-repository fixture uses safe sibling roots and explicit deployment layouts”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const apiRoot = await realpath(fixture.repositoryRoots.api);
    const controlRoot = await realpath(fixture.controlRoot);
    const sibling = relative(controlRoot, apiRoot).split(sep).join("/");
    assert.equal(sibling, "../api");

    const unrelatedText = await readFile(fixture.manifestPath, "utf8");
    const unrelated = parseWorkspaceManifestText(unrelatedText);
    assert.equal(unrelated.ok, true);
    if (unrelated.ok) {
      assert.deepEqual(
        unrelated.value.deployments.map(
          /**
           * Extracts each parsed deployment's repository list for fixture-layout verification.
           *
           * Inputs: `deployment`.
           * Outputs: The current parsed deployment's declared `repositories` array.
           * Does not handle: Parsing the manifest, examining other deployment objects, or writing fixtures.
           * Side effects: Reads one parsed value property without mutation or I/O.
           */
          (deployment) => deployment.repositories),
        [["api"], ["worker"], ["dynamic"], ["broken"]],
      );
    }

    await writeFixtureLayout(fixture, "shared");
    const shared = parseWorkspaceManifestText(await readFile(fixture.manifestPath, "utf8"));
    assert.equal(shared.ok, true);
    if (shared.ok) {
      assert.deepEqual(shared.value.deployments[0]?.repositories, ["api", "worker"]);
    }

    assert.equal(isSecretLikeToken(fixture.privateSourceMarker), false);
    const source = await readFile(fixture.repositoryRoots.api + "/src/index.ts", "utf8");
    assert.equal(source.includes(fixture.privateSourceMarker), true);
  });
});

test("fixture isolates parser failure and user-controlled lookup behavior",
  /**
 * Verifies the callback behavior for “fixture isolates parser failure and user-controlled lookup behavior”.
 * Inputs: Receives no direct parameters and closes over the enclosing test state. It invokes `withWorkspaceFixture`, `all`, `scanLocalRoot`, `equal`, `some`, `deepEqual`.
 * Outputs: A promise that resolves only after 6 equal, 1 deepEqual assertion groups establish “fixture isolates parser failure and user-controlled lookup behavior”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Verifies the callback behavior for “fixture isolates parser failure and user-controlled lookup behavior”.
 * Inputs: Receives `fixture` from its caller. It invokes `all`, `scanLocalRoot`, `equal`, `some`, `deepEqual`.
 * Outputs: A promise that resolves only after 6 equal, 1 deepEqual assertion groups establish “fixture isolates parser failure and user-controlled lookup behavior”; setup, assertion, and awaited-operation failures propagate.
 * Does not handle: Fixture allocation and recursive cleanup are owned by `withWorkspaceFixture`; Node’s test runner owns registration and timeout policy.
 * Side effects: Runs assertions and reads test-local state; `withWorkspaceFixture` removes its fixture root. Failures are not caught.
 */
    async (fixture) => {
    const [broken, dynamic] = await Promise.all([
      scanLocalRoot(fixture.repositoryRoots.broken),
      scanLocalRoot(fixture.repositoryRoots.dynamic),
    ]);

    assert.equal(
      broken.result.scopeCoverage.some(
        /**
         * Detects the incomplete coverage record expected from the broken fixture repository.
         *
         * Inputs: `coverage`.
         * Outputs: True exactly for a coverage entry whose state is `incomplete`.
         * Does not handle: Aggregating coverage, changing the report, or evaluating other entries.
         * Side effects: Reads the entry state without mutation or I/O.
         */
        (coverage) => coverage.state === "incomplete"),
      true,
    );

    const lookups = dynamic.reconciliationInput.dynamicLookupEdges ?? [];
    assert.equal(lookups.length, 1);
    const lookup = lookups[0];
    assert.equal(lookup?.domain.kind, "unbounded");
    assert.equal(lookup?.domain.kind === "unbounded" && lookup.domain.reason, "user-controlled");
    assert.deepEqual(lookup?.likelyKeys, []);
    assert.equal(dynamic.result.records[0]?.demand, "unbounded-user-controlled");
    assert.equal(dynamic.result.records[0]?.coverage, "incomplete");
  });
});
