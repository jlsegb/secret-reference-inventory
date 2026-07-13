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
 * Creates a synthetic workspace tree, runs one assertion callback, and removes the temporary root afterwards.
 *
 * Inputs: A callback receiving fixture-local paths/marker and an optional unrelated/shared deployment layout.
 * Outputs: The callback's fulfilled value or rejection after fixture setup; cleanup is attempted in finally in either case, and a cleanup rm() failure can replace a prior fulfillment or rejection.
 * Does not handle: Real repositories, external services, preserving fixtures for debugging, or suppression/prioritization of callback, setup, and cleanup errors.
 * Side effects: Creates and writes a temporary sibling-root workspace, then recursively removes its root.
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

/**
 * Rewrites the fixture manifest and empty local binding/inventory documents for the requested deployment topology.
 *
 * Inputs: An existing synthetic fixture and unrelated/shared layout selector.
 * Outputs: A promise resolving after the JSONC manifest and every deployment document are written.
 * Does not handle: Source fixture generation, real provider data, malformed layouts, or atomic multi-file transactions.
 * Side effects: Overwrites test-owned manifest/provisioning files and creates their parent directories.
 */
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
    deployments.map(
      /**
       * Writes empty schema-valid binding and inventory fixtures for one declared synthetic deployment.
       *
       * Inputs: One fixture deployment declaration.
       * Outputs: A promise resolving after its two provisioning JSON files are written.
       * Does not handle: Candidate/item generation, layout selection, or provider delivery behavior.
       * Side effects: Creates/writes test-owned files below the fixture infrastructure root.
       */
      async (item) => {
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
      }
    ),
  );
}

/**
 * Derives every private fixture path from one freshly created temporary root.
 *
 * Inputs: A test-owned temporary root path.
 * Outputs: A fixture record with sibling control, infrastructure, and repository paths plus its private source marker.
 * Does not handle: Creating directories, validating paths, or exposing these paths in reports.
 * Side effects: Allocates joined path strings and the fixture object.
 */
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

/**
 * Writes synthetic source files that exercise direct reads, dynamic lookups, and a parser-failure repository before provisioning layout setup.
 *
 * Inputs: A fixture path record and deployment layout selector.
 * Outputs: A promise resolving after all source files and provisioning layout exist.
 * Does not handle: Compiling fixtures, real secret values, external source roots, or repairing deliberate syntax failure.
 * Side effects: Concurrently writes test-owned source files, including a private marker and invalid TypeScript fixture.
 */
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

/**
 * Builds one synthetic deployment declaration with empty JSON input descriptors and an all-stage runtime scope per member.
 *
 * Inputs: A fixture deployment ID and its repository IDs.
 * Outputs: A value-free fixture deployment record.
 * Does not handle: Closed-model descriptors, non-runtime channels, scope overlap tests, or filesystem writes.
 * Side effects: Allocates nested descriptor/member-scope records and arrays.
 */
function deployment(id: string, repositories: readonly string[]): FixtureDeployment {
  return {
    id,
    repositories,
    inputs: {
      bindings: "../infra/" + id + "/bindings.json",
      inventory: "../infra/" + id + "/inventory.json",
      memberScopes: repositories.map(
        /**
         * Creates the exact all-stage runtime/environment scope belonging to one fixture repository.
         *
         * Inputs: One fixture repository ID.
         * Outputs: Its repositoryId/scope declaration.
         * Does not handle: Scope validation, overlap testing, or file creation.
         * Side effects: Allocates a member-scope object.
         */
        (repositoryId) => ({
        repositoryId,
        scope: {
          id: repositoryId,
          componentId: repositoryId,
          phase: "runtime" as const,
          stage: { kind: "all" as const },
          channel: "environment" as const,
        },
        })
      ),
    },
  };
}

/**
 * Ensures a fixture file's parent exists and writes UTF-8 source or JSON text.
 *
 * Inputs: A caller-supplied absolute fixture path expected by tests to be fixture-owned, plus complete text content.
 * Outputs: A promise resolving after the text is written.
 * Does not handle: Atomic replacement, permissions recovery, encoding selection, or validating that the caller-supplied path remains inside a fixture.
 * Side effects: Creates parent directories and overwrites the caller-selected target file.
 */
async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/**
 * Serializes one fixture object as indented newline-terminated JSON and writes it through the fixture text helper.
 *
 * Inputs: A test-owned target path and JSON-serializable fixture value.
 * Outputs: A promise resolving after serialization and write complete.
 * Does not handle: Cycles, custom replacers, JSON validation, or secret redaction.
 * Side effects: Allocates JSON text and writes/overwrites the target fixture file.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Serializes one fixture object as JSONC with the fixed local-only comment prefix.
 *
 * Inputs: A test-owned target path and JSON-serializable fixture value.
 * Outputs: A promise resolving after the JSONC text is written.
 * Does not handle: Arbitrary comments, cycles, manifest validation, or formatting preservation.
 * Side effects: Allocates JSONC text and overwrites the target fixture file through writeText.
 */
async function writeJsonc(path: string, value: unknown): Promise<void> {
  await writeText(
    path,
    "// Synthetic local-only workspace fixture.\n" + JSON.stringify(value, null, 2) + "\n",
  );
}
