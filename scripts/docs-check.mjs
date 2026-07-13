import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const REQUIRED_SECTIONS = ["Inputs", "Outputs", "Does not handle", "Side effects"];
const IMPLEMENTATION_DIRECTORIES = ["scripts", "src", "test"];
const DISCOVERY_DIAGNOSTIC_FILE = "<discovery>";
const SYMLINK_DISCOVERY_FAILURE = "SOURCE_DISCOVERY_SYMLINK_INVALID";
const TRACKED_INVENTORY_FAILURE = "SOURCE_DISCOVERY_TRACKED_FILE_INVENTORY_UNAVAILABLE";
const ROOT_DISCOVERY_FAILURE = "SOURCE_DISCOVERY_ROOT_UNAVAILABLE";
const CANDIDATE_DISCOVERY_FAILURE = "SOURCE_DISCOVERY_CANDIDATE_UNAVAILABLE";
const READ_DISCOVERY_FAILURE = "SOURCE_DISCOVERY_READ_UNAVAILABLE";
const GIT_LOGICAL_PATH_FAILURE = "SOURCE_DISCOVERY_TRACKED_LOGICAL_PATH_INVALID";
const REQUESTED_FILE_INVALID_FAILURE = "SOURCE_DISCOVERY_REQUESTED_FILE_INVALID";
const REQUESTED_FILE_UNAVAILABLE_FAILURE = "SOURCE_DISCOVERY_REQUESTED_FILE_UNAVAILABLE";
const OPAQUE_DIAGNOSTIC_FILE = "<opaque-file>";
const CLI_USAGE =
  "usage: node scripts/docs-check.mjs [--root <repository-root>] [--file <logical-implementation-file>]...";
const REJECTED_TEMPLATE_RULES = [
  {
    code: "REJECTED_TEMPLATE_SCENARIO_SCOPE",
    field: "Does not handle",
    values: new Set(["scenarios other than this test, including production workspace execution."]),
  },
  {
    code: "REJECTED_TEMPLATE_HELPER_INPUT",
    field: "Inputs",
    values: new Set(["parameters supplied by helper callers."]),
  },
  {
    code: "REJECTED_TEMPLATE_HELPER_OUTPUT",
    field: "Outputs",
    values: new Set(["the helper result defined by its body (boolean)."]),
  },
  {
    code: "REJECTED_TEMPLATE_TEST_MUTATION",
    field: "Side effects",
    values: new Set(["mutates the captured test-local collection/cache named in its body."]),
  },
  {
    code: "REJECTED_TEMPLATE_CALLBACK_PURPOSE",
    field: "purpose",
    values: new Set(["derives the callback result.", "derives callback result."]),
  },
  {
    code: "REJECTED_TEMPLATE_CALLBACK_OUTPUT",
    field: "Outputs",
    values: new Set(["the callback result or completion consumed by the enclosing test call."]),
  },
];

/**
 * Determines whether a tracked logical path is an implementation file in the documented scope.
 *
 * Inputs: A slash-separated repository-relative logical path.
 * Outputs: True for non-declaration TypeScript files and maintenance MJS files.
 * Does not handle: Other runtime languages or generated build output.
 * Side effects: None.
 */
export function isImplementationFile(logicalPath) {
  return (
    (logicalPath.endsWith(".ts") && !logicalPath.endsWith(".d.ts")) ||
    logicalPath.endsWith(".mjs")
  );
}

/**
 * Determines whether a logical path belongs to the dedicated documentation-checker fixtures.
 *
 * Inputs: A slash-separated repository-relative logical path.
 * Outputs: True only for this checker's static test data.
 * Does not handle: Other test fixtures, which remain in scope when they are executable code.
 * Side effects: None.
 */
export function isDocumentationCheckerFixture(logicalPath) {
  return logicalPath.startsWith("test/fixtures/docs-contract/");
}

/**
 * Determines whether a caller-supplied lane file is a canonical eligible logical implementation path.
 *
 * Inputs: A candidate logical path supplied through the programmatic or command-line lane selector.
 * Outputs: True only when the path is canonical, in the documented implementation scope, and not a checker fixture.
 * Does not handle: Verifying that the path is tracked or safely resolvable; discovery performs those checks.
 * Side effects: None.
 */
export function isRequestedImplementationFile(logicalPath) {
  return (
    normalizeLogicalPath(logicalPath) === logicalPath &&
    isImplementationFile(logicalPath) &&
    !isDocumentationCheckerFixture(logicalPath)
  );
}

