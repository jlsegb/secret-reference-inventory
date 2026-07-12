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

test("multi-repository fixture uses safe sibling roots and explicit deployment layouts", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const apiRoot = await realpath(fixture.repositoryRoots.api);
    const controlRoot = await realpath(fixture.controlRoot);
    const sibling = relative(controlRoot, apiRoot).split(sep).join("/");
    assert.equal(sibling, "../api");

    const unrelatedText = await readFile(fixture.manifestPath, "utf8");
    const unrelated = parseWorkspaceManifestText(unrelatedText);
    assert.equal(unrelated.ok, true);
    if (unrelated.ok) {
      assert.deepEqual(
        unrelated.value.deployments.map((deployment) => deployment.repositories),
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

test("fixture isolates parser failure and user-controlled lookup behavior", async () => {
  await withWorkspaceFixture(async (fixture) => {
    const [broken, dynamic] = await Promise.all([
      scanLocalRoot(fixture.repositoryRoots.broken),
      scanLocalRoot(fixture.repositoryRoots.dynamic),
    ]);

    assert.equal(
      broken.result.scopeCoverage.some((coverage) => coverage.state === "incomplete"),
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
