import type {
  JsonAxes,
  JsonDynamicLookup,
  JsonLocation,
  JsonReason,
  JsonReferenceGroup,
  JsonScope,
  JsonSourceOccurrence,
  JsonUse,
  ReportingInput,
  ExplainSelector,
  SarifLog,
  SarifResult,
  SarifRule,
} from "./types.js";
import { SARIF_SCHEMA_VERSION } from "./types.js";
import { buildExplainReport, buildJsonReport } from "./model.js";

const SARIF_RULES: readonly SarifRule[] = [
  {
    id: "SRI001",
    name: "inventory-listed-no-static-read",
    shortDescription: { text: "Inventory-listed resource has no compatible static code read" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI002",
    name: "missing-provisioning-evidence",
    shortDescription: { text: "Code demand lacks compatible local provisioning evidence" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI003",
    name: "inconclusive-secret-usage",
    shortDescription: { text: "Scoped uncertainty prevents a secret-usage conclusion" },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "SRI004",
    name: "dynamic-environment-lookup",
    shortDescription: { text: "Dynamic environment-key lookup requires review" },
    defaultConfiguration: { level: "note" },
  },
  {
    id: "SRI005",
    name: "user-controlled-environment-lookup",
    shortDescription: { text: "User-controlled input can select an environment key" },
    defaultConfiguration: { level: "warning" },
  },
];

/**
 * Renders the safe reconciliation report as a human-readable terminal summary.
 *
 * Inputs: Reporting input accepted by the JSON report model.
 * Outputs: A newline-terminated no-groups message when the report has no groups; otherwise, a table and optional source section in the ordering supplied by buildJsonReport. Dynamic lookup sections follow either form; default-locale collation ties there retain earlier input order.
 * Does not handle: Writing to stdout, terminal color, source snippets, raw-fact serialization, or imposing a total cross-runtime ordering.
 * Side effects: Builds an in-memory derived report only.
 */
export function renderTerminal(input: ReportingInput): string {
  const report = buildJsonReport(input);
  const lines: string[] = ["Secret reference inventory", ""];

  if (report.groups.length === 0) {
    lines.push("No named source or bound-inventory references found.");
  } else {
    const rows = report.groups.flatMap(
      /**
       * Expands one report group into its terminal table rows.
       *
       * Inputs: One sorted reference group.
       * Outputs: A row for each use with the key displayed only on the first row.
       * Does not handle: Column sizing, escaping, or source-section rendering.
       * Side effects: None.
       */
      (group) =>
        group.uses.map(
          /**
           * Formats one grouped use as a fixed-order table row.
           *
           * Inputs: A JSON use and its position within its reference group.
           * Outputs: Ten display-safe table cells.
           * Does not handle: Width padding, multiline content, or shared-use determination.
           * Side effects: None.
           */
          (use, index) => [
            index === 0 ? formatKey(group.key) : "",
            use.scope === undefined ? "<unscoped>" : formatScope(use.scope),
            group.shared ? "shared" : "",
            use.targetDiscovery,
            use.demand,
            use.binding,
            use.inventory,
            use.coverage,
            use.constraint,
            use.disposition,
          ],
        ),
    );
    lines.push(
      renderTable(
        [
          "Reference",
          "Consumer",
          "Use",
          "Target",
          "Demand",
          "Binding",
          "Inventory",
          "Coverage",
          "Constraint",
          "Disposition",
        ],
        rows,
      ),
    );

    const groupsWithSources = report.groups.filter(
      /**
       * Keeps only groups that have source-occurrence data for the terminal source section.
       *
       * Inputs: One JSON reference group.
       * Outputs: True when it has at least one safe source occurrence.
       * Does not handle: Source deduplication or path formatting.
       * Side effects: None.
       */
      (group) => group.sources.length > 0,
    );
    if (groupsWithSources.length > 0) {
      lines.push("", "Sources");
      for (const group of groupsWithSources) {
        lines.push(`  ${formatKey(group.key)}`);
        for (const source of group.sources) {
          lines.push(`    ${formatLocation(source.location)} (${source.referenceId})`);
        }
      }
    }
  }

  if (report.dynamicLookups.length > 0) {
    lines.push("", "Dynamic environment lookups");
    for (const lookup of report.dynamicLookups) {
      lines.push(`  ${formatScope(lookup.scope)}`);
      if (lookup.sources[0] !== undefined) {
        lines.push(`    at ${formatLocation(lookup.sources[0].location)}`);
      }
      if (lookup.domain.kind === "unbounded") {
        const origin = lookup.origin === "user-controlled" ? "user-controlled" : "unbounded";
        lines.push(`    ${origin} environment lookup; no key names inferred`);
      } else {
        lines.push(`    ${lookup.domain.kind} lookup ${lookup.domain.display}`);
        lines.push(
          `    likely keys: ${
            lookup.likelyKeys.length === 0
              ? "none"
              : lookup.likelyKeys.map(formatKey).join(", ")
          }`,
        );
      }
      lines.push(`    disposition: ${lookup.disposition}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Serializes the safe report DTO as pretty, newline-terminated versioned JSON.
 *
 * Inputs: Reporting input accepted by the report model.
 * Outputs: Indented JSON text with a trailing newline.
 * Does not handle: Writing files, streaming output, or serializing raw Core facts.
 * Side effects: Builds the report and serializes it in memory.
 */
export function renderJson(input: ReportingInput): string {
  return `${JSON.stringify(buildJsonReport(input), null, 2)}\n`;
}

/**
 * Builds a standardized SARIF log that represents selected report and dynamic-review findings.
 *
 * Inputs: Reporting input accepted by the safe report model.
 * Outputs: One SARIF run with fixed rule metadata and results ordered by compareSarifResult; default-locale comparison ties retain their prior construction order.
 * Does not handle: SARIF file writes, rule configuration, unselected reconciliation states, or a total cross-runtime result ordering.
 * Side effects: Builds a derived report and mutates a local result array.
 */
export function buildSarif(input: ReportingInput): SarifLog {
  const report = buildJsonReport(input);
  const results: SarifResult[] = [];

  for (const group of report.groups) {
    for (const use of group.uses) {
      const finding = sarifFindingForUse(group, use);
      if (finding === undefined) {
        continue;
      }
      results.push({
        ruleId: finding.ruleId,
        level: finding.level,
        message: { text: finding.message },
        ...sarifLocations(group.sources),
        properties: {
          axes: axesFromUse(use),
          ...(use.scope === undefined ? {} : { scope: use.scope }),
          key: group.key,
          ...(use.inventorySnapshot === undefined
            ? {}
            : { inventorySnapshot: use.inventorySnapshot }),
          reasons: use.reasons,
        },
      });
    }
  }

  for (const lookup of report.dynamicLookups) {
    results.push(sarifDynamicResult(lookup));
  }

  return {
    version: SARIF_SCHEMA_VERSION,
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "secret-reference-inventory",
            informationUri: "https://github.com/openai/secret-reference-inventory",
            rules: SARIF_RULES,
          },
        },
        results: results.sort(compareSarifResult),
      },
    ],
  };
}

/**
 * Serializes the generated SARIF log as pretty, newline-terminated JSON.
 *
 * Inputs: Reporting input accepted by buildSarif.
 * Outputs: Indented SARIF JSON text with a trailing newline.
 * Does not handle: File emission, SARIF schema validation, or raw-fact serialization.
 * Side effects: Builds and serializes the SARIF object in memory.
 */
export function renderSarif(input: ReportingInput): string {
  return `${JSON.stringify(buildSarif(input), null, 2)}\n`;
}

/**
 * Renders a safe explanation for one pre-sanitized logical key or dynamic lookup selector.
 *
 * Inputs: Reporting input and a key or dynamic selector already suitable for model matching.
 * Outputs: A newline-terminated explanation, or a fixed no-match message.
 * Does not handle: Parsing selectors, echoing raw input, writing output, or source-text display.
 * Side effects: Builds an in-memory explanation report.
 */
export function renderExplain(input: ReportingInput, selector: ExplainSelector): string {
  const explanation = buildExplainReport(input, selector);
  if (explanation === undefined) {
    return "No safe matching fact found.\n";
  }

  const lines = [explanation.heading, "", "Axes"];
  for (const axes of explanation.axes) {
    lines.push(
      `  demand=${axes.demand} binding=${axes.binding} inventory=${axes.inventory} coverage=${axes.coverage} disposition=${axes.disposition}`,
    );
  }

  if (explanation.sources.length > 0) {
    lines.push("", "Sources");
    for (const source of explanation.sources) {
      lines.push(`  ${formatLocation(source.location)} (${source.referenceId})`);
    }
  }

  if (explanation.dynamic !== undefined) {
    lines.push("", "Dynamic lookup");
    if (explanation.dynamic.domain.kind === "unbounded") {
      lines.push("  unbounded environment lookup; no key names inferred");
    } else {
      lines.push(`  ${explanation.dynamic.domain.kind}: ${explanation.dynamic.domain.display}`);
      lines.push(
        `  likely keys: ${
          explanation.dynamic.likelyKeys.length === 0
            ? "none"
            : explanation.dynamic.likelyKeys.map(formatKey).join(", ")
        }`,
      );
    }
  }

  const evidence = explanation.evidence.filter(
    /**
     * Retains explain sections that contain at least one evidence record.
     *
     * Inputs: One labeled explain-evidence section.
     * Outputs: True when the section's evidence array is nonempty.
     * Does not handle: Evidence deduplication or location rendering.
     * Side effects: None.
     */
    (item) => item.evidence.length > 0,
  );
  if (evidence.length > 0) {
    lines.push("", "Evidence");
    for (const item of evidence) {
      lines.push(`  ${item.title}`);
      for (const evidenceItem of item.evidence) {
        const locations = evidenceItem.locations.map(formatLocation).join(", ");
        lines.push(
          `    ${evidenceItem.ruleId} / ${evidenceItem.diagnosticCode}${
            locations.length === 0 ? "" : ` at ${locations}`
          }`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Maps one report use to the SARIF rule, level, and message that warrants a finding.
 *
 * Inputs: The containing reference group and one grouped use.
 * Outputs: A finding descriptor for inventory-only, missing, or inconclusive use states, or undefined.
 * Does not handle: Dynamic lookups, source location materialization, or SARIF result assembly.
 * Side effects: None.
 */
function sarifFindingForUse(
  group: JsonReferenceGroup,
  use: JsonUse,
): { readonly ruleId: string; readonly level: "note" | "warning"; readonly message: string } | undefined {
  if (use.inventory === "inventory-listed-no-static-read") {
    return {
      ruleId: "SRI001",
      level: "warning",
      message: `Inventory-listed resource has no compatible static read for ${formatKey(group.key)}.`,
    };
  }
  if (use.inventory === "missing" || use.inventory === "missing-under-declared-model") {
    return {
      ruleId: "SRI002",
      level: "warning",
      message: `Compatible local provisioning evidence is missing for ${formatKey(group.key)}.`,
    };
  }
  if (use.disposition === "inconclusive") {
    return {
      ruleId: "SRI003",
      level: "warning",
      message: `Secret-usage conclusion is inconclusive for ${formatKey(group.key)}.`,
    };
  }
  return undefined;
}

/**
 * Converts a dynamic lookup into its dedicated SARIF result and review severity.
 *
 * Inputs: One safe JSON dynamic lookup.
 * Outputs: A SARIF result using SRI004 or SRI005 with safe scope, domain, axes, and optional locations.
 * Does not handle: Dynamic-expression analysis, likely-key inference, or result ordering.
 * Side effects: None.
 */
function sarifDynamicResult(lookup: JsonDynamicLookup): SarifResult {
  const unbounded = lookup.domain.kind === "unbounded";
  const userControlled = unbounded && lookup.origin === "user-controlled";
  const ruleId = userControlled ? "SRI005" : "SRI004";
  const level: "note" | "warning" = userControlled || unbounded ? "warning" : "note";
  const message = unbounded
    ? userControlled
      ? "User-controlled input can select an environment key; no key name is inferred."
      : "Unbounded environment-key lookup; no key name is inferred."
    : `Dynamic ${lookup.domain.kind} environment lookup ${lookup.domain.display} has ${lookup.likelyKeys.length} likely key(s).`;

  return {
    ruleId,
    level,
    message: { text: message },
    ...sarifLocations(lookup.sources),
    properties: {
      axes: axesFromDynamic(lookup),
      scope: lookup.scope,
      dynamic: lookup.domain,
      reasons: lookup.reasons,
    },
  };
}

/**
 * Converts unique source locations into SARIF physical locations when any are available.
 *
 * Inputs: Safe source occurrences attached to a report group or dynamic lookup.
 * Outputs: An object containing unique SARIF locations, or an empty object when no locations exist.
 * Does not handle: URI canonicalization, source snippets, end-coordinate validation, or enforcing an upper coordinate bound before incrementing.
 * Side effects: Allocates intermediate location arrays.
 */
function sarifLocations(
  sources: readonly JsonSourceOccurrence[],
): Pick<SarifResult, "locations"> {
  const locations = sources
    .map(
      /**
       * Extracts the safe source location from one occurrence.
       *
       * Inputs: One JSON source occurrence.
       * Outputs: Its JSON location.
       * Does not handle: Coordinate conversion or duplicate removal.
       * Side effects: None.
       */
      (source) => source.location,
    )
    .filter(
      /**
       * Retains only the first occurrence of each path/start-coordinate tuple.
       *
       * Inputs: A location, its index, and the full mapped location array.
       * Outputs: True when no earlier location has the same path, line, and column.
       * Does not handle: End-coordinate distinctions or URI normalization.
       * Side effects: Searches the provided array.
       */
      (location, index, values) =>
        values.findIndex(
          /**
           * Compares one candidate location to the coordinate tuple being deduplicated.
           *
           * Inputs: One location from the mapped location array.
           * Outputs: True when its path and start coordinates match the current location.
           * Does not handle: End-coordinate comparison or safe-path validation.
           * Side effects: None.
           */
          (candidate) =>
            candidate.path === location.path &&
            candidate.start.line === location.start.line &&
            candidate.start.column === location.start.column,
        ) === index,
    )
    .map(
      /**
       * Converts one unique JSON location to the SARIF physical-location structure.
       *
       * Inputs: One safe JSON location with zero-based coordinates.
       * Outputs: A SARIF location with coordinates transformed by toSarifCoordinate; an input at Number.MAX_SAFE_INTEGER becomes an unsafe integer after the unguarded increment.
       * Does not handle: Source-region snippets, URI remapping, duplicate removal, or an upper-bound/overflow guard for coordinates.
       * Side effects: None.
       */
      (location) => ({
        physicalLocation: {
          artifactLocation: { uri: location.path },
          region: {
            startLine: toSarifCoordinate(location.start.line),
            startColumn: toSarifCoordinate(location.start.column),
            endLine: toSarifCoordinate(location.end.line),
            endColumn: toSarifCoordinate(location.end.column),
          },
        },
      }),
    );
  return locations.length === 0 ? {} : { locations };
}

/**
 * Renders a rectangular text table by sizing columns to headers and supplied safe cells.
 *
 * Inputs: Header cells and zero or more row cell arrays.
 * Outputs: A newline-joined table with a separator row and trimmed trailing spaces.
 * Does not handle: ANSI width, multiline cells, escaping, or ragged-row validation.
 * Side effects: Allocates rendered rows and invokes local rendering callbacks.
 */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map(
    /**
     * Calculates the display width needed for one table column.
     *
     * Inputs: A header cell and its column index.
     * Outputs: The maximum raw string length among that header and all row cells in the column.
     * Does not handle: Unicode terminal width, line breaks, or missing-row expansion.
     * Side effects: Iterates the rows collection.
     */
    (header, index) =>
      Math.max(
        header.length,
        ...rows.map(
          /**
           * Reads one optional cell's raw length for a selected column.
           *
           * Inputs: One row and the captured column index.
           * Outputs: The selected cell length, treating missing cells as empty.
           * Does not handle: Cell sanitization or terminal-width calculation.
           * Side effects: None.
           */
          (row) => (row[index] ?? "").length,
        ),
      ),
  );
  const renderRow = /**
   * Pads one row's cells to the previously computed column widths.
   *
   * Inputs: A header, separator, or data row cell array.
   * Outputs: One trimmed terminal table line.
   * Does not handle: Cell escaping, width recomputation, or row validation.
   * Side effects: None.
   */ (row: readonly string[]): string =>
    row
      .map(
        /**
         * Pads one cell to its assigned column width.
         *
         * Inputs: A cell value and column index.
         * Outputs: The cell or empty string padded to the captured width.
         * Does not handle: Unicode display width or column-width calculation.
         * Side effects: None.
         */
        (cell, index) => (cell ?? "").padEnd(widths[index] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [
    renderRow(headers),
    renderRow(
      widths.map(
        /**
         * Creates the dashed separator cell for one computed width.
         *
         * Inputs: One nonnegative table column width.
         * Outputs: A string of dashes of that length.
         * Does not handle: Minimum separator width or display-width adjustments.
         * Side effects: None.
         */
        (width) => "-".repeat(width),
      ),
    ),
    ...rows.map(renderRow),
  ].join("\n");
}

/**
 * Extracts status axes from a use for SARIF properties.
 *
 * Inputs: One JSON use entry.
 * Outputs: Its status-axis object.
 * Does not handle: Reason serialization, scope extraction, or status computation.
 * Side effects: None.
 */
function axesFromUse(use: JsonUse): JsonAxes {
  return {
    targetDiscovery: use.targetDiscovery,
    demand: use.demand,
    binding: use.binding,
    inventory: use.inventory,
    coverage: use.coverage,
    constraint: use.constraint,
    disposition: use.disposition,
  };
}

/**
 * Extracts status axes from a dynamic lookup for SARIF properties.
 *
 * Inputs: One JSON dynamic lookup.
 * Outputs: Its status-axis object.
 * Does not handle: Domain serialization, source locations, or status computation.
 * Side effects: None.
 */
function axesFromDynamic(lookup: JsonDynamicLookup): JsonAxes {
  return {
    targetDiscovery: lookup.targetDiscovery,
    demand: lookup.demand,
    binding: lookup.binding,
    inventory: lookup.inventory,
    coverage: lookup.coverage,
    constraint: lookup.constraint,
    disposition: lookup.disposition,
  };
}

/**
 * Formats an already-safe logical key for human-facing terminal or SARIF text.
 *
 * Inputs: A namespace/name key object.
 * Outputs: The namespace:name string.
 * Does not handle: Sanitization, escaping, or namespace validation.
 * Side effects: None.
 */
function formatKey(key: { readonly namespace: string; readonly name: string }): string {
  return `${key.namespace}:${key.name}`;
}

/**
 * Formats a safe scope identity with its phase and formatted stage.
 *
 * Inputs: One JSON execution scope.
 * Outputs: An id/phase/stage display string.
 * Does not handle: Channel display, stage inference, or identifier sanitization.
 * Side effects: None.
 */
function formatScope(scope: JsonScope): string {
  return `${scope.id}/${scope.phase}/${formatStage(scope)}`;
}

/**
 * Formats a safe stage predicate for terminal display.
 *
 * Inputs: One JSON execution scope containing its stage predicate.
 * Outputs: Comma-separated exact values, a fixed empty marker, or the predicate kind.
 * Does not handle: Stage matching, value sanitization, or multiline formatting.
 * Side effects: None.
 */
function formatStage(scope: JsonScope): string {
  if (scope.stage.kind === "exact") {
    return scope.stage.values?.join(",") || "<none>";
  }
  return scope.stage.kind;
}

/**
 * Formats zero-based JSON coordinates as a conventional one-based terminal location.
 *
 * Inputs: One safe JSON location.
 * Outputs: A path:line:column display string with both start coordinates incremented by one.
 * Does not handle: URI encoding, end-range display, coordinate validation, or an upper-bound guard; a maximum safe coordinate can produce an unsafe integer in output.
 * Side effects: None.
 */
function formatLocation(location: JsonLocation): string {
  return `${location.path}:${location.start.line + 1}:${location.start.column + 1}`;
}

/**
 * Converts an accepted nonnegative zero-based coordinate to SARIF's one-based coordinate.
 *
 * Inputs: One numeric source coordinate.
 * Outputs: The coordinate plus one for a nonnegative safe integer, otherwise one; Number.MAX_SAFE_INTEGER becomes an unsafe integer because the addition is not capped.
 * Does not handle: Upper-bound or overflow enforcement, line/column distinction, or diagnostics.
 * Side effects: None.
 */
function toSarifCoordinate(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value + 1 : 1;
}

/**
 * Orders SARIF results by rule, first location URI, then message text.
 *
 * Inputs: Two SARIF result objects.
 * Outputs: A current-runtime default-locale comparator result by rule, first URI, then message text.
 * Does not handle: Secondary locations, level ordering, full SARIF canonicalization, or a full tie break; a zero result retains prior construction order under stable Array.sort.
 * Side effects: None.
 */
function compareSarifResult(left: SarifResult, right: SarifResult): number {
  const rule = left.ruleId.localeCompare(right.ruleId);
  if (rule !== 0) return rule;
  const leftUri = left.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "";
  const rightUri = right.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "";
  const uri = leftUri.localeCompare(rightUri);
  if (uri !== 0) return uri;
  return left.message.text.localeCompare(right.message.text);
}