/**
 * Validates and deterministically deduplicates requested lane file paths without retaining invalid input.
 *
 * Inputs: An array of logical implementation paths requested by a caller.
 * Outputs: A success object with sorted canonical paths, or a fixed invalid result with no supplied path.
 * Does not handle: Root resolution, Git inventory lookup, or file-system containment checks.
 * Side effects: None.
 */
export function normalizeRequestedImplementationFiles(requestedFiles) {
  if (!Array.isArray(requestedFiles)) {
    return { ok: false, paths: [] };
  }
  const paths = new Set();
  for (const requestedFile of requestedFiles) {
    if (!isRequestedImplementationFile(requestedFile)) {
      return { ok: false, paths: [] };
    }
    paths.add(requestedFile);
  }
  return { ok: true, paths: Array.from(paths).sort(compareStrings) };
}

/**
 * Determines whether a path segment is excluded from the documentation-contract scan.
 *
 * Inputs: A directory entry name.
 * Outputs: True when the entry is generated output or dependency content.
 * Does not handle: Generated source that is still tracked under a documented source directory.
 * Side effects: None.
 */
export function isExcludedDirectory(entryName) {
  return entryName === "dist" || entryName === "node_modules";
}

/**
 * Normalizes a Git or fallback logical path without accepting path traversal or absolute paths.
 *
 * Inputs: A candidate path string supplied by Git or local directory discovery.
 * Outputs: A canonical slash-separated logical path, or undefined when the input is unsafe.
 * Does not handle: Case normalization, Unicode normalization, or extension filtering.
 * Side effects: None.
 */
export function normalizeLogicalPath(candidatePath) {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    return undefined;
  }
  if (candidatePath.includes("\\")) {
    return undefined;
  }
  if (candidatePath.startsWith("/")) {
    return undefined;
  }
  const segments = candidatePath.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      /**
       * Detects a path segment that makes a logical identifier noncanonical.
       *
       * Inputs: One slash-delimited logical path segment.
       * Outputs: True when the segment is empty, current-directory, or parent-directory notation.
       * Does not handle: Filename safety or implementation-extension filtering.
       * Side effects: None.
       */
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  for (const directoryName of IMPLEMENTATION_DIRECTORIES) {
    if (segments[0] === directoryName) {
      return candidatePath;
    }
  }
  return undefined;
}

/**
 * Resolves one logical candidate to a canonical in-root file while retaining its logical identity.
 *
 * Inputs: A canonical scan root, a validated logical path, and mutable fixed-failure collection.
 * Outputs: A logical/canonical file candidate, or undefined when it cannot be safely read.
 * Does not handle: Recovering missing, non-file, outside-root, or broken symlink candidates.
 * Side effects: Reads filesystem metadata and records only fixed discovery failures.
 */
export function resolveLogicalCandidate(canonicalRoot, logicalPath, failures) {
  const absoluteLogicalPath = resolve(canonicalRoot, logicalPath);
  if (!isWithinRoot(canonicalRoot, absoluteLogicalPath)) {
    failures.add(CANDIDATE_DISCOVERY_FAILURE);
    return undefined;
  }
  try {
    lstatSync(absoluteLogicalPath);
  } catch {
    failures.add(CANDIDATE_DISCOVERY_FAILURE);
    return undefined;
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync.native(absoluteLogicalPath);
  } catch {
    failures.add(CANDIDATE_DISCOVERY_FAILURE);
    return undefined;
  }
  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    failures.add(SYMLINK_DISCOVERY_FAILURE);
    return undefined;
  }
  try {
    const targetStatus = statSync(canonicalPath);
    if (targetStatus.isFile()) {
      return { logicalPath, canonicalPath };
    }
  } catch {
    failures.add(CANDIDATE_DISCOVERY_FAILURE);
  }
  failures.add(CANDIDATE_DISCOVERY_FAILURE);
  return undefined;
}

/**
 * Determines whether a canonical candidate path is contained by the canonical scan root.
 *
 * Inputs: A canonical scan root and a canonical candidate path.
 * Outputs: True when the candidate is the root or one of its descendants.
 * Does not handle: Case-insensitive filesystem normalization beyond Node path semantics.
 * Side effects: None.
 */
export function isWithinRoot(canonicalRoot, candidatePath) {
  const candidateRelativePath = relative(canonicalRoot, candidatePath);
  return (
    candidateRelativePath === "" ||
    (!candidateRelativePath.startsWith(`..${sep}`) &&
      candidateRelativePath !== ".." &&
      !isAbsolute(candidateRelativePath))
  );
}

