import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BINDING_MANIFEST_SCHEMA_VERSION,
  INVENTORY_SNAPSHOT_SCHEMA_VERSION,
} from "../../src/binding-adapters/contracts.js";
import { WORKSPACE_MANIFEST_SCHEMA_VERSION } from "../../src/workspace/contracts.js";

export type DeploymentLayout = "unrelated" | "shared";

export interface WorkspaceFixture {
  /** Private temporary root; acceptance assertions must never serialize it. */
  readonly root: string;
  readonly controlRoot: string;
  readonly manifestPath: string;
  readonly infraRoot: string;
  readonly repositoryRoots: {
    readonly api: string;
    readonly worker: string;
    readonly dynamic: string;
    readonly broken: string;
  };
  /** Synthetic source text that must not reach any report or viewer. */
  readonly privateSourceMarker: string;
}

export interface WorkspaceFixtureOptions {
  readonly layout?: DeploymentLayout;
}

interface FixtureDeployment {
  readonly id: string;
  readonly repositories: readonly string[];
  readonly inputs: {
    readonly bindings: string;
    readonly inventory: string;
    readonly memberScopes: readonly {
      readonly repositoryId: string;
      readonly scope: {
        readonly id: string;
        readonly componentId: string;
        readonly phase: "runtime";
        readonly stage: { readonly kind: "all" };
        readonly channel: "environment";
      };
    }[];
  };
}

const PRIVATE_SOURCE_MARKER = "fixture-private-value-do-not-report";

/**
 * Creates only synthetic, first-party fixture repositories. The manifest lives
 * in a control sibling, so `../api`/`../worker` descriptors exercise the N3
 * realpath boundary without embedding real local paths or credential-shaped
 * text in the test suite.
 */
export async function withWorkspaceFixture<T>(
  callback: (fixture: WorkspaceFixture) => Promise<T> | T,
  options: WorkspaceFixtureOptions = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "secret-reference-workspace-"));
  const fixture = createFixturePaths(root);
  try {
    await writeFixtureFiles(fixture, options.layout ?? "unrelated");
    return await callback(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Rewrites only the value-free workspace declaration and local JSON exports. */
export async function writeFixtureLayout(
  fixture: WorkspaceFixture,
  layout: DeploymentLayout,
): Promise<void> {
  const deployments = layout === "shared"
    ? [
        deployment("shared-production", ["api", "worker"]),
        deployment("dynamic-production", ["dynamic"]),
        deployment("broken-production", ["broken"]),
      ]
    : [
        deployment("api-production", ["api"]),
        deployment("worker-production", ["worker"]),
        deployment("dynamic-production", ["dynamic"]),
        deployment("broken-production", ["broken"]),
      ];

  await writeJsonc(fixture.manifestPath, {
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    repositories: [
      { id: "api", root: "../api" },
      { id: "worker", root: "../worker" },
      { id: "dynamic", root: "../dynamic" },
      { id: "broken", root: "../broken" },
    ],
    deployments,
  });

  await Promise.all(
    deployments.map(async (item) => {
      const directory = join(fixture.infraRoot, item.id);
      await writeJson(join(directory, "bindings.json"), {
        schemaVersion: BINDING_MANIFEST_SCHEMA_VERSION,
        inputId: item.id + "-bindings",
        adapterId: "fixture",
        candidates: [],
      });
      await writeJson(join(directory, "inventory.json"), {
        schemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
        inputId: item.id + "-inventory",
        authorityId: "fixture-authority",
        asOf: "2026-07-12T00:00:00Z",
        items: [],
      });
    }),
  );
}

function createFixturePaths(root: string): WorkspaceFixture {
  return {
    root,
    controlRoot: join(root, "control"),
    manifestPath: join(root, "control", "workspace.jsonc"),
    infraRoot: join(root, "infra"),
    repositoryRoots: {
      api: join(root, "api"),
      worker: join(root, "worker"),
      dynamic: join(root, "dynamic"),
      broken: join(root, "broken"),
    },
    privateSourceMarker: PRIVATE_SOURCE_MARKER,
  };
}

async function writeFixtureFiles(
  fixture: WorkspaceFixture,
  layout: DeploymentLayout,
): Promise<void> {
  await Promise.all([
    writeText(
      join(fixture.repositoryRoots.api, "src", "index.ts"),
      [
        'const privateFixtureValue = "' + fixture.privateSourceMarker + '";',
        "export const databaseUrl = process.env.DATABASE_URL;",
        "void privateFixtureValue;",
        "",
      ].join("\n"),
    ),
    writeText(
      join(fixture.repositoryRoots.worker, "src", "worker.ts"),
      "export const databaseUrl = process.env.DATABASE_URL;\n",
    ),
    writeText(
      join(fixture.repositoryRoots.dynamic, "src", "handler.ts"),
      [
        "export function handler(query: { key: string }) {",
        "  return process.env[query.key];",
        "}",
        "",
      ].join("\n"),
    ),
    // Deliberately syntactically invalid, but contains no secret-like value.
    writeText(
      join(fixture.repositoryRoots.broken, "src", "broken.ts"),
      "export const = ;\n",
    ),
  ]);
  await writeFixtureLayout(fixture, layout);
}

function deployment(id: string, repositories: readonly string[]): FixtureDeployment {
  return {
    id,
    repositories,
    inputs: {
      bindings: "../infra/" + id + "/bindings.json",
      inventory: "../infra/" + id + "/inventory.json",
      memberScopes: repositories.map((repositoryId) => ({
        repositoryId,
        scope: {
          id: repositoryId,
          componentId: repositoryId,
          phase: "runtime" as const,
          stage: { kind: "all" as const },
          channel: "environment" as const,
        },
      })),
    },
  };
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n");
}

async function writeJsonc(path: string, value: unknown): Promise<void> {
  await writeText(
    path,
    "// Synthetic local-only workspace fixture.\n" + JSON.stringify(value, null, 2) + "\n",
  );
}
