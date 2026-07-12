import ts from "typescript";

import type { SourceLanguage } from "../discovery/types.js";

export type RawDynamicOrigin = "lexical" | "user-controlled" | "opaque";

export type RawDynamicDomain =
  | {
      readonly kind: "finite";
      readonly keys: readonly string[];
    }
  | {
      readonly kind: "pattern";
      readonly pattern:
        | { readonly kind: "prefix"; readonly prefix: string }
        | { readonly kind: "suffix"; readonly suffix: string }
        | {
            readonly kind: "surrounded";
            readonly prefix: string;
            readonly suffix: string;
          };
    }
  | {
      readonly kind: "unbounded";
      readonly reason: "user-controlled" | "opaque" | "over-budget";
    };

export interface RawSourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface RawSourceLocation {
  readonly start: RawSourcePosition;
  readonly end: RawSourcePosition;
}

/**
 * Raw AST output is intentionally confined to the immediate extractor
 * materialization boundary. It must never enter caches, reporters, or Core.
 */
export type RawSourceObservation =
  | {
      readonly kind: "exact";
      readonly key: string;
      readonly resolution: "literal" | "constant-folded";
      readonly location: RawSourceLocation;
    }
  | {
      readonly kind: "dynamic";
      readonly domain: RawDynamicDomain;
      readonly origin: RawDynamicOrigin;
      readonly location: RawSourceLocation;
    };

export interface SyntaxBackendInput {
  readonly sourceText: string;
  readonly language: SourceLanguage;
  readonly maxFiniteKeyDomain: number;
}

export interface SyntaxBackendResult {
  readonly observations: readonly RawSourceObservation[];
  readonly parseFailed: boolean;
}

/**
 * A future OXC implementation must emit this same compact raw-observation
 * contract. The public adapter materializes either backend through the one
 * safety/Core port.
 */
export interface SourceSyntaxBackend {
  readonly id: string;
  extract(input: SyntaxBackendInput): SyntaxBackendResult;
}

type KeyDomain =
  | {
      readonly kind: "finite";
      readonly keys: readonly string[];
      readonly origin: RawDynamicOrigin;
      readonly direct: boolean;
      readonly resolution: "literal" | "constant-folded";
    }
  | {
      readonly kind: "pattern";
      readonly pattern: Extract<RawDynamicDomain, { readonly kind: "pattern" }>["pattern"];
      readonly origin: RawDynamicOrigin;
    }
  | {
      readonly kind: "unbounded";
      readonly reason: Extract<RawDynamicDomain, { readonly kind: "unbounded" }>["reason"];
      readonly origin: RawDynamicOrigin;
    };

type Binding =
  | { readonly kind: "environment" }
  | { readonly kind: "key"; readonly domain: KeyDomain }
  | { readonly kind: "map"; readonly entries: ReadonlyMap<string, KeyDomain> }
  | { readonly kind: "user-controlled" }
  | { readonly kind: "unknown" };

/**
 * A declaration without a resolved binding intentionally hides a parent
 * binding. This protects against alias/global shadowing before the initializer
 * itself is visited.
 */
class LexicalScope {
  readonly #declared = new Set<string>();
  readonly #bindings = new Map<string, Binding>();

  public constructor(readonly parent: LexicalScope | undefined) {}

  public declare(name: string): void {
    this.#declared.add(name);
  }

  public set(name: string, binding: Binding): void {
    this.#declared.add(name);
    this.#bindings.set(name, binding);
  }

  public resolve(name: string): Binding | undefined {
    for (
      let current: LexicalScope | undefined = this;
      current !== undefined;
      current = current.parent
    ) {
      if (current.#declared.has(name)) {
        return current.#bindings.get(name);
      }
    }
    return undefined;
  }

