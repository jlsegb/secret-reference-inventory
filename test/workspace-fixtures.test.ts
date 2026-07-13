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
   * Verifies “multi-repository fixture uses safe sibling roots and explicit deployment layouts”.
   *
   * Inputs: no arguments.
   * Outputs: a promise that settles after its awaited workspace operations and assertions.
   * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
   * Side effects: runs `withWorkspaceFixture`.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “multi-repository fixture uses safe sibling roots and explicit deployment layouts”.
     *
     * Inputs: `fixture`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs `realpath`, `relative(controlRoot, apiRoot).split(sep).join`, `relative(controlRoot, apiRoot).split`, `relative`, `assert.equal`, `readFile`.
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
           * Projects a report value from the current deployment.
           *
           * Inputs: `deployment`.
           * Outputs: the `deployment.repositories` result consumed by `unrelated.value.deployments.map`.
           * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
           * Side effects: none; it derives the current-item result.
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
   * Exercises the “fixture isolates parser failure and user-controlled lookup behavior” scenario through `withWorkspaceFixture`, `all`, `scanLocalRoot`, `equal`, `some`.
   *
   * Inputs: No callback parameters; it closes over the fixture and imports established for “fixture isolates parser failure and user-controlled lookup behavior”.
   * Outputs: Normal completion only after the “fixture isolates parser failure and user-controlled lookup behavior” assertions hold; setup, assertion, and awaited-operation failures propagate.
   * Does not handle: It neither invokes the CLI nor leaves fixture state behind; it creates and examines only the temporary layout owned by `withWorkspaceFixture`.
   * Side effects: Runs assertions through `withWorkspaceFixture`, `all`, `scanLocalRoot`, `equal`, `some`; assertion failures escape.
   */
  async () => {
  await withWorkspaceFixture(
    /**
     * Verifies “fixture isolates parser failure and user-controlled lookup behavior”.
     *
     * Inputs: `fixture`.
     * Outputs: a promise that settles after its awaited workspace operations and assertions.
     * Does not handle: register a separate test, invoke an installed binary, or expose a production listener.
     * Side effects: runs `Promise.all`, `scanLocalRoot`, `assert.equal`, `broken.result.scopeCoverage.some`, `assert.deepEqual`.
     */
    async (fixture) => {
    const [broken, dynamic] = await Promise.all([
      scanLocalRoot(fixture.repositoryRoots.broken),
      scanLocalRoot(fixture.repositoryRoots.dynamic),
    ]);

    assert.equal(
      broken.result.scopeCoverage.some(
        /**
         * Tests the current coverage against the requested condition.
         *
         * Inputs: `coverage`.
         * Outputs: the `coverage.state === "incomplete"` result consumed by `broken.result.scopeCoverage.some`.
         * Does not handle: visit sibling items, modify the outer assertion, or perform I/O.
         * Side effects: none; it derives the current-item result.
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