/**
 * Canonicalizes a requested scan root without exposing invalid input paths in failures.
 *
 * Inputs: A caller-supplied root value and a mutable fixed-failure collection.
 * Outputs: A canonical root path, or undefined when the root cannot be resolved safely.
 * Does not handle: Creating missing roots, repairing permissions, or reporting supplied paths.
 * Side effects: Reads local filesystem metadata and may record a fixed discovery failure.
 */
export function canonicalizeScanRoot(rootDirectory, failures) {
  try {
    const canonicalRoot = realpathSync.native(resolve(rootDirectory));
    if (!statSync(canonicalRoot).isDirectory()) {
      failures.add(ROOT_DISCOVERY_FAILURE);
      return undefined;
    }
    return canonicalRoot;
  } catch {
    failures.add(ROOT_DISCOVERY_FAILURE);
    return undefined;
  }
}

/**
 * Redacts logical paths whose shape could contain a credential-like or unsafe filename.
 *
 * Inputs: A repository-relative logical path.
 * Outputs: The same safe logical path or one opaque fixed file token.
 * Does not handle: Recovering a redacted filename or inspecting filesystem target paths.
 * Side effects: None.
 */
export function safeDiagnosticPath(logicalPath) {
  if (!isSafeDiagnosticPath(logicalPath)) {
    return OPAQUE_DIAGNOSTIC_FILE;
  }
  return logicalPath;
}

/**
 * Determines whether a logical path is safe to display in a diagnostic.
 *
 * Inputs: A repository-relative logical path.
 * Outputs: True for conventional in-scope implementation paths without credential-like segments.
 * Does not handle: Semantic validation of filenames or any source-content inspection.
 * Side effects: None.
 */
export function isSafeDiagnosticPath(logicalPath) {
  if (!/^(?:src|scripts|test)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\.(?:ts|mjs)$/u.test(logicalPath)) {
    return false;
  }
  return !/(?:sk[_-]?live|sk[_-]?test|pk[_-]?live|ghp_|github[_-]?pat|akia|xox[baprs]-|secret|token|password|credential|bearer|api[_-]?key)/iu.test(logicalPath);
}

/**
 * Walks a non-Git root and appends safe logical/canonical implementation candidates.
 *
 * Inputs: A logical directory, canonical root, mutable candidate/failure collections, and visited directories.
 * Outputs: The same candidate collection populated with eligible implementation files.
 * Does not handle: Git tracked-file authority, which uses a separate logical inventory path.
 * Side effects: Reads directory metadata and mutates the supplied collections.
 */
export function collectFilesFromDirectory(logicalDirectory, canonicalRoot, result, failures, visitedDirectories) {
  const absoluteLogicalDirectory = resolve(canonicalRoot, logicalDirectory);
  let canonicalDirectory;
  try {
    lstatSync(absoluteLogicalDirectory);
    canonicalDirectory = realpathSync.native(absoluteLogicalDirectory);
  } catch {
    return result;
  }
  if (!isWithinRoot(canonicalRoot, canonicalDirectory)) {
    failures.add(SYMLINK_DISCOVERY_FAILURE);
    return result;
  }
  if (visitedDirectories.has(canonicalDirectory)) {
    return result;
  }
  visitedDirectories.add(canonicalDirectory);

  let entries;
  try {
    entries = readdirSync(canonicalDirectory, { withFileTypes: true });
  } catch {
    failures.add(READ_DISCOVERY_FAILURE);
    return result;
  }
  entries.sort(compareDirectoryEntries);
  for (const entry of entries) {
    if (isExcludedDirectory(entry.name)) {
      continue;
    }
    const childLogicalPath = `${logicalDirectory}/${entry.name}`;
    const childAbsolutePath = resolve(canonicalRoot, childLogicalPath);
    let childStatus;
    let childCanonicalPath;
    try {
      childStatus = lstatSync(childAbsolutePath);
      childCanonicalPath = realpathSync.native(childAbsolutePath);
    } catch {
      failures.add(CANDIDATE_DISCOVERY_FAILURE);
      continue;
    }
    if (!isWithinRoot(canonicalRoot, childCanonicalPath)) {
      failures.add(SYMLINK_DISCOVERY_FAILURE);
      continue;
    }
    let childIsDirectory;
    try {
      childIsDirectory = childStatus.isDirectory() || statSync(childCanonicalPath).isDirectory();
    } catch {
      failures.add(CANDIDATE_DISCOVERY_FAILURE);
      continue;
    }
    if (childIsDirectory) {
      collectFilesFromDirectory(
        childLogicalPath,
        canonicalRoot,
        result,
        failures,
        visitedDirectories,
      );
      continue;
    }
    if (isImplementationFile(childLogicalPath)) {
      const candidate = resolveLogicalCandidate(canonicalRoot, childLogicalPath, failures);
      if (candidate !== undefined) {
        result.push(candidate);
      }
    }
  }
  return result;
}