  public hasDeclaration(name: string): boolean {
    for (
      let current: LexicalScope | undefined = this;
      current !== undefined;
      current = current.parent
    ) {
      if (current.#declared.has(name)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Correctness-first TypeScript Compiler API backend. It creates one syntax
 * tree for the supplied text only; it does not construct a Program, resolve
 * modules, read files, execute code, or consult ts.sys.
 */
export class TypeScriptSyntaxBackend implements SourceSyntaxBackend {
  readonly id = "typescript-compiler-api/v1";

  public extract(input: SyntaxBackendInput): SyntaxBackendResult {
    const source = ts.createSourceFile(
      "<source>",
      input.sourceText,
      ts.ScriptTarget.Latest,
      false,
      scriptKindFor(input.language),
    );
    const observations = new SourceScanner(source, input.maxFiniteKeyDomain).scan();
    return {
      observations,
      parseFailed: parserDiagnostics(source).length > 0,
    };
  }
}

/**
 * Syntax-only scanner used by the TypeScript backend. Its raw observations are
 * immediately handed to the extractor's safety materialization boundary.
 */
class SourceScanner {
  readonly #observations: RawSourceObservation[] = [];
  readonly #emittedLocations = new Set<string>();
  readonly #exportedTopLevelNames = new Set<string>();
  readonly #maxFiniteKeyDomain: number;
  #rootScope: LexicalScope | undefined;

  public constructor(
    readonly source: ts.SourceFile,
    maxFiniteKeyDomain: number,
  ) {
    this.#maxFiniteKeyDomain =
      Number.isSafeInteger(maxFiniteKeyDomain) && maxFiniteKeyDomain > 0
        ? maxFiniteKeyDomain
        : 100;
  }

  public scan(): readonly RawSourceObservation[] {
    this.collectTopLevelExportNames();
    const scope = this.createScope(undefined, this.source.statements);
    this.#rootScope = scope;
    this.visitStatements(this.source.statements, scope);
    return Object.freeze([...this.#observations]);
  }

  private collectTopLevelExportNames(): void {
    for (const statement of this.source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        statement.moduleSpecifier !== undefined ||
        statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          this.#exportedTopLevelNames.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }

  private createScope(
    parent: LexicalScope | undefined,
    statements: readonly ts.Statement[],
    parameters: readonly ts.ParameterDeclaration[] = [],
    exportedParameters = false,
  ): LexicalScope {
    const scope = new LexicalScope(parent);
    for (const statement of statements) {
      this.predeclareStatement(statement, scope);
    }
    for (const parameter of parameters) {
      for (const name of bindingNames(parameter.name)) {
        scope.set(name, exportedParameters ? { kind: "user-controlled" } : { kind: "unknown" });
      }
    }
    return scope;
  }

  private predeclareStatement(statement: ts.Statement, scope: LexicalScope): void {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          scope.declare(name);
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      scope.declare(statement.name.text);
      return;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      scope.declare(statement.name.text);
      return;
    }
    if (ts.isEnumDeclaration(statement)) {
      scope.declare(statement.name.text);
      return;
    }
    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause;
      if (clause.name !== undefined) {
        scope.declare(clause.name.text);
      }
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          scope.declare(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            scope.declare(element.name.text);
          }
        }
      }
    }
  }

  private visitStatements(statements: readonly ts.Statement[], scope: LexicalScope): void {
    for (const statement of statements) {
      this.visit(statement, scope);
    }
  }

  private visit(node: ts.Node, scope: LexicalScope, exported = false): void {
    if (ts.isBlock(node)) {
      const blockScope = this.createScope(scope, node.statements);
      this.visitStatements(node.statements, blockScope);
      return;
    }
    if (ts.isVariableStatement(node)) {
      this.visitVariableList(node.declarationList, scope, hasExportModifier(node));
      return;
    }
    if (ts.isVariableDeclarationList(node)) {
      this.visitVariableList(node, scope, exported);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (node.name !== undefined) {
        scope.set(node.name.text, { kind: "unknown" });
      }
      this.visitFunction(
        node,
        scope,
        hasExportModifier(node) ||
          (node.name !== undefined && this.isTopLevelExport(scope, node.name.text)),
      );
      return;
    }
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      this.visitFunction(node, scope, exported);
      return;
    }
    if (ts.isForInStatement(node)) {
      this.visitForIn(node, scope);
      return;
    }
    if (ts.isExportAssignment(node)) {
      if (ts.isFunctionExpression(node.expression) || ts.isArrowFunction(node.expression)) {
        this.visitFunction(node.expression, scope, true);
        return;
      }
      if (this.isEnvironmentObject(node.expression, scope)) {
        this.emitDomain(unbounded("opaque"), node);
        return;
      }
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined && this.isEnvironmentObject(node.expression, scope)) {
      this.emitDomain(unbounded("opaque"), node);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (this.visitEnvironmentCall(node, scope)) {
        return;
      }
      if (node.arguments.some((argument) => this.isEnvironmentObject(argument, scope))) {
        this.emitDomain(unbounded("opaque"), node);
        this.visit(node.expression, scope);
        for (const argument of node.arguments) {
          if (!this.isEnvironmentObject(argument, scope)) {
            this.visit(argument, scope);
          }
        }
        return;
      }
    }
    if (ts.isSpreadAssignment(node) && this.isEnvironmentObject(node.expression, scope)) {
      this.emitDomain(unbounded("opaque"), node);
      return;
    }
    if (ts.isSpreadElement(node) && this.isEnvironmentObject(node.expression, scope)) {
      this.emitDomain(unbounded("opaque"), node);
      return;
    }
    if (ts.isJsxSpreadAttribute(node) && this.isEnvironmentObject(node.expression, scope)) {
      this.emitDomain(unbounded("opaque"), node);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      this.isEnvironmentObject(node.right, scope)
    ) {
      this.emitDomain(unbounded("opaque"), node);
      this.visit(node.left, scope);
      return;
    }
    if (ts.isPropertyAssignment(node) && this.isEnvironmentObject(node.initializer, scope)) {
      this.emitDomain(unbounded("opaque"), node);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const domain = this.environmentPropertyDomain(node, scope);
      if (domain !== undefined) {
        this.emitDomain(domain, node);
        return;
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const domain = this.environmentElementDomain(node, scope);
      if (domain !== undefined) {
        this.emitDomain(domain, node);
        if (node.argumentExpression !== undefined) {
          this.visit(node.argumentExpression, scope);
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => this.visit(child, scope));
  }

  private visitVariableList(
    list: ts.VariableDeclarationList,
    scope: LexicalScope,
    exported: boolean,
  ): void {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of list.declarations) {
      this.visitVariable(declaration, scope, isConst, exported);
    }
  }

  private visitVariable(
    declaration: ts.VariableDeclaration,
    scope: LexicalScope,
    isConst: boolean,
    exported: boolean,
  ): void {
    const initializer = declaration.initializer;
    if (initializer !== undefined && ts.isObjectBindingPattern(declaration.name)) {
      if (this.isEnvironmentObject(initializer, scope)) {
        this.visitEnvironmentDestructure(declaration.name, scope);
        for (const name of bindingNames(declaration.name)) {
          scope.set(name, { kind: "unknown" });
        }
        return;
      }
      this.visit(initializer, scope);
      for (const name of bindingNames(declaration.name)) {
        scope.set(name, { kind: "unknown" });
      }
      return;
    }

    if (!ts.isIdentifier(declaration.name)) {
      if (initializer !== undefined) {
        this.visit(initializer, scope);
      }
      return;
    }

    const name = declaration.name.text;
    const functionIsExported = exported || this.isTopLevelExport(scope, name);
    if (initializer !== undefined && isConst && this.isEnvironmentObject(initializer, scope)) {
      scope.set(name, { kind: "environment" });
      return;
    }
    if (initializer !== undefined && !isConst && this.isEnvironmentObject(initializer, scope)) {
      scope.set(name, { kind: "unknown" });
      this.emitDomain(unbounded("opaque"), declaration);
      return;
    }
    if (
      initializer !== undefined &&
      (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))
    ) {
      scope.set(name, { kind: "unknown" });
      this.visitFunction(initializer, scope, functionIsExported);
      return;
    }
    if (initializer !== undefined && isConst) {
      const map = this.describeMap(initializer, scope);
      scope.set(
        name,
        map === undefined
          ? { kind: "key", domain: this.describeKey(initializer, scope) }
          : { kind: "map", entries: map },
      );
      this.visit(initializer, scope);
      return;
    }

    scope.set(name, { kind: "unknown" });
    if (initializer !== undefined) {
      this.visit(initializer, scope);
    }
  }

  private visitFunction(
    node:
      | ts.FunctionDeclaration
      | ts.FunctionExpression
      | ts.ArrowFunction
      | ts.MethodDeclaration
      | ts.ConstructorDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
    parent: LexicalScope,
    exported: boolean,
  ): void {
    if (node.body === undefined) {
      return;
    }
    const statements = ts.isBlock(node.body) ? node.body.statements : [];
    const scope = this.createScope(parent, statements, node.parameters, exported);
    for (const parameter of node.parameters) {
      if (parameter.initializer !== undefined) {
        this.visit(parameter.initializer, scope);
      }
    }
    if (ts.isBlock(node.body)) {
      this.visitStatements(node.body.statements, scope);
    } else {
      this.visit(node.body, scope);
    }
  }

  private isTopLevelExport(scope: LexicalScope, name: string): boolean {
    return scope === this.#rootScope && this.#exportedTopLevelNames.has(name);
  }

  private visitForIn(node: ts.ForInStatement, parent: LexicalScope): void {
    const scope = new LexicalScope(parent);
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        for (const name of bindingNames(declaration.name)) {
          scope.declare(name);
        }
      }
      this.visitVariableList(node.initializer, scope, false);
    } else {
      this.visit(node.initializer, scope);
    }
    if (this.isEnvironmentObject(node.expression, scope)) {
      this.emitDomain(unbounded("opaque"), node.expression);
    } else {
      this.visit(node.expression, scope);
    }
    this.visit(node.statement, scope);
  }

  private visitEnvironmentDestructure(
    pattern: ts.ObjectBindingPattern,
    scope: LexicalScope,
  ): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) {
        this.emitDomain(unbounded("opaque"), element);
      } else {
        const domain = this.destructureKey(element, scope);
        this.emitDomain(domain ?? unbounded("opaque"), element);
      }
      if (element.initializer !== undefined) {
        this.visit(element.initializer, scope);
      }
    }
  }

  private destructureKey(element: ts.BindingElement, scope: LexicalScope): KeyDomain | undefined {
    if (element.propertyName === undefined) {
      return ts.isIdentifier(element.name)
        ? this.finite([element.name.text], "lexical", true, "literal")
        : undefined;
    }
    const property = element.propertyName;
    if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
      return this.finite([property.text], "lexical", true, "literal");
    }
    return ts.isComputedPropertyName(property)
      ? this.describeKey(property.expression, scope)
      : undefined;
  }

  private visitEnvironmentCall(node: ts.CallExpression, scope: LexicalScope): boolean {
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const callee = node.expression;
    if (callee.name.text === "get" && this.isEnvironmentObject(callee.expression, scope)) {
      const argument = node.arguments[0];
      this.emitDomain(
        argument === undefined ? unbounded("opaque") : this.describeKey(argument, scope),
        node,
      );
      for (const argumentNode of node.arguments) {
        this.visit(argumentNode, scope);
      }
      return true;
    }
    if (!this.isEnumerationCall(node, scope)) {
      return false;
    }
    this.emitDomain(unbounded("opaque"), node);
    for (const argument of node.arguments) {
      if (!this.isEnvironmentObject(argument, scope)) {
        this.visit(argument, scope);
      }
    }
    return true;
  }

  private isEnumerationCall(node: ts.CallExpression, scope: LexicalScope): boolean {
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const callee = node.expression;
    const first = node.arguments[0];
    if (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      !scope.hasDeclaration("Object") &&
      ["keys", "values", "entries"].includes(callee.name.text) &&
      first !== undefined &&
      this.isEnvironmentObject(first, scope)
    ) {
      return true;
    }
    if (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      !scope.hasDeclaration("Object") &&
      callee.name.text === "assign" &&
      node.arguments.some((argument) => this.isEnvironmentObject(argument, scope))
    ) {
      return true;
    }
    return callee.name.text === "toObject" && this.isEnvironmentObject(callee.expression, scope);
  }

  private environmentPropertyDomain(
    node: ts.PropertyAccessExpression,
    scope: LexicalScope,
  ): KeyDomain | undefined {
    return this.isEnvironmentObject(node.expression, scope)
      ? this.finite([node.name.text], "lexical", true, "literal")
      : undefined;
  }

  private environmentElementDomain(
    node: ts.ElementAccessExpression,
    scope: LexicalScope,
  ): KeyDomain | undefined {
    if (!this.isEnvironmentObject(node.expression, scope)) {
      return undefined;
    }
    return node.argumentExpression === undefined
      ? unbounded("opaque")
      : this.describeKey(node.argumentExpression, scope);
  }

  private isEnvironmentObject(node: ts.Expression, scope: LexicalScope): boolean {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      return scope.resolve(expression.text)?.kind === "environment";
    }
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "env") {
      return false;
    }
    const base = unwrapExpression(expression.expression);
    return (
      isUnshadowedGlobal(base, "process", scope) ||
      isUnshadowedGlobal(base, "Bun", scope) ||
      isUnshadowedGlobal(base, "Deno", scope) ||
      isImportMeta(base)
    );
  }

  private describeKey(node: ts.Expression, scope: LexicalScope, depth = 0): KeyDomain {
    if (depth > 32) {
      return unbounded("opaque");
    }
    const expression = unwrapExpression(node);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return this.finite([expression.text], "lexical", true, "literal");
    }
    if (ts.isTemplateExpression(expression)) {
      return this.describeTemplate(expression, scope, depth + 1);
    }
    if (ts.isIdentifier(expression)) {
      const binding = scope.resolve(expression.text);
      if (binding?.kind === "key") {
        return referenceDomain(binding.domain);
      }
      if (binding?.kind === "user-controlled") {
        return unbounded("user-controlled");
      }
      return unbounded("opaque");
    }
    if (ts.isConditionalExpression(expression)) {
      return this.unionDomains(
        this.describeKey(expression.whenTrue, scope, depth + 1),
        this.describeKey(expression.whenFalse, scope, depth + 1),
      );
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return this.concatenateDomains(
        this.describeKey(expression.left, scope, depth + 1),
        this.describeKey(expression.right, scope, depth + 1),
      );
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.describeMapElement(expression, scope, depth + 1);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const map = this.describeMap(expression.expression, scope, depth + 1);
      if (map !== undefined) {
        const selected = map.get(expression.name.text);
        return selected === undefined ? unbounded("opaque") : referenceDomain(selected);
      }
      return this.isUserControlled(expression, scope)
        ? unbounded("user-controlled")
        : unbounded("opaque");
    }
    return this.isUserControlled(expression, scope)
      ? unbounded("user-controlled")
      : unbounded("opaque");
  }

  private describeTemplate(
    node: ts.TemplateExpression,
    scope: LexicalScope,
    depth: number,
  ): KeyDomain {
    const domains = node.templateSpans.map((span) =>
      this.describeKey(span.expression, scope, depth + 1),
    );
    if (domains.every((domain) => domain.kind === "finite")) {
      let keys: string[] = [node.head.text];
      let origin: RawDynamicOrigin = "lexical";
      for (let index = 0; index < domains.length; index += 1) {
        const domain = domains[index];
        const span = node.templateSpans[index];
        if (domain === undefined || span === undefined || domain.kind !== "finite") {
          return unbounded("opaque");
        }
        origin = mergeOrigins(origin, domain.origin);
        const combined = combineKeySets(keys, domain.keys, this.#maxFiniteKeyDomain);
        if (combined === undefined) {
          return unbounded("over-budget", origin);
        }
        keys = combined.map((key) => key + span.literal.text);
      }
      return this.finite(keys, origin, origin === "lexical", "constant-folded");
    }

    let origin: RawDynamicOrigin = "lexical";
    for (const domain of domains) {
      origin = mergeOrigins(origin, domain.origin);
    }
    const prefix = this.templateFixedPrefix(node, domains);
    const suffix = this.templateFixedSuffix(node, domains);
    if (prefix.length > 0 && suffix.length > 0) {
      return {
        kind: "pattern",
        pattern: { kind: "surrounded", prefix, suffix },
        origin,
      };
    }
    if (prefix.length > 0) {
      return { kind: "pattern", pattern: { kind: "prefix", prefix }, origin };
    }
    if (suffix.length > 0) {
      return { kind: "pattern", pattern: { kind: "suffix", suffix }, origin };
    }
    return unbounded(origin === "user-controlled" ? "user-controlled" : "opaque", origin);
  }

  private templateFixedPrefix(
    node: ts.TemplateExpression,
    domains: readonly KeyDomain[],
  ): string {
    let prefix = node.head.text;
    for (let index = 0; index < domains.length; index += 1) {
      const domain = domains[index];
      const span = node.templateSpans[index];
      if (
        domain === undefined ||
        span === undefined ||
        domain.kind !== "finite" ||
        domain.keys.length !== 1 ||
        !domain.direct
      ) {
        break;
      }
      prefix += domain.keys[0] ?? "";
      prefix += span.literal.text;
    }
    return prefix;
  }

  private templateFixedSuffix(
    node: ts.TemplateExpression,
    domains: readonly KeyDomain[],
  ): string {
    const finalSpan = node.templateSpans[node.templateSpans.length - 1];
    let suffix = finalSpan?.literal.text ?? "";
    for (let index = domains.length - 1; index >= 0; index -= 1) {
      const domain = domains[index];
      const precedingLiteral =
        index === 0
          ? node.head.text
          : node.templateSpans[index - 1]?.literal.text;
      if (
        domain === undefined ||
        domain.kind !== "finite" ||
        domain.keys.length !== 1 ||
        !domain.direct
      ) {
        break;
      }
      suffix =
        (precedingLiteral ?? "") +
        (domain.keys[0] ?? "") +
        suffix;
    }
    return suffix;
  }

  private describeMapElement(
    node: ts.ElementAccessExpression,
    scope: LexicalScope,
    depth: number,
  ): KeyDomain {
    const map = this.describeMap(node.expression, scope, depth + 1);
    if (map === undefined) {
      return this.isUserControlled(node, scope)
        ? unbounded("user-controlled")
        : unbounded("opaque");
    }
    const argument = node.argumentExpression;
    const staticKey = argument === undefined ? undefined : staticElementIndex(argument);
    if (staticKey !== undefined) {
      const selected = map.get(staticKey);
      return selected === undefined ? unbounded("opaque") : referenceDomain(selected);
    }
    const selectorOrigin: RawDynamicOrigin =
      argument !== undefined && this.isUserControlled(argument, scope)
        ? "user-controlled"
        : "opaque";
    return this.unionMapValues([...map.values()], selectorOrigin);
  }

  private describeMap(
    node: ts.Expression,
    scope: LexicalScope,
    depth = 0,
  ): ReadonlyMap<string, KeyDomain> | undefined {
    if (depth > 32) {
      return undefined;
    }
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      const binding = scope.resolve(expression.text);
      return binding?.kind === "map" ? binding.entries : undefined;
    }
    if (!ts.isObjectLiteralExpression(expression)) {
      return undefined;
    }
    const entries = new Map<string, KeyDomain>();
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return undefined;
      }
      const name = staticPropertyName(property.name);
      if (name === undefined || entries.has(name)) {
        return undefined;
      }
      const domain = this.describeKey(property.initializer, scope, depth + 1);
      if (domain.kind !== "finite") {
        return undefined;
      }
      entries.set(name, domain);
    }
    return entries.size === 0 ? undefined : entries;
  }

  private unionMapValues(
    values: readonly KeyDomain[],
    selectorOrigin: RawDynamicOrigin,
  ): KeyDomain {
    if (values.length === 0 || values.some((value) => value.kind !== "finite")) {
      return unbounded(
        selectorOrigin === "user-controlled" ? "user-controlled" : "opaque",
        selectorOrigin,
      );
    }
    let origin = selectorOrigin;
    const keys: string[] = [];
    for (const value of values) {
      if (value.kind !== "finite") {
        return unbounded("opaque");
      }
      origin = mergeOrigins(origin, value.origin);
      keys.push(...value.keys);
    }
    return this.finite(keys, origin, false, "constant-folded");
  }

  private unionDomains(left: KeyDomain, right: KeyDomain): KeyDomain {
    const origin = mergeOrigins(left.origin, right.origin);
    if (left.kind === "finite" && right.kind === "finite") {
      return this.finite(
        [...left.keys, ...right.keys],
        origin,
        left.direct && right.direct,
        "constant-folded",
      );
    }
    if (
      left.kind === "pattern" &&
      right.kind === "pattern" &&
      rawPatternsEqual(left.pattern, right.pattern)
    ) {
      return { kind: "pattern", pattern: left.pattern, origin };
    }
    if (
      (left.kind === "unbounded" && left.reason === "over-budget") ||
      (right.kind === "unbounded" && right.reason === "over-budget")
    ) {
      return unbounded("over-budget", origin);
    }
    return unbounded(origin === "user-controlled" ? "user-controlled" : "opaque", origin);
  }

  private concatenateDomains(left: KeyDomain, right: KeyDomain): KeyDomain {
    const origin = mergeOrigins(left.origin, right.origin);
    if (left.kind === "finite" && right.kind === "finite") {
      const keys = combineKeySets(left.keys, right.keys, this.#maxFiniteKeyDomain);
      if (keys === undefined) {
        return unbounded("over-budget", origin);
      }
      return this.finite(keys, origin, left.direct && right.direct, "constant-folded");
    }
    if (left.kind === "finite" && left.keys.length === 1) {
      const prefix = left.keys[0] ?? "";
      if (prefix.length > 0) {
        if (right.kind === "pattern") {
          return this.prependPattern(right, prefix, origin);
        }
        return { kind: "pattern", pattern: { kind: "prefix", prefix }, origin };
      }
    }
    if (right.kind === "finite" && right.keys.length === 1) {
      const suffix = right.keys[0] ?? "";
      if (suffix.length > 0) {
        if (left.kind === "pattern") {
          return this.appendPattern(left, suffix, origin);
        }
        return { kind: "pattern", pattern: { kind: "suffix", suffix }, origin };
      }
    }
    if (
      (left.kind === "unbounded" && left.reason === "over-budget") ||
      (right.kind === "unbounded" && right.reason === "over-budget")
    ) {
      return unbounded("over-budget", origin);
    }
    return unbounded(origin === "user-controlled" ? "user-controlled" : "opaque", origin);
  }

  private prependPattern(
    domain: Extract<KeyDomain, { readonly kind: "pattern" }>,
    prefix: string,
    origin: RawDynamicOrigin,
  ): KeyDomain {
    switch (domain.pattern.kind) {
      case "prefix":
        return {
          kind: "pattern",
          pattern: { kind: "prefix", prefix: prefix + domain.pattern.prefix },
          origin,
        };
      case "suffix":
        return {
          kind: "pattern",
          pattern: { kind: "surrounded", prefix, suffix: domain.pattern.suffix },
          origin,
        };
      case "surrounded":
        return {
          kind: "pattern",
          pattern: {
            kind: "surrounded",
            prefix: prefix + domain.pattern.prefix,
            suffix: domain.pattern.suffix,
          },
          origin,
        };
    }
  }

  private appendPattern(
    domain: Extract<KeyDomain, { readonly kind: "pattern" }>,
    suffix: string,
    origin: RawDynamicOrigin,
  ): KeyDomain {
    switch (domain.pattern.kind) {
      case "prefix":
        return {
          kind: "pattern",
          pattern: { kind: "surrounded", prefix: domain.pattern.prefix, suffix },
          origin,
        };
      case "suffix":
        return {
          kind: "pattern",
          pattern: { kind: "suffix", suffix: domain.pattern.suffix + suffix },
          origin,
        };
      case "surrounded":
        return {
          kind: "pattern",
          pattern: {
            kind: "surrounded",
            prefix: domain.pattern.prefix,
            suffix: domain.pattern.suffix + suffix,
          },
          origin,
        };
    }
  }

  private isUserControlled(node: ts.Expression, scope: LexicalScope): boolean {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      return scope.resolve(expression.text)?.kind === "user-controlled";
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (isCliOrStdinSource(expression, scope) || isRequestInputProperty(expression)) {
        return true;
      }
      return this.isUserControlled(expression.expression, scope);
    }
    if (ts.isElementAccessExpression(expression)) {
      return (
        this.isUserControlled(expression.expression, scope) ||
        (expression.argumentExpression !== undefined &&
          this.isUserControlled(expression.argumentExpression, scope))
      );
    }
    if (ts.isCallExpression(expression)) {
      return (
        this.isUserControlled(expression.expression, scope) ||
        expression.arguments.some((argument) => this.isUserControlled(argument, scope))
      );
    }
    return false;
  }

  private finite(
    rawKeys: readonly string[],
    origin: RawDynamicOrigin,
    direct: boolean,
    resolution: "literal" | "constant-folded",
  ): KeyDomain {
    const keys = [...new Set(rawKeys)];
    if (keys.length === 0) {
      return unbounded("opaque", origin);
    }
    if (keys.length > this.#maxFiniteKeyDomain) {
      return unbounded("over-budget", origin);
    }
    return {
      kind: "finite",
      keys,
      origin,
      direct: direct && origin === "lexical",
      resolution,
    };
  }

  private emitDomain(domain: KeyDomain, node: ts.Node): void {
    const location = locationFor(this.source, node);
    if (domain.kind === "finite" && domain.direct && domain.keys.length === 1) {
      const key = domain.keys[0];
      if (key !== undefined) {
        this.emit({
          kind: "exact",
          key,
          resolution: domain.resolution,
          location,
        });
        return;
      }
    }
    this.emit({
      kind: "dynamic",
      domain:
        domain.kind === "finite"
          ? { kind: "finite", keys: domain.keys }
          : domain.kind === "pattern"
            ? { kind: "pattern", pattern: domain.pattern }
            : { kind: "unbounded", reason: domain.reason },
      origin: domain.origin,
      location,
    });
  }

  private emit(observation: RawSourceObservation): void {
    const location = observation.location;
    const identity =
      observation.kind +
      ":" +
      String(location.start.line) +
      ":" +
      String(location.start.column) +
      ":" +
      String(location.end.line) +
      ":" +
      String(location.end.column);
    if (this.#emittedLocations.has(identity)) {
      return;
    }
    this.#emittedLocations.add(identity);
    this.#observations.push(observation);
  }
}

