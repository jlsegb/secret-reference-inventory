import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type DocumentationDiagnostic = {
  readonly file: string;
  readonly line: number;
  readonly category: string;
  readonly code: string;
};

type DocumentationResult = {
  readonly filesChecked: number;
  readonly diagnostics: readonly DocumentationDiagnostic[];
  readonly fileInventory: "git-tracked" | "filesystem-fallback" | "unavailable";
};

type DocumentationChecker = {
  checkDocumentationContract(rootDirectory: string, requestedFiles?: readonly string[]): DocumentationResult;
  formatDiagnostics(result: DocumentationResult): string;
  listImplementationFiles(rootDirectory: string): readonly string[];
  documentationIssues(jsDoc: string): readonly string[];
  parseCheckerArguments(argumentsList: readonly string[]):
    | { readonly ok: true; readonly rootDirectory: string; readonly requestedFiles: readonly string[] }
    | { readonly ok: false; readonly message: string };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..");
const checkerPath = pathToFileURL(resolve(repositoryRoot, "scripts/docs-check.mjs")).href;
const checker = (await import(checkerPath)) as DocumentationChecker;
const fixtureRoot = resolve(testDirectory, "fixtures/docs-contract");

test(
  "documentation contract accepts every required runtime function category",
  /**
   * Verifies that every supported implementation category accepts a complete block.
   *
   * Inputs: The static valid fixture root.
   * Outputs: Assertion success when the fixture has no diagnostics.
   * Does not handle: Runtime behavior of the fixture code.
   * Side effects: Reads local fixture files through the checker.
   */
  () => {
  const result = checker.checkDocumentationContract(resolve(fixtureRoot, "valid"));

  assert.equal(result.filesChecked, 5);
  assert.equal(result.fileInventory, "filesystem-fallback");
  assert.deepEqual(result.diagnostics, []);
  },
);

test(
  "documentation contract reports missing fields without source contents and excludes declarations",
  /**
   * Verifies deterministic private diagnostics while retaining executable test coverage.
   *
   * Inputs: The static invalid fixture root.
   * Outputs: Assertion success for the expected nine diagnostics.
   * Does not handle: Semantic validation of fixture implementations.
   * Side effects: Reads local fixture files through the checker.
   */
  () => {
  const result = checker.checkDocumentationContract(resolve(fixtureRoot, "invalid"));
  const report = checker.formatDiagnostics(result);

  assert.deepEqual(
    result.diagnostics.map(
      /**
       * Projects a diagnostic into stable assertion fields.
       *
       * Inputs: One checker diagnostic.
       * Outputs: Its file, category, and code tuple.
       * Does not handle: Rendering the diagnostic for users.
       * Side effects: None.
       */
      (diagnostic) => [diagnostic.file, diagnostic.category, diagnostic.code],
    ),
    [
      ["src/invalid.ts", "function-declaration", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_OUTPUTS"],
      ["src/invalid.ts", "arrow-function", "MISSING_OR_INVALID_PURPOSE"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
      ["src/invalid.ts", "arrow-function", "MISSING_JSDOC"],
    ],
  );
  assert.equal(report.includes("intentionally-private-function-name"), false);
  assert.equal(report.includes("do-not-report-this-source-text"), false);
  assert.equal(report.includes("types.d.ts"), false);
  },
);

test(
  "documentation contract rejects observed hollow templates while accepting concrete contracts",
  /**
   * Verifies the explicit template denylist catches prior migration placeholders without judging unrelated prose.
   *
   * Inputs: Complete static JSDoc blocks containing one known placeholder or concrete equivalent language.
   * Outputs: Assertion success for each stable rejection code and no issue for the concrete block.
   * Does not handle: Semantic verification of documentation beyond the fixed structural and template rules.
   * Side effects: None.
   */
  () => {
    const concrete = [
      "/**",
      " * Records a normalized result for the current test assertion.",
      " *",
      " * Inputs: A normalized record selected by the assertion callback.",
      " * Outputs: A boolean indicating whether the record has the expected status.",
      " * Does not handle: Setup or cleanup outside this assertion callback.",
      " * Side effects: Reads the supplied record without mutation.",
      " */",
    ].join("\n");
    const templates = [
      {
        text: concrete.replace(
          "Does not handle: Setup or cleanup outside this assertion callback.",
          "Does not handle: Scenarios other than this test, including production workspace execution.",
        ),
        code: "REJECTED_TEMPLATE_SCENARIO_SCOPE",
        nearMiss: concrete.replace(
          "Does not handle: Setup or cleanup outside this assertion callback.",
          "Does not handle: Scenarios other than this test, including production workspace execution with a real deployment manifest.",
        ),
      },
      {
        text: concrete.replace(
          "Inputs: A normalized record selected by the assertion callback.",
          "Inputs: Parameters supplied by helper callers.",
        ),
        code: "REJECTED_TEMPLATE_HELPER_INPUT",
        nearMiss: concrete.replace(
          "Inputs: A normalized record selected by the assertion callback.",
          "Inputs: Parameters from helper callers that describe the request scope.",
        ),
      },
      {
        text: concrete.replace(
          "Outputs: A boolean indicating whether the record has the expected status.",
          "Outputs: The helper result defined by its body (boolean).",
        ),
        code: "REJECTED_TEMPLATE_HELPER_OUTPUT",
        nearMiss: concrete.replace(
          "Outputs: A boolean indicating whether the record has the expected status.",
          "Outputs: The helper result defined by its body after it validates the requested record.",
        ),
      },
      {
        text: concrete.replace(
          "Side effects: Reads the supplied record without mutation.",
          "Side effects: Mutates the captured test-local collection/cache named in its body.",
        ),
        code: "REJECTED_TEMPLATE_TEST_MUTATION",
        nearMiss: concrete.replace(
          "Side effects: Reads the supplied record without mutation.",
          "Side effects: Mutates the captured test-local cache named in its body after validation.",
        ),
      },
      {
        text: concrete.replace(
          "Records a normalized result for the current test assertion.",
          "Derives the callback result.",
        ),
        code: "REJECTED_TEMPLATE_CALLBACK_PURPOSE",
        nearMiss: concrete.replace(
          "Records a normalized result for the current test assertion.",
          "Derives the callback result count for the requested deployment status.",
        ),
      },
      {
        text: concrete.replace(
          "Outputs: A boolean indicating whether the record has the expected status.",
          "Outputs: The callback result or completion consumed by the enclosing test call.",
        ),
        code: "REJECTED_TEMPLATE_CALLBACK_OUTPUT",
        nearMiss: concrete.replace(
          "Outputs: A boolean indicating whether the record has the expected status.",
          "Outputs: The callback result consumed by the enclosing deployment mapper.",
        ),
      },
    ];

    assert.deepEqual(checker.documentationIssues(concrete), []);
    for (const template of templates) {
      assert.equal(checker.documentationIssues(template.text).includes(template.code), true);
      assert.deepEqual(checker.documentationIssues(template.nearMiss), []);
    }
  },
);

test(
  "documentation contract supports safe repeated file lanes without a scope escape hatch",
  /**
   * Verifies repeated logical --file selection is deterministic, inventory-bound, and does not expose invalid input.
   *
   * Inputs: The valid static fixture root, valid selected paths, and invalid command-line path forms.
   * Outputs: Assertion success for one selected file, fixed unavailable diagnostics, and rejected invalid arguments.
   * Does not handle: Source-wide migration completeness or file-system repairs for unavailable candidates.
   * Side effects: Reads local fixture files through the checker.
   */
  () => {
    const selected = checker.checkDocumentationContract(resolve(fixtureRoot, "valid"), ["src/functions.ts"]);
    const unavailable = checker.checkDocumentationContract(resolve(fixtureRoot, "valid"), ["src/missing.ts"]);
    const invalidSelection = checker.checkDocumentationContract(resolve(fixtureRoot, "valid"), ["src/../private-token.ts"]);
    const parsed = checker.parseCheckerArguments([
      "--root",
      resolve(fixtureRoot, "valid"),
      "--file",
      "scripts/tool.mjs",
      "--file",
      "src/functions.ts",
      "--file",
      "src/functions.ts",
    ]);
    const invalidScope = checker.parseCheckerArguments(["--scope", "src"]);
    const invalidPath = checker.parseCheckerArguments(["--file", "src/../private-token.ts"]);
    const unavailableReport = checker.formatDiagnostics(unavailable);
    const invalidSelectionReport = checker.formatDiagnostics(invalidSelection);

    assert.equal(selected.fileInventory, "filesystem-fallback");
    assert.equal(selected.filesChecked, 1);
    assert.deepEqual(selected.diagnostics, []);
    assert.deepEqual(unavailable.diagnostics, [
      {
        file: "<discovery>",
        line: 0,
        category: "discovery",
        code: "SOURCE_DISCOVERY_REQUESTED_FILE_UNAVAILABLE",
      },
    ]);
    assert.equal(unavailableReport.includes("src/missing.ts"), false);
    assert.deepEqual(invalidSelection.diagnostics, [
      {
        file: "<discovery>",
        line: 0,
        category: "discovery",
        code: "SOURCE_DISCOVERY_REQUESTED_FILE_INVALID",
      },
    ]);
    assert.equal(unavailableReport.includes("private-token"), false);
    assert.equal(invalidSelectionReport.includes("private-token"), false);
    assert.deepEqual(parsed, {
      ok: true,
      rootDirectory: resolve(fixtureRoot, "valid"),
      requestedFiles: ["scripts/tool.mjs", "src/functions.ts"],
    });
    assert.equal(invalidScope.ok, false);
    assert.equal(invalidPath.ok, false);
    if (!invalidPath.ok) {
      assert.equal(invalidPath.message.includes("private-token"), false);
    }
  },
);

test(
  "documentation contract canonicalizes in-root symlinks and reports unsafe links without source data",
  /**
   * Verifies in-root symlink traversal and fixed failures for outside-root and broken links.
   *
   * Inputs: Fresh local temporary directories and static TypeScript fixture content.
   * Outputs: Assertion success for fallback discovery, one scanned target, and fixed failure output.
   * Does not handle: Repairing broken links or accepting source outside the local scan root.
   * Side effects: Creates and removes local temporary files and symbolic links.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-symlink-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "docs-contract-symlink-outside-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "support"), { recursive: true });
      await writeFile(
        join(root, "support", "inside.ts"),
        'export function undocumentedInside(): string { return "inside-source-text-must-not-appear"; }\n',
        "utf8",
      );
      await symlink("../support/inside.ts", join(root, "src", "inside.ts"));
      await writeFile(
        join(outsideRoot, "outside.ts"),
        'export function outside(): string { return "outside-source-text-must-not-appear"; }\n',
        "utf8",
      );
      await symlink(join(outsideRoot, "outside.ts"), join(root, "src", "outside.ts"));
      await symlink("missing.ts", join(root, "src", "broken.ts"));

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      let foundDiscoveryFailure = false;
      let foundInRootFunction = false;
      for (const diagnostic of result.diagnostics) {
        if (
          diagnostic.file === "<discovery>" &&
          diagnostic.line === 0 &&
          diagnostic.category === "discovery" &&
          diagnostic.code === "SOURCE_DISCOVERY_SYMLINK_INVALID"
        ) {
          foundDiscoveryFailure = true;
        }
        if (diagnostic.file === "src/inside.ts" && diagnostic.code === "MISSING_JSDOC") {
          foundInRootFunction = true;
        }
      }
      assert.equal(result.fileInventory, "filesystem-fallback");
      assert.equal(result.filesChecked, 1);
      assert.equal(foundDiscoveryFailure, true);
      assert.equal(foundInRootFunction, true);
      assert.equal(report.includes("outside-source-text-must-not-appear"), false);
      assert.equal(report.includes("inside-source-text-must-not-appear"), false);
      assert.equal(report.includes(outsideRoot), false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract uses Git tracked inventory and ignores untracked eligible files",
  /**
   * Verifies exact repository roots select Git inventory rather than the filesystem fallback.
   *
   * Inputs: A fresh local Git repository with one indexed and one untracked source file.
   * Outputs: Assertion success when only the indexed implementation is considered.
   * Does not handle: Network Git remotes, commits, or worktree mutation outside the temporary repository.
   * Side effects: Creates and removes a local temporary Git repository and index entries.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-git-root-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src", "tracked.ts"),
        [
          "export const tracked = /**",
          " * Returns a tracked source value.",
          " *",
          " * Inputs: A string value.",
          " * Outputs: The supplied value.",
          " * Does not handle: Value normalization.",
          " * Side effects: None.",
          " */ (value: string): string => value;",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(root, "src", "untracked.ts"),
        'export function untracked(): string { return "untracked-source-text-must-not-appear"; }\n',
        "utf8",
      );
      await symlink("/untracked-outside-target", join(root, "src", "untracked-link.ts"));
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "src/tracked.ts"], { stdio: "ignore" });

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      const files = checker.listImplementationFiles(root);
      assert.equal(result.fileInventory, "git-tracked");
      assert.equal(result.filesChecked, 1);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(report.includes("untracked-source-text-must-not-appear"), false);
      assert.equal(files.some(
        /**
         * Detects an untracked file path in the checker discovery output.
         *
         * Inputs: One privacy-safe logical discovered source path.
         * Outputs: True when the path names the untracked temporary source file.
         * Does not handle: Content inspection or path serialization outside this assertion.
         * Side effects: None.
         */
        (file) => file === "src/untracked.ts",
      ), false);
      assert.equal(report.includes("untracked-outside-target"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract fails closed when an apparent Git root cannot provide tracked inventory",
  /**
   * Verifies unavailable Git inventory cannot make an untracked implementation influence diagnostics.
   *
   * Inputs: A fresh local directory with malformed Git metadata and one source file.
   * Outputs: Assertion success for zero scanned files and one fixed discovery diagnostic.
   * Does not handle: Repairing malformed Git metadata or recovering a file inventory.
   * Side effects: Creates and removes local temporary files.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-git-unavailable-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, ".git"), "malformed-git-metadata\n", "utf8");
      await writeFile(
        join(root, "src", "untracked.ts"),
        'export function untracked(): string { return "unavailable-source-text-must-not-appear"; }\n',
        "utf8",
      );

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      assert.equal(result.fileInventory, "unavailable");
      assert.equal(result.filesChecked, 0);
      assert.deepEqual(result.diagnostics, [
        {
          file: "<discovery>",
          line: 0,
          category: "discovery",
          code: "SOURCE_DISCOVERY_TRACKED_FILE_INVENTORY_UNAVAILABLE",
        },
      ]);
      assert.equal(report.includes("unavailable-source-text-must-not-appear"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract checks a tracked logical symlink whose safe target is outside source directories",
  /**
   * Verifies Git inventory preserves a tracked symlink's logical identity while reading its safe target.
   *
   * Inputs: A fresh local Git repository with a tracked source symlink and in-root support target.
   * Outputs: Assertion success for one logical diagnostic without target-path disclosure.
   * Does not handle: Symlink targets outside the root or untracked symlink candidates.
   * Side effects: Creates and removes a local temporary Git repository and symbolic link.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-logical-symlink-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "support"), { recursive: true });
      await writeFile(
        join(root, "support", "target.ts"),
        'export function undocumentedTarget(): string { return "target-source-text-must-not-appear"; }\n',
        "utf8",
      );
      await symlink("../support/target.ts", join(root, "src", "linked.ts"));
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "src/linked.ts"], { stdio: "ignore" });

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      assert.equal(result.fileInventory, "git-tracked");
      assert.equal(result.filesChecked, 1);
      assert.deepEqual(result.diagnostics, [
        {
          file: "src/linked.ts",
          line: 1,
          category: "function-declaration",
          code: "MISSING_JSDOC",
        },
      ]);
      assert.deepEqual(checker.listImplementationFiles(root), ["src/linked.ts"]);
      assert.equal(report.includes("support/target.ts"), false);
      assert.equal(report.includes("target-source-text-must-not-appear"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract reports a missing tracked logical candidate with a fixed failure",
  /**
   * Verifies tracked candidates are resolved after inventory and cannot silently disappear.
   *
   * Inputs: A fresh local Git repository with one indexed file removed after indexing.
   * Outputs: Assertion success for one fixed missing-candidate diagnostic and zero scanned files.
   * Does not handle: Restoring a deleted file or exposing its logical or canonical path.
   * Side effects: Creates, indexes, deletes, and removes local temporary files.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-missing-candidate-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const missingPath = join(root, "src", "missing.ts");
      await writeFile(
        missingPath,
        'export function missing(): string { return "missing-source-text-must-not-appear"; }\n',
        "utf8",
      );
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "src/missing.ts"], { stdio: "ignore" });
      await rm(missingPath);

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      assert.equal(result.fileInventory, "git-tracked");
      assert.equal(result.filesChecked, 0);
      assert.deepEqual(result.diagnostics, [
        {
          file: "<discovery>",
          line: 0,
          category: "discovery",
          code: "SOURCE_DISCOVERY_CANDIDATE_UNAVAILABLE",
        },
      ]);
      assert.equal(report.includes("missing-source-text-must-not-appear"), false);
      assert.equal(report.includes("src/missing.ts"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract redacts credential-shaped logical filenames and rejects invalid root kinds",
  /**
   * Verifies filename and requested-root values cannot flow into diagnostics.
   *
   * Inputs: A fresh local Git repository, credential-shaped filename, missing root, and file roots.
   * Outputs: Assertion success for opaque-file and fixed-root diagnostics without sentinel disclosure.
   * Does not handle: Recovering redacted names or treating files as scan roots.
   * Side effects: Creates and removes local temporary files, links, directories, and Git index entries.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-opaque-name-"));
    const invalidRoot = await mkdtemp(join(tmpdir(), "docs-contract-invalid-root-"));
    const regularFileRoot = join(root, "regular-file-root.ts");
    const symlinkFileRoot = join(root, "symlink-file-root");
    const sentinel = "sk_live_SENTINEL_DO_NOT_EMIT_123456789";
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src", `${sentinel}.ts`),
        'export function undocumented(): string { return "filename-source-text-must-not-appear"; }\n',
        "utf8",
      );
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "src"], { stdio: "ignore" });
      await rm(invalidRoot, { recursive: true, force: true });
      await writeFile(regularFileRoot, "export {};\n", "utf8");
      await symlink(regularFileRoot, symlinkFileRoot);

      const opaqueResult = checker.checkDocumentationContract(root);
      const opaqueReport = checker.formatDiagnostics(opaqueResult);
      const invalidResult = checker.checkDocumentationContract(invalidRoot);
      const invalidReport = checker.formatDiagnostics(invalidResult);
      const regularFileResult = checker.checkDocumentationContract(regularFileRoot);
      const regularFileReport = checker.formatDiagnostics(regularFileResult);
      const symlinkFileResult = checker.checkDocumentationContract(symlinkFileRoot);
      const symlinkFileReport = checker.formatDiagnostics(symlinkFileResult);
      assert.deepEqual(opaqueResult.diagnostics, [
        {
          file: "<opaque-file>",
          line: 1,
          category: "function-declaration",
          code: "MISSING_JSDOC",
        },
      ]);
      assert.deepEqual(checker.listImplementationFiles(root), ["<opaque-file>"]);
      assert.equal(JSON.stringify(opaqueResult).includes(sentinel), false);
      assert.equal(opaqueReport.includes(sentinel), false);
      assert.deepEqual(invalidResult.diagnostics, [
        {
          file: "<discovery>",
          line: 0,
          category: "discovery",
          code: "SOURCE_DISCOVERY_ROOT_UNAVAILABLE",
        },
      ]);
      assert.equal(invalidReport.includes(invalidRoot), false);
      assert.deepEqual(regularFileResult.diagnostics, invalidResult.diagnostics);
      assert.deepEqual(symlinkFileResult.diagnostics, invalidResult.diagnostics);
      assert.equal(regularFileReport.includes(regularFileRoot), false);
      assert.equal(symlinkFileReport.includes(symlinkFileRoot), false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(invalidRoot, { recursive: true, force: true });
    }
  },
);

test(
  "documentation contract fails closed on noncanonical Git logical paths before decoy resolution",
  /**
   * Verifies Git's slash-delimited logical identifiers reject literal backslashes without path rewriting.
   *
   * Inputs: A local Git repository with one tracked backslash filename and an untracked slash-path decoy.
   * Outputs: Assertion success for one fixed Git discovery failure and zero checked candidates.
   * Does not handle: Normalizing noncanonical Git paths or inspecting an untracked decoy.
   * Side effects: Creates and removes a local temporary Git repository and files.
   */
  async () => {
    const root = await mkdtemp(join(tmpdir(), "docs-contract-git-logical-path-"));
    try {
      await mkdir(join(root, "src", "backslash"), { recursive: true });
      const trackedBackslashPath = join(root, "src", "backslash\\entry.ts");
      await writeFile(
        trackedBackslashPath,
        'export function tracked(): string { return "tracked-backslash-source-must-not-appear"; }\n',
        "utf8",
      );
      await writeFile(
        join(root, "src", "backslash", "entry.ts"),
        'export function decoy(): string { return "untracked-decoy-source-must-not-appear"; }\n',
        "utf8",
      );
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "--", "src/backslash\\entry.ts"], { stdio: "ignore" });

      const result = checker.checkDocumentationContract(root);
      const report = checker.formatDiagnostics(result);
      assert.equal(result.fileInventory, "unavailable");
      assert.equal(result.filesChecked, 0);
      assert.deepEqual(result.diagnostics, [
        {
          file: "<discovery>",
          line: 0,
          category: "discovery",
          code: "SOURCE_DISCOVERY_TRACKED_LOGICAL_PATH_INVALID",
        },
      ]);
      assert.equal(report.includes("tracked-backslash-source-must-not-appear"), false);
      assert.equal(report.includes("untracked-decoy-source-must-not-appear"), false);
      assert.equal(report.includes("backslash\\entry.ts"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "documentation file discovery is stable and includes configured implementation directories",
  /**
   * Verifies deterministic discovery across source and executable test directories.
   *
   * Inputs: The static invalid fixture root and repository root.
   * Outputs: Assertion success for in-scope files and excluded checker data.
   * Does not handle: Documentation contents in the discovered files.
   * Side effects: Reads local fixture and repository directory metadata.
   */
  () => {
  const files = checker.listImplementationFiles(resolve(fixtureRoot, "invalid"));

  assert.deepEqual(
    files.map(
      /**
       * Projects an absolute fixture path into its stable fixture-relative suffix.
       *
       * Inputs: One absolute discovered fixture path.
       * Outputs: Its privacy-safe logical path.
       * Does not handle: Canonical filesystem path inspection or path normalization beyond checker output.
       * Side effects: None.
       */
      (file) => file,
    ),
    ["src/invalid.ts", "test/ignored.ts"],
  );
  const repositoryFiles = checker.listImplementationFiles(repositoryRoot);
  assert.equal(
    repositoryFiles.some(
      /**
       * Detects a documentation-checker fixture path in repository discovery output.
       *
       * Inputs: One absolute discovered file path.
       * Outputs: True when the path belongs to the checker's static fixtures.
       * Does not handle: Other fixture categories, which remain in scope by policy.
       * Side effects: None.
       */
      (file) => file.startsWith("test/fixtures/docs-contract/"),
    ),
    false,
  );
  },
);