/**
 * Orders logical/canonical candidates by their logical path without exposing canonical paths.
 *
 * Inputs: Two resolved source candidates.
 * Outputs: A deterministic comparison result.
 * Does not handle: Filesystem path ordering or locale-aware collation.
 * Side effects: None.
 */
export function compareCandidates(left, right) {
  return compareStrings(left.logicalPath, right.logicalPath);
}

/**
 * Orders directory entries by name for reproducible scanner output.
 *
 * Inputs: Two filesystem directory entries.
 * Outputs: A standard lexical comparison result.
 * Does not handle: Locale-aware ordering or case-folding policy.
 * Side effects: None.
 */
export function compareDirectoryEntries(left, right) {
  return compareStrings(left.name, right.name);
}

/**
 * Discovers implementation candidates and source-inventory state for a local repository root.
 *
 * Inputs: A repository root directory and optional canonical requested logical file paths.
 * Outputs: Eligible logical/canonical candidates, fixed discovery failures, and the inventory mode used.
 * Does not handle: Repairing source links, Git metadata, or documentation gaps.
 * Side effects: Reads filesystem metadata and invokes local Git only for exact repository roots.
 */
export function discoverImplementationFiles(rootDirectory, requestedFiles = []) {
  const failures = new Set();
  const requestedSelection = normalizeRequestedImplementationFiles(requestedFiles);
  if (!requestedSelection.ok) {
    failures.add(REQUESTED_FILE_INVALID_FAILURE);
    return {
      candidates: [],
      failures: Array.from(failures).sort(compareStrings),
      fileInventory: "unavailable",
    };
  }
  const canonicalRoot = canonicalizeScanRoot(rootDirectory, failures);
  if (canonicalRoot === undefined) {
    return {
      candidates: [],
      failures: Array.from(failures).sort(compareStrings),
      fileInventory: "unavailable",
    };
  }
  const inventory = trackedFileInventory(canonicalRoot);
  if (inventory.mode === "unavailable") {
    failures.add(inventory.failure ?? TRACKED_INVENTORY_FAILURE);
    return {
      candidates: [],
      failures: Array.from(failures).sort(compareStrings),
      fileInventory: inventory.mode,
      canonicalRoot,
    };
  }
  const discovered = [];
  const visitedDirectories = new Set();
  if (inventory.mode === "git-tracked") {
    for (const logicalPath of inventory.paths) {
      if (!isImplementationFile(logicalPath) || isDocumentationCheckerFixture(logicalPath)) {
        continue;
      }
      const candidate = resolveLogicalCandidate(canonicalRoot, logicalPath, failures);
      if (candidate !== undefined) {
        discovered.push(candidate);
      }
    }
  } else {
    for (const directoryName of IMPLEMENTATION_DIRECTORIES) {
      collectFilesFromDirectory(directoryName, canonicalRoot, discovered, failures, visitedDirectories);
    }
  }
  const result = [];
  const seenLogicalPaths = new Set();
  for (const candidate of discovered) {
    if (!seenLogicalPaths.has(candidate.logicalPath)) {
      result.push(candidate);
      seenLogicalPaths.add(candidate.logicalPath);
    }
  }
  result.sort(compareCandidates);
  const selected = selectRequestedCandidates(result, requestedSelection.paths, failures);
  return {
    candidates: selected,
    failures: Array.from(failures).sort(compareStrings),
    fileInventory: inventory.mode,
    canonicalRoot,
  };
}

/**
 * Restricts discovered candidates to an explicit lane while failing closed for absent requested files.
 *
 * Inputs: Sorted resolved candidates, sorted canonical requested paths, and a mutable fixed-failure collection.
 * Outputs: All candidates for an empty selection, otherwise only candidates named by every requested path.
 * Does not handle: Recovering an untracked, missing, unreadable, or unsafe requested target.
 * Side effects: May add one fixed unavailable-request failure without retaining requested path text.
 */