function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  const names: string[] = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      names.push(...bindingNames(element.name));
    }
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) ?? false
  );
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isUnshadowedGlobal(
  node: ts.Expression,
  name: string,
  scope: LexicalScope,
): boolean {
  return ts.isIdentifier(node) && node.text === name && !scope.hasDeclaration(name);
}

function isImportMeta(node: ts.Expression): boolean {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === "meta"
  );
}

function isRequestInputProperty(node: ts.PropertyAccessExpression): boolean {
  return ["query", "body", "params", "route", "webhook"].includes(node.name.text);
}

function isCliOrStdinSource(node: ts.PropertyAccessExpression, scope: LexicalScope): boolean {
  if (
    node.name.text === "argv" &&
    (isUnshadowedGlobal(node.expression, "process", scope) ||
      isUnshadowedGlobal(node.expression, "Bun", scope))
  ) {
    return true;
  }
  if (node.name.text === "args" && isUnshadowedGlobal(node.expression, "Deno", scope)) {
    return true;
  }
  return node.name.text === "stdin" && isUnshadowedGlobal(node.expression, "process", scope);
}

function staticPropertyName(node: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(node)) {
    return staticElementIndex(node.expression);
  }
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

function staticElementIndex(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)
    ? expression.text
    : undefined;
}

