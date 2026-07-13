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
 * Creates the default sibling-root fixture and delegates manifest/root assertions to its fixture callback.
 * Inputs: No callback arguments; calls `withWorkspaceFixture` with its default unrelated deployment layout.
 * Outputs: Resolves after the callback verifies `../api`, unrelated member layout, shared-layout rewrite, and the private source marker placement.
 * Does not handle: Creating real repositories, retaining the temporary root, or recovering callback/I/O/assertion failures.
 * Side effects: `withWorkspaceFixture` creates then recursively removes the temporary tree; its callback rejection propagates.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Reads the default fixture, rewrites it to shared layout, and checks sibling-safe descriptor and source-marker properties.
 * Inputs: The `WorkspaceFixture` created by `withWorkspaceFixture`; uses its API/control roots, manifest path, source path, and private marker.
 * Outputs: Resolves after canonical root comparison yields `../api`, unrelated deployments are one member each, the rewrite yields `[api, worker]`, and the marker occurs only in source text.
 * Does not handle: Fixture creation/deletion, scanning source, or suppressing `realpath`/read/parser/assertion failures.
 * Side effects: Reads fixture files, overwrites the manifest through `writeFixtureLayout`, and relies on the caller's `withWorkspaceFixture` finally cleanup.
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
 * Creates the default fixture and delegates concurrent broken/dynamic source scan assertions to its callback.
 * Inputs: No callback arguments; invokes `withWorkspaceFixture` with the fixture's deliberately invalid TypeScript and user-keyed environment access source files.
 * Outputs: Resolves after the callback proves broken coverage is incomplete and the dynamic scan reports one unbounded user-controlled lookup with no likely keys.
 * Does not handle: Repairing the deliberate syntax error, provisioning/reconciliation outside local scans, or masking callback failure.
 * Side effects: Fixture creation and recursive removal belong to `withWorkspaceFixture`; callback rejection propagates.
 */
  async () => {
  await withWorkspaceFixture(
    /**
 * Concurrently scans the fixture's broken and dynamic repository roots and inspects their isolated results.
 * Inputs: The supplied `WorkspaceFixture`, specifically `repositoryRoots.broken` and `repositoryRoots.dynamic`.
 * Outputs: Resolves after the broken result has incomplete coverage and the dynamic result exposes `unbounded`/`user-controlled`, an empty likely-key list, and incomplete demand/coverage records.
 * Does not handle: Fixture lifecycle, changing fixture source files, or recovery from scan/assertion rejection.
 * Side effects: Starts two local scans and reads their result graphs; temporary-root cleanup remains owned by `withWorkspaceFixture`.
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