export function selectRequestedCandidates(candidates, requestedPaths, failures) {
  if (requestedPaths.length === 0) {
    return candidates;
  }
  const candidatesByLogicalPath = new Map();
  for (const candidate of candidates) {
    candidatesByLogicalPath.set(candidate.logicalPath, candidate);
  }
  const selected = [];
  for (const requestedPath of requestedPaths) {
    const candidate = candidatesByLogicalPath.get(requestedPath);
    if (candidate === undefined) {
      failures.add(REQUESTED_FILE_UNAVAILABLE_FAILURE);
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

/**
 * Lists every implementation file covered by the documentation contract.
 *
 * Inputs: A repository root directory.
 * Outputs: Sorted privacy-safe logical paths from the root's src, scripts, and test directories.
 * Does not handle: Discovery failures, which are available from the full discovery result.
 * Side effects: Reads filesystem metadata and may invoke local Git for a repository root.
 */
export function listImplementationFiles(rootDirectory) {
  const discovery = discoverImplementationFiles(rootDirectory);
  const result = [];
  for (const candidate of discovery.candidates) {
    result.push(safeDiagnosticPath(candidate.logicalPath));
  }
  return result;
}

/**
 * Selects a tracked-file inventory for an exact Git repository root or a filesystem fallback.
 *
 * Inputs: A canonical scan root.
 * Outputs: Git-tracked paths, a deterministic filesystem-fallback mode, or an unavailable mode.
 * Does not handle: Repairing unavailable Git metadata or indexing a parent repository from a subdirectory.
 * Side effects: Invokes the local Git executable without network access.
 */
export function trackedFileInventory(canonicalRoot) {
  let gitTopLevel;
  try {
    gitTopLevel = realpathSync.native(
      execFileSync("git", ["-C", canonicalRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return existsSync(resolve(canonicalRoot, ".git"))
      ? { mode: "unavailable", paths: new Set() }
      : { mode: "filesystem-fallback", paths: new Set() };
  }
  if (gitTopLevel !== canonicalRoot) {
    return { mode: "filesystem-fallback", paths: new Set() };
  }
  try {
    const output = execFileSync(
      "git",
      ["-C", canonicalRoot, "ls-files", "-z", "--", "src", "scripts", "test"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const paths = new Set();
    for (const entry of output.split("\u0000")) {
      if (entry.length === 0) {
        continue;
      }
      const logicalPath = normalizeLogicalPath(entry);
      if (logicalPath === undefined) {
        return { mode: "unavailable", paths: new Set(), failure: GIT_LOGICAL_PATH_FAILURE };
      }
      paths.add(logicalPath);
    }
    return { mode: "git-tracked", paths };
  } catch {
    return { mode: "unavailable", paths: new Set() };
  }
}

/**
 * Orders absolute paths deterministically without exposing file contents.
 *
 * Inputs: Two absolute path strings.
 * Outputs: A standard lexical comparison result.
 * Does not handle: Locale-specific collation policies.
 * Side effects: None.
 */
export function comparePaths(left, right) {
  return compareStrings(left, right);
}

/**
 * Compares two strings by JavaScript code-unit order for host-independent diagnostics.
 *
 * Inputs: Two string values.
 * Outputs: Negative, zero, or positive ordering result.
 * Does not handle: Locale-aware or human-language collation.
 * Side effects: None.
 */
export function compareStrings(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Classifies a TypeScript AST node when it represents a runtime function implementation.
 *
 * Inputs: A TypeScript AST node.
 * Outputs: A privacy-safe function category or undefined for non-implementations.
 * Does not handle: Signature-only declarations, abstract members, and non-TypeScript syntax.
 * Side effects: None.
 */
export function functionCategory(node) {
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return "function-declaration";
  }
  if (ts.isMethodDeclaration(node) && node.body !== undefined) {
    return ts.isObjectLiteralExpression(node.parent) ? "object-method" : "method";
  }
  if (ts.isConstructorDeclaration(node) && node.body !== undefined) {
    return "constructor";
  }
  if (ts.isGetAccessorDeclaration(node) && node.body !== undefined) {
    return "get-accessor";
  }
  if (ts.isSetAccessorDeclaration(node) && node.body !== undefined) {
    return "set-accessor";
  }
  if (ts.isFunctionExpression(node)) {
    return "function-expression";
  }
  if (ts.isArrowFunction(node)) {
    return "arrow-function";
  }
  return undefined;
}

/**
 * Extracts an immediately adjacent JSDoc block from a declaration's leading trivia.
 *
 * Inputs: A declaration node and its source file.
 * Outputs: The raw JSDoc block text, or undefined when no adjacent block exists.
 * Does not handle: Detached comments, line comments, or comments separated by another declaration.
 * Side effects: None.
 */
export function immediateJSDoc(node, sourceFile) {
  const leadingTrivia = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile));
  const match = /\/\*\*[\s\S]*?\*\/[\t ]*(?:\r?\n)?[\t ]*$/u.exec(leadingTrivia);
  return match?.[0];
}

/**
 * Selects the direct JSDoc block that belongs to one function implementation node.
 *
 * Inputs: A function implementation node and its source file.
 * Outputs: The directly associated JSDoc text, or undefined when the node has no attachment.
 * Does not handle: Documentation inherited from variable, property, or export containers.
 * Side effects: None.
 */
export function associatedJSDoc(node, sourceFile) {
  return immediateJSDoc(node, sourceFile);
}

/**
 * Normalizes JSDoc text into semantic content lines without retaining source coordinates.
 *
 * Inputs: One raw JSDoc block.
 * Outputs: Trimmed content lines with comment delimiters removed.
 * Does not handle: Markdown rendering or TypeDoc tag interpretation.
 * Side effects: None.
 */
export function jsDocContentLines(jsDoc) {
  const withoutDelimiters = jsDoc.replace(/^\/\*\*/u, "").replace(/\*\/\s*$/u, "");
  const rawLines = withoutDelimiters.split(/\r?\n/u);
  const result = [];
  for (const rawLine of rawLines) {
    result.push(rawLine.replace(/^\s*\*?\s?/u, "").trim());
  }
  return result;
}

/**
 * Determines whether a prose value is exactly one explicit purpose sentence.
 *
 * Inputs: A normalized purpose line.
 * Outputs: True when the line has one terminal sentence mark and nonempty prose.
 * Does not handle: Natural-language sentence segmentation or abbreviation detection.
 * Side effects: None.
 */
export function isOneSentence(value) {
  return /^[^.!?]+[.!?]$/u.test(value.trim());
}

/**
 * Evaluates a JSDoc block against the required structured documentation fields.
 *
 * Inputs: A raw JSDoc block.
 * Outputs: Stable missing-field codes, empty when the block satisfies the contract.
 * Does not handle: Semantic correctness of the stated behavior.
 * Side effects: None.
 */
export function documentationIssues(jsDoc) {
  const lines = jsDocContentLines(jsDoc);
  const issues = [];
  let purpose = "";
  let sawSection = false;
  const sectionContents = new Map();
  let currentSection;

  for (const line of lines) {
    const section = requiredSectionFromLine(line);
    if (section !== undefined) {
      sawSection = true;
      currentSection = section.name;
      sectionContents.set(section.name, section.value);
      continue;
    }
    if (!sawSection && purpose.length === 0 && line.length > 0) {
      purpose = line;
      continue;
    }
    if (currentSection !== undefined && line.length > 0) {
      const previous = sectionContents.get(currentSection) ?? "";
      sectionContents.set(currentSection, `${previous} ${line}`.trim());
    }
  }

  if (!isOneSentence(purpose)) {
    issues.push("MISSING_OR_INVALID_PURPOSE");
  }
  for (const sectionName of REQUIRED_SECTIONS) {
    if ((sectionContents.get(sectionName) ?? "").trim().length === 0) {
      issues.push(`MISSING_${sectionName.toUpperCase().replace(/\s+/gu, "_")}`);
    }
  }
  for (const issue of rejectedTemplateIssues(purpose, sectionContents)) {
    issues.push(issue);
  }
  return issues;
}

/**
 * Rejects a small, versioned set of previously observed hollow documentation templates.
 *
 * Inputs: The parsed purpose sentence and structured-section content for one JSDoc block.
 * Outputs: Stable rejection codes for exact prohibited template families, or an empty list.
 * Does not handle: Determining whether other prose is semantically complete, true, or useful.
 * Side effects: None.
 */
export function rejectedTemplateIssues(purpose, sectionContents) {
  const issues = [];
  for (const rule of REJECTED_TEMPLATE_RULES) {
    const documentedValue = rule.field === "purpose"
      ? purpose
      : sectionContents.get(rule.field) ?? "";
    if (rule.values.has(normalizeDocumentationValue(documentedValue))) {
      issues.push(rule.code);
    }
  }
  return issues;
}

/**
 * Canonicalizes one complete documentation field before it is compared to a known hollow template.
 *
 * Inputs: One purpose or structured-section value from a parsed JSDoc block.
 * Outputs: A trimmed, whitespace-collapsed, lowercase value suitable only for exact template comparison.
 * Does not handle: Semantic equivalence, punctuation rewriting, or partial phrase matching.
 * Side effects: None.
 */
export function normalizeDocumentationValue(documentedValue) {
  return documentedValue.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/**
 * Parses one exact structured-section heading from a JSDoc content line.
 *
 * Inputs: A normalized JSDoc content line.
 * Outputs: A recognized section name and inline value, or undefined for prose.
 * Does not handle: Case-insensitive headings or alternate field names.
 * Side effects: None.
 */
export function requiredSectionFromLine(line) {
  for (const sectionName of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^${escapeRegExp(sectionName)}:\\s*(.*)$`, "u");
    const match = pattern.exec(line);
    if (match !== null) {
      return { name: sectionName, value: match[1] ?? "" };
    }
  }
  return undefined;
}

/**
 * Escapes a literal string for use in a regular expression source.
 *
 * Inputs: A literal string.
 * Outputs: A regular-expression-safe representation of that string.
 * Does not handle: Regular-expression construction failures outside JavaScript syntax rules.
 * Side effects: None.
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Builds a privacy-safe documentation-contract diagnostic for one implementation node.
 *
 * Inputs: A logical source path, source file, function node, category, and issue code.
 * Outputs: A deterministic diagnostic with path, line, category, and code only.
 * Does not handle: Function names, source excerpts, or raw documentation content.
 * Side effects: None.
 */
export function createDiagnostic(logicalPath, sourceFile, node, category, code) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: safeDiagnosticPath(logicalPath),
    line: position.line + 1,
    category,
    code,
  };
}

/**
 * Builds a fixed privacy-safe diagnostic for source-discovery failure.
 *
 * Inputs: A fixed discovery failure code.
 * Outputs: A deterministic diagnostic without any filesystem path or source content.
 * Does not handle: Identifying which untrusted symlink or Git metadata caused the failure.
 * Side effects: None.
 */
export function createDiscoveryDiagnostic(code) {
  return {
    file: DISCOVERY_DIAGNOSTIC_FILE,
    line: 0,
    category: "discovery",
    code,
  };
}

/**
 * Collects documentation-contract diagnostics from one source file.
 *
 * Inputs: A logical/canonical source candidate.
 * Outputs: Sorted diagnostics for every runtime function implementation in that file.
 * Does not handle: Parse diagnostics unrelated to function documentation.
 * Side effects: Reads the source file from disk.
 */
export function checkFileDocumentation(candidate) {
  let text;
  try {
    text = readFileSync(candidate.canonicalPath, "utf8");
  } catch {
    return undefined;
  }
  const sourceFile = ts.createSourceFile(
    candidate.logicalPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(candidate.logicalPath),
  );
  const diagnostics = [];

  /**
   * Recursively visits every AST child and records runtime implementation documentation gaps.
   *
   * Inputs: A TypeScript AST node.
   * Outputs: No return value; diagnostics are appended to the enclosing array.
   * Does not handle: Parse errors or non-function implementation semantics.
   * Side effects: Mutates the enclosing diagnostics array.
   */
  function visit(node) {
    const category = functionCategory(node);
    if (category !== undefined) {
      const jsDoc = associatedJSDoc(node, sourceFile);
      if (jsDoc === undefined) {
        diagnostics.push(createDiagnostic(candidate.logicalPath, sourceFile, node, category, "MISSING_JSDOC"));
      } else {
        const issues = documentationIssues(jsDoc);
        for (const code of issues) {
          diagnostics.push(createDiagnostic(candidate.logicalPath, sourceFile, node, category, code));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  diagnostics.sort(compareDiagnostics);
  return diagnostics;
}

/**
 * Selects the TypeScript parser mode for one eligible implementation file.
 *
 * Inputs: An absolute implementation-file path.
 * Outputs: JavaScript mode for MJS files and TypeScript mode otherwise.
 * Does not handle: JSX, CommonJS, or languages outside the scanner policy.
 * Side effects: None.
 */
export function scriptKindForPath(absolutePath) {
  return absolutePath.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * Orders diagnostics deterministically by path, line, category, and code.
 *
 * Inputs: Two documentation-contract diagnostics.
 * Outputs: A standard lexical comparison result.
 * Does not handle: Human-priority sorting or localization.
 * Side effects: None.
 */
export function compareDiagnostics(left, right) {
  const leftKey = `${left.file}\u0000${String(left.line).padStart(9, "0")}\u0000${left.category}\u0000${left.code}`;
  const rightKey = `${right.file}\u0000${String(right.line).padStart(9, "0")}\u0000${right.category}\u0000${right.code}`;
  return compareStrings(leftKey, rightKey);
}

/**
 * Evaluates the full documented implementation scope for a repository root.
 *
 * Inputs: A repository root directory and optional canonical requested logical file paths.
 * Outputs: Checked-file count and deterministic documentation-contract diagnostics.
 * Does not handle: Files outside src, scripts, and test; dependencies; generated output; and checker fixtures.
 * Side effects: Reads filesystem metadata and source files.
 */
export function checkDocumentationContract(rootDirectory = process.cwd(), requestedFiles = []) {
  const discovery = discoverImplementationFiles(rootDirectory, requestedFiles);
  const diagnostics = [];
  for (const failure of discovery.failures) {
    diagnostics.push(createDiscoveryDiagnostic(failure));
  }
  for (const candidate of discovery.candidates) {
    const fileDiagnostics = checkFileDocumentation(candidate);
    if (fileDiagnostics === undefined) {
      diagnostics.push(createDiscoveryDiagnostic(READ_DISCOVERY_FAILURE));
      continue;
    }
    for (const diagnostic of fileDiagnostics) {
      diagnostics.push(diagnostic);
    }
  }
  diagnostics.sort(compareDiagnostics);
  return {
    filesChecked: discovery.candidates.length,
    diagnostics,
    fileInventory: discovery.fileInventory,
  };
}

/**
 * Formats documentation-contract diagnostics without including source text or symbol names.
 *
 * Inputs: A documentation-contract result object.
 * Outputs: A newline-delimited diagnostic report.
 * Does not handle: Machine-readable formats other than this stable text protocol.
 * Side effects: None.
 */
export function formatDiagnostics(result) {
  if (result.diagnostics.length === 0) {
    return `documentation contract passed (${result.filesChecked} files checked)`;
  }
  const lines = [
    `documentation contract failed (${result.diagnostics.length} diagnostics across ${result.filesChecked} files)`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.file}:${diagnostic.line} ${diagnostic.category} ${diagnostic.code}`);
  }
  return lines.join("\n");
}

/**
 * Parses the legacy root-only checker arguments without accepting lane selectors or unrelated flags.
 *
 * Inputs: Command-line argument strings after the Node executable and script path.
 * Outputs: A root directory string or an error message string.
 * Does not handle: Multiple roots, configuration files, or shell expansion.
 * Side effects: None.
 */
export function parseRootArgument(argumentsList) {
  const parsed = parseCheckerArguments(argumentsList);
  if (!parsed.ok || parsed.requestedFiles.length !== 0) {
    return { ok: false, message: CLI_USAGE };
  }
  return { ok: true, rootDirectory: parsed.rootDirectory };
}

/**
 * Parses checker arguments for a repository-wide run or an explicit local documentation lane.
 *
 * Inputs: Command-line argument strings after the checker script path.
 * Outputs: A root and sorted repeated --file selection, or a fixed usage error without supplied values.
 * Does not handle: Shell expansion, configuration files, multiple roots, or noncanonical requested paths.
 * Side effects: None.
 */
export function parseCheckerArguments(argumentsList) {
  let rootDirectory = process.cwd();
  let sawRoot = false;
  const requestedFiles = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === "--root" && !sawRoot && value !== undefined) {
      rootDirectory = value;
      sawRoot = true;
      index += 1;
      continue;
    }
    if (argument === "--file" && value !== undefined) {
      requestedFiles.push(value);
      index += 1;
      continue;
    }
    return { ok: false, message: CLI_USAGE };
  }
  const selection = normalizeRequestedImplementationFiles(requestedFiles);
  if (!selection.ok) {
    return { ok: false, message: CLI_USAGE };
  }
  return { ok: true, rootDirectory, requestedFiles: selection.paths };
}

/**
 * Runs the documentation-contract command-line interface and returns its process status.
 *
 * Inputs: Command-line argument strings after the script path.
 * Outputs: Zero for a clean contract, one for violations or invalid arguments.
 * Does not handle: Automatic documentation edits or source-formatting repair.
 * Side effects: Reads local files and writes a diagnostics report to stdout or stderr.
 */
export function main(argumentsList = process.argv.slice(2)) {
  const parsed = parseCheckerArguments(argumentsList);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }
  const result = checkDocumentationContract(parsed.rootDirectory, parsed.requestedFiles);
  const output = `${formatDiagnostics(result)}\n`;
  if (result.diagnostics.length === 0) {
    process.stdout.write(output);
    return 0;
  }
  process.stderr.write(output);
  return 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = main();
}