function referenceDomain(domain: KeyDomain): KeyDomain {
  return domain.kind === "finite"
    ? { ...domain, resolution: "constant-folded" }
    : domain;
}

function unbounded(
  reason: Extract<RawDynamicDomain, { readonly kind: "unbounded" }>["reason"],
  origin: RawDynamicOrigin = reason === "user-controlled" ? "user-controlled" : "opaque",
): KeyDomain {
  return { kind: "unbounded", reason, origin };
}

function mergeOrigins(left: RawDynamicOrigin, right: RawDynamicOrigin): RawDynamicOrigin {
  if (left === "user-controlled" || right === "user-controlled") {
    return "user-controlled";
  }
  if (left === "opaque" || right === "opaque") {
    return "opaque";
  }
  return "lexical";
}

function combineKeySets(
  left: readonly string[],
  right: readonly string[],
  max: number,
): string[] | undefined {
  if (left.length === 0 || right.length === 0 || left.length * right.length > max) {
    return undefined;
  }
  const values: string[] = [];
  for (const prefix of left) {
    for (const suffix of right) {
      values.push(prefix + suffix);
      if (values.length > max) {
        return undefined;
      }
    }
  }
  const unique = [...new Set(values)];
  return unique.length > max ? undefined : unique;
}

function rawPatternsEqual(
  left: Extract<RawDynamicDomain, { readonly kind: "pattern" }>["pattern"],
  right: Extract<RawDynamicDomain, { readonly kind: "pattern" }>["pattern"],
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "prefix" && right.kind === "prefix") {
    return left.prefix === right.prefix;
  }
  if (left.kind === "suffix" && right.kind === "suffix") {
    return left.suffix === right.suffix;
  }
  return (
    left.kind === "surrounded" &&
    right.kind === "surrounded" &&
    left.prefix === right.prefix &&
    left.suffix === right.suffix
  );
}

/**
 * The Compiler API exposes syntax diagnostics on its concrete SourceFile at
 * runtime but does not include that member in the public SourceFile interface.
 * Only the count crosses this backend boundary.
 */
function parserDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
  return (
    source as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
}

function scriptKindFor(language: SourceLanguage): ts.ScriptKind {
  switch (language) {
    case "js":
      return ts.ScriptKind.JS;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "ts":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
  }
}

function locationFor(source: ts.SourceFile, node: ts.Node): RawSourceLocation {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character },
  };
}
