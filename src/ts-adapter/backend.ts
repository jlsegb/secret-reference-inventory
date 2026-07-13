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
 * Raw AST output is the internal contract between a syntax backend and an
 * extractor. Direct callers of `TypeScriptSyntaxBackend.extract` and injected
 * collaborators can observe it; neither this type nor the extractor
 * independently sanitizes it. Consumers must keep it out of caches, reporters,
 * and Core facts unless they apply their own safe materialization.
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
 * contract. `TypeScriptSourceExtractor` passes either backend's observations
 * to its injected Core builder, which is a trusted materialization boundary;
 * the extractor returns a backend ID verbatim and does not sanitize a custom
 * backend or builder's output.
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

  /**
   * Creates a lexical scope linked to an optional parent, initially with no declarations or bindings.
   *
   * Inputs: The nearest enclosing scope, or undefined for the root.
   * Outputs: A scope whose parent is retained and whose declaration set/binding map are empty.
   * Does not handle: AST traversal, resolution of parent names, or validating a parent object.
   * Side effects: Allocates the private `Set` and `Map`; it does not read the AST or mutate the parent.
   */
   public constructor(readonly parent: LexicalScope | undefined) {}

  /**
   * Adds a lexical declaration that hides any binding of the same name in ancestor scopes.
   *
   * Inputs: One AST-derived identifier name.
   * Outputs: No value.
   * Does not handle: Assigning a binding classification or removing a previous binding entry.
   * Side effects: Mutates this scope's private declaration set.
   */
   public declare(name: string): void {
    this.#declared.add(name);
  }

  /**
   * Records a declaration and the scanner's current classification for later lexical resolution.
   *
   * Inputs: An AST-derived name and one internal binding variant.
   * Outputs: No value.
   * Does not handle: Validating the binding/domain or updating descendant scopes.
   * Side effects: Mutates this scope's declaration set and binding map, replacing any local binding for the name.
   */
   public set(name: string, binding: Binding): void {
    this.#declared.add(name);
    this.#bindings.set(name, binding);
  }

  /**
   * Finds the nearest declaration and returns its local classification, including undefined for a deliberately unresolved shadow.
   *
   * Inputs: One identifier spelling to resolve lexically.
   * Outputs: The nearest `Binding`, or undefined for an unresolved declaration or no declaration.
   * Does not handle: TypeScript symbol resolution, imports, or distinguishing those two undefined cases.
   * Side effects: Reads this scope and ancestor private collections without mutation.
   */
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

  /**
   * Determines whether any reachable lexical scope declares a name, regardless of its binding classification.
   *
   * Inputs: One identifier spelling.
   * Outputs: True for a local or ancestor declaration.
   * Does not handle: Global declarations, TypeScript symbols, or whether the declaration has an initialized binding.
   * Side effects: Reads declaration sets along the parent chain without allocation or mutation.
   */
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

  /**
   * Parses in-memory source with TypeScript and runs the syntax-only scanner over the resulting source file.
   *
   * Inputs: Source text, source-language tag, and finite-domain cap.
   * Outputs: Raw observations and whether TypeScript attached parser diagnostics to the created source file.
   * Does not handle: Constructing a Program, resolving modules, reading paths, type checking, or executing source.
   * Side effects: Calls `ts.createSourceFile`, allocates a scanner/AST-derived observations, and may propagate Compiler API errors.
   */
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
 * Syntax-only scanner used by the TypeScript backend. When used through
 * `TypeScriptSourceExtractor`, its raw observations are passed to that
 * extractor's injected builder; direct backend callers can receive them
 * without any materialization or redaction.
 */
class SourceScanner {
  readonly #observations: RawSourceObservation[] = [];
  readonly #emittedLocations = new Set<string>();
  readonly #exportedTopLevelNames = new Set<string>();
  readonly #maxFiniteKeyDomain: number;
  #rootScope: LexicalScope | undefined;

  /**
   * Creates a scanner for one already-parsed source file and normalizes its finite-domain cap.
   *
   * Inputs: A TypeScript source file and a proposed finite-key maximum.
   * Outputs: A scanner with the supplied positive safe-integer cap or the fallback cap of 100.
   * Does not handle: Parsing the file, validating source text, or imposing a maximum beyond positive safe integers.
   * Side effects: Retains the AST reference and initializes private observation/export/de-duplication collections.
   */
   public constructor(
    readonly source: ts.SourceFile,
    maxFiniteKeyDomain: number,
  ) {
    this.#maxFiniteKeyDomain =
      Number.isSafeInteger(maxFiniteKeyDomain) && maxFiniteKeyDomain > 0
        ? maxFiniteKeyDomain
        : 100;
  }

  /**
   * Predeclares root bindings, walks source statements in lexical order, and returns a shallow observation-array snapshot.
   *
   * Inputs: No parameters; uses the constructor's source file.
   * Outputs: A frozen shallow copy of emitted raw observations; the observation records and their nested location records remain mutable.
   * Does not handle: Resetting scanner state for a second scan, module resolution, source execution, or deep-freezing returned observations.
   * Side effects: Mutates scanner export/root-scope/observation/de-duplication state and reads the entire in-memory AST.
   */
   public scan(): readonly RawSourceObservation[] {
    this.collectTopLevelExportNames();
    const scope = this.createScope(undefined, this.source.statements);
    this.#rootScope = scope;
    this.visitStatements(this.source.statements, scope);
    return Object.freeze([...this.#observations]);
  }

  /**
   * Records names exported through local named-export declarations so their function parameters are treated as user-controlled.
   *
   * Inputs: No parameters; reads top-level statements from the source file.
   * Outputs: No value.
   * Does not handle: Re-exports from another module, default exports, type-only exports, or semantic export resolution.
   * Side effects: Mutates `#exportedTopLevelNames` while iterating matching export clauses.
   */
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

  /**
   * Constructs a lexical scope after predeclaring statement names and classifying each function parameter.
   *
   * Inputs: Parent scope, statement/parameter AST lists, and whether parameters belong to an exported callable.
   * Outputs: A scope whose declared names shadow ancestors and whose parameters are `user-controlled` or `unknown`.
   * Does not handle: Visiting initializers, destructuring default values, or resolving TypeScript symbols.
   * Side effects: Allocates a `LexicalScope`, reads AST names, and mutates only the newly created scope.
   */
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

  /**
   * Declares statement-introduced names before traversal so an initializer cannot accidentally resolve an outer alias.
   *
   * Inputs: One statement AST node and the scope that owns it.
   * Outputs: No value.
   * Does not handle: Evaluating initializers, handling every declaration form, or assigning an internal `Binding`.
   * Side effects: Reads declaration/import AST nodes and calls `scope.declare`, mutating the supplied scope.
   */
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

  /**
   * Traverses a statement list in source order against one previously prepared lexical scope.
   *
   * Inputs: A statement array and its active scope.
   * Outputs: No value.
   * Does not handle: Creating/predeclaring a new scope or recovering traversal errors.
   * Side effects: Calls `visit` per statement; descendants can mutate scanner observations/scopes.
   */
   private visitStatements(statements: readonly ts.Statement[], scope: LexicalScope): void {
    for (const statement of statements) {
      this.visit(statement, scope);
    }
  }

  /**
   * Dispatches an AST node to lexical-aware handling, emitting only exact reads or conservative dynamic uncertainty.
   *
   * Inputs: One AST node, current lexical scope, and exported-callable context for function nodes.
   * Outputs: No value.
   * Does not handle: Type checking, module resolution, execution semantics, or every JavaScript construct as an environment read.
   * Side effects: Recurses through AST nodes and may append/deduplicate observations or mutate scopes via descendant visitors.
   */
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
      if (node.arguments.some(/**
 * Tests whether one call argument is the recognized environment object being forwarded to an unknown callee.
 *
 * Inputs: One call argument AST expression.
 * Outputs: Whether `isEnvironmentObject` recognizes it in the current scope.
 * Does not handle: Visiting the argument or emitting uncertainty itself.
 * Side effects: Reads the closed-over scope and AST expression during `.some`.
 */
(argument) => this.isEnvironmentObject(argument, scope))) {
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
    ts.forEachChild(node, /**
 * Recursively visits one ordinary child after specialized environment cases declined to consume the parent node.
 *
 * Inputs: One child AST node supplied by `ts.forEachChild`.
 * Outputs: The `void` value expected by `ts.forEachChild`.
 * Does not handle: Creating a child lexical scope; specialized branches do that before this fallback.
 * Side effects: Calls `visit`, which can mutate scanner state and append observations.
 */
(child) => this.visit(child, scope));
  }

  /**
   * Traverses every declaration in one variable list while passing its constness and export context to binding classification.
   *
   * Inputs: A variable-declaration list, active scope, and export context.
   * Outputs: No value.
   * Does not handle: Predeclaring names (the scope setup did that) or inferring mutability beyond the `const` flag.
   * Side effects: Iterates declarations and invokes `visitVariable`, which may mutate scope/scanner state.
   */
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

  /**
   * Classifies one declaration as an environment alias, finite key/map, unknown binding, or dynamic uncertainty and visits required initializer expressions.
   *
   * Inputs: One declaration AST node, its scope, its constness, and exported-function context.
   * Outputs: No value.
   * Does not handle: Assignment flow after declaration, type-based aliasing, or evaluating the initializer.
   * Side effects: Reads initializer AST, mutates the supplied scope's bindings, and may emit uncertainty/visit nested expressions.
   */
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

  /**
   * Visits a callable body in a child scope whose parameters become user-controlled only when the callable is exported.
   *
   * Inputs: One supported callable AST node, its parent scope, and an export flag.
   * Outputs: No value.
   * Does not handle: Overload signatures without a body, closure escape analysis, or executing default parameter expressions.
   * Side effects: Allocates a child scope, visits parameter initializer AST and body descendants, and may emit observations.
   */
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

  /**
   * Checks whether a root-scope name was collected from a local named re-export declaration.
   *
   * Inputs: The candidate scope and an identifier name.
   * Outputs: True only when the scope is exactly `#rootScope` and the name was collected.
   * Does not handle: Default/re-exported-module semantics or nested exports.
   * Side effects: Reads scanner fields and the exported-name set without mutation.
   */
   private isTopLevelExport(scope: LexicalScope, name: string): boolean {
    return scope === this.#rootScope && this.#exportedTopLevelNames.has(name);
  }

  /**
   * Visits a for-in loop in a child scope and records opaque uncertainty when its iterated expression is a recognized environment object.
   *
   * Inputs: A `ForInStatement` AST node and the enclosing scope.
   * Outputs: No value; a recognized environment-object expression produces one opaque dynamic observation, while another expression receives normal traversal.
   * Does not handle: Modeling loop iteration values, assignment flow, or execution counts; it deliberately does not visit the recognized environment-object expression for nested reads.
   * Side effects: Allocates/mutates a child scope, visits the initializer and body, then either emits one opaque observation while skipping the recognized expression or visits the other expression.
   */
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

  /**
   * Emits exact/dynamic observations for properties destructured from a recognized environment object and visits element defaults.
   *
   * Inputs: An object-binding pattern and the scope in which computed property names/defaults are analyzed.
   * Outputs: No value.
   * Does not handle: Binding the destructured local names (the caller does that) or evaluating default values.
   * Side effects: Emits/deduplicates observations and visits default-initializer AST nodes.
   */
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

  /**
   * Converts one destructuring property into a direct literal key domain or analyzes its computed property expression.
   *
   * Inputs: One binding element and the active lexical scope.
   * Outputs: A finite direct domain for identifier/string/numeric properties, a computed domain, or undefined.
   * Does not handle: Rest bindings, nested binding-name semantics, or property evaluation.
   * Side effects: Reads AST shape and may call `describeKey`, which reads scope bindings and allocates domains.
   */
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

  /**
   * Recognizes environment get and supported enumeration or forwarding call forms and emits direct, opaque, or user-controlled domain evidence when matched.
   *
   * Inputs: A call-expression AST node and active lexical scope.
   * Outputs: True when this method consumed the call as an environment operation; false for ordinary traversal. A supported `.get(key)` delegates key classification to `describeKey`, so it can emit an exact direct read, a finite/pattern dynamic domain, opaque uncertainty, or a user-controlled dynamic domain; supported enumeration/forwarding calls emit opaque uncertainty.
   * Does not handle: Arbitrary accessor methods, API type checking, the runtime result of a call, or validating/redacting raw `KeyDomain` text. Raw key/pattern text remains in backend observations until the injected fact builder materializes it.
   * Side effects: Emits raw direct/dynamic observations and visits relevant argument AST nodes on a recognized form.
   */
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

  /**
   * Identifies supported Object enumeration or assign and environment conversion call shapes that consume a recognized environment object.
   *
   * Inputs: A call-expression AST node and active scope.
   * Outputs: True for unshadowed `Object.keys|values|entries|assign` and environment `.toObject()` patterns.
   * Does not handle: Semantically equivalent user helpers, import aliases, or validating call arguments beyond environment recognition.
   * Side effects: Reads AST/scope data and tests arguments with `.some`; it emits nothing itself.
   */
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
      node.arguments.some(/**
 * Checks whether one Object assign argument is the environment object that makes the call an opaque forwarding operation.
 *
 * Inputs: One call-argument AST expression.
 * Outputs: Whether the current scope recognizes it as an environment object.
 * Does not handle: Visiting the argument or reporting uncertainty.
 * Side effects: Reads closed-over scope/AST through `isEnvironmentObject` during `.some`.
 */
(argument) => this.isEnvironmentObject(argument, scope))
    ) {
      return true;
    }
    return callee.name.text === "toObject" && this.isEnvironmentObject(callee.expression, scope);
  }

  /**
   * Produces a direct literal key domain for named-property reads on a recognized environment object.
   *
   * Inputs: A property-access AST node and active scope.
   * Outputs: A one-key lexical literal domain, or undefined when the receiver is not an environment object.
   * Does not handle: Computed properties, optional runtime availability, evaluation of the read, or validating/redacting the raw key. The returned `KeyDomain` remains raw until the injected fact builder handles it.
   * Side effects: Reads AST/scope and allocates a raw domain only for recognized receivers.
   */
   private environmentPropertyDomain(
    node: ts.PropertyAccessExpression,
    scope: LexicalScope,
  ): KeyDomain | undefined {
    return this.isEnvironmentObject(node.expression, scope)
      ? this.finite([node.name.text], "lexical", true, "literal")
      : undefined;
  }

  /**
   * Produces a key domain for `env[expression]`, using opaque uncertainty for a missing index.
   *
   * Inputs: An element-access AST node and active scope.
   * Outputs: The described index domain, opaque unbounded domain for no index, or undefined for another receiver. The description can be a direct finite key, finite/pattern dynamic domain, opaque uncertainty, or user-controlled uncertainty.
   * Does not handle: Evaluating the index, resolving aliases not represented by the lexical scope, or validating/redacting raw key/pattern text. The `KeyDomain` remains raw until the injected fact builder materializes it.
   * Side effects: Reads AST/scope and may allocate a raw uncertainty/domain object.
   */
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

  /**
   * Recognizes unshadowed process Bun Deno and import-meta environment forms plus const aliases classified as environment objects.
   *
   * Inputs: An expression AST node and its lexical scope.
   * Outputs: Whether the expression denotes a supported environment-object form.
   * Does not handle: Imported/shadowed runtime globals, object shape checks, or arbitrary environment wrappers.
   * Side effects: Reads AST structure and lexical binding maps without mutation.
   */
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

  /**
   * Derives the most precise safe key domain available from literals, aliases, branches, concatenation, maps, or user-controlled expressions.
   *
   * Inputs: A key-expression AST node, active scope, and recursive depth.
   * Outputs: A finite/pattern domain containing the backend's raw supported key text when statically supported, otherwise conservative unbounded uncertainty. The downstream fact builder, not this method, validates/redacts that raw domain before reportable facts are created.
   * Does not handle: Type evaluation, execution, unbounded recursion beyond depth 32, arbitrary constant propagation, or redacting/validating its raw supported-domain text.
   * Side effects: Recurses through AST/scope, allocates domains, and may construct temporary map/domain collections.
   */
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

  /**
   * Constant-folds a template when every substitution is finite; otherwise preserves only provably fixed prefix/suffix segments.
   *
   * Inputs: A template-expression AST node, active scope, and recursion depth.
   * Outputs: A finite constant-folded domain, a fixed-segment pattern, or unbounded uncertainty.
   * Does not handle: Evaluating template substitutions, preserving a pattern with no fixed segment, or expanding an over-budget product.
   * Side effects: Maps/iterates substitution domains, allocates key arrays, and calls domain combinators.
   */
   private describeTemplate(
    node: ts.TemplateExpression,
    scope: LexicalScope,
    depth: number,
  ): KeyDomain {
    const domains = node.templateSpans.map(/**
 * Describes one template substitution expression under the next recursion depth.
 *
 * Inputs: One TypeScript template span.
 * Outputs: Its `KeyDomain` from `describeKey`.
 * Does not handle: Appending the span's literal text; the enclosing template fold does that.
 * Side effects: Reads the span expression and recurses into AST/scope during `.map`.
 */
(span) =>
      this.describeKey(span.expression, scope, depth + 1),
    );
    if (domains.every(/**
 * Checks whether one substitution domain is finite before the enclosing code performs Cartesian template expansion.
 *
 * Inputs: One previously described substitution domain.
 * Outputs: True exactly for the finite variant.
 * Does not handle: Cap enforcement or origin merging.
 * Side effects: Performs a discriminant check during `.every`.
 */
(domain) => domain.kind === "finite")) {
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
        keys = combined.map(/**
 * Appends the following literal template fragment to one combined finite key candidate.
 *
 * Inputs: One key from the just-combined finite set.
 * Outputs: That key concatenated with the current span's literal text.
 * Does not handle: Deduplication or cap enforcement, which occurred in `combineKeySets`.
 * Side effects: Reads the closed-over span and allocates a concatenated string during `.map`.
 */
(key) => key + span.literal.text);
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

  /**
   * Collects the template head and consecutive direct one-key substitutions that are provably fixed at the leading edge.
   *
   * Inputs: A template AST node and its already-described substitution domains.
   * Outputs: The longest supported fixed prefix string, possibly empty.
   * Does not handle: Branch aliases/non-direct finite domains or any fixed text after the first uncertain substitution.
   * Side effects: Reads template span text and concatenates local strings.
   */
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

  /**
   * Collects the final literal and consecutive direct one-key substitutions that are provably fixed at the trailing edge.
   *
   * Inputs: A template AST node and its substitution domains.
   * Outputs: The longest supported fixed suffix string, possibly empty.
   * Does not handle: Non-direct/branch domains or fixed text before the first uncertain substitution from the right.
   * Side effects: Reads literal/span text and concatenates local strings.
   */
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

  /**
   * Resolves an object-map lookup to a selected finite domain when indexed statically, otherwise unions all map values conservatively.
   *
   * Inputs: An element-access expression, active scope, and recursive depth.
   * Outputs: A selected/unioned domain or user-controlled/opaque uncertainty when the map/index cannot be proven.
   * Does not handle: Dynamic property evaluation, map mutation, or maps whose values are not finite.
   * Side effects: Reads AST/scope, may spread map values into an array, and invokes domain combinators.
   */
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

  /**
   * Produces a lookup map for object literals (or their const aliases) only when every property name is static, unique, and finite.
   *
   * Inputs: A candidate expression, active scope, and recursion depth.
   * Outputs: A map of property names to finite domains for an object literal or a resolved `map` alias, or undefined for unresolved/non-map aliases, nonliterals, invalid properties, or depth exhaustion.
   * Does not handle: Aliases other than an already-resolved `map` binding, spread/method/accessor properties, runtime mutation, or map values outside finite domains.
   * Side effects: Reads AST/scope and allocates/mutates a local `Map` while building it.
   */
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

  /**
   * Unions finite values of a dynamically selected map while retaining whether the selector was user-controlled or opaque.
   *
   * Inputs: Map value domains and the origin attributed to an unknown selector.
   * Outputs: A non-direct constant-folded finite domain when all values are finite/in-cap, otherwise unbounded uncertainty.
   * Does not handle: Selecting a single map entry, preserving duplicate entries, or accepting an empty map.
   * Side effects: Uses `.some`, accumulates key strings in a local array, and delegates cap/deduplication to `finite`.
   */
   private unionMapValues(
    values: readonly KeyDomain[],
    selectorOrigin: RawDynamicOrigin,
  ): KeyDomain {
    if (values.length === 0 || values.some(/**
 * Detects a non-finite map value that makes an unknown map selection unbounded.
 *
 * Inputs: One key domain from the candidate map values.
 * Outputs: True when it is not finite.
 * Does not handle: Selecting or merging values.
 * Side effects: Performs a discriminant check during `.some`.
 */
(value) => value.kind !== "finite")) {
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

  /**
   * Combines two conditional key domains, retaining finite keys or structurally equal patterns and otherwise widening conservatively.
   *
   * Inputs: The domains of a conditional expression's true and false branches.
   * Outputs: A combined finite/pattern domain or unbounded domain that preserves over-budget and dominant origin information.
   * Does not handle: Evaluating the condition, correlating branch reachability, or unioning unequal patterns.
   * Side effects: Allocates arrays/domain records and may call `finite` or structural pattern comparison.
   */
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

  /**
   * Concatenates two key domains, preserving bounded products and fixed segments where their shape remains representable.
   *
   * Inputs: Domains for the left and right operands of `+`.
   * Outputs: A finite domain, prefix/suffix/surrounded pattern, or conservative unbounded domain.
   * Does not handle: Runtime coercion semantics, empty fixed segments as meaningful patterns, or products beyond the cap.
   * Side effects: Calls set/pattern combinators and allocates output domain objects.
   */
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

  /**
   * Prepends one nonempty finite literal to a dynamic pattern and selects the equivalent representable pattern shape.
   *
   * Inputs: A pattern domain, fixed prefix string, and merged dynamic origin.
   * Outputs: A new prefix or surrounded pattern domain preserving the old fixed segments.
   * Does not handle: Validating the prefix's safety grammar or expanding potential values.
   * Side effects: Allocates a pattern/domain record.
   */
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

  /**
   * Appends one nonempty finite literal to a dynamic pattern and selects the equivalent representable pattern shape.
   *
   * Inputs: A pattern domain, fixed suffix string, and merged dynamic origin.
   * Outputs: A new suffix or surrounded pattern domain preserving the old fixed segments.
   * Does not handle: Validating suffix safety grammar or expanding potential values.
   * Side effects: Allocates a pattern/domain record.
   */
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

  /**
   * Recognizes parameter, request-property, CLI/stdin, and recursively derived expressions as user-controlled key sources.
   *
   * Inputs: An expression AST node and active lexical scope.
   * Outputs: Whether the scanner must treat the expression as user-controlled.
   * Does not handle: Taint analysis through assignments/calls, type-based request shapes, or arbitrary input APIs.
   * Side effects: Recurses through AST and uses `.some` over call arguments; it does not emit observations.
   */
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
        expression.arguments.some(/**
 * Checks whether any call argument derives from a user-controlled source.
 *
 * Inputs: One call-argument expression.
 * Outputs: The recursive `isUserControlled` result for that argument.
 * Does not handle: Tainting the call result separately from the enclosing rule.
 * Side effects: Reads closed-over scope and recurses during `.some`.
 */
(argument) => this.isUserControlled(argument, scope))
      );
    }
    return false;
  }

  /**
   * Deduplicates raw static keys and creates a finite domain only when the resulting set is nonempty and within the configured cap.
   *
   * Inputs: Candidate key strings, origin, directness, and extraction-resolution label.
   * Outputs: A finite domain or opaque/over-budget unbounded domain; directness survives only lexical origin.
   * Does not handle: Safety/redaction validation of key strings or sorting stable output order.
   * Side effects: Allocates a `Set` and deduplicated array.
   */
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

  /**
   * Emits one exact raw observation for a direct singleton finite domain; otherwise emits the domain as a dynamic observation.
   *
   * Inputs: A classified key domain and the AST node that supplied its source span.
   * Outputs: No value.
   * Does not handle: Materializing/redacting raw keys, resolving the fact graph, or emitting multiple exact reads for a finite set.
   * Side effects: Computes a location and calls `emit`, mutating scanner de-duplication/observation state.
   */
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

  /**
   * Suppresses duplicate observations at the same kind and source coordinates before retaining the first one.
   *
   * Inputs: One raw exact or dynamic observation.
   * Outputs: No value.
   * Does not handle: Semantic equivalence across different spans or conflict resolution between different observation kinds.
   * Side effects: Mutates `#emittedLocations` and, for a new identity, `#observations`.
   */
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

/**
 * Flattens identifier leaves from a binding pattern for scope declaration/classification.
 *
 * Inputs: An identifier, object-binding pattern, or array-binding pattern AST node.
 * Outputs: A newly allocated array of identifier text in traversal order.
 * Does not handle: Property-name aliases, omitted array slots, type binding patterns, or duplicate elimination.
 * Side effects: Recurses through AST elements and grows local arrays.
 */
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

/**
 * Detects a direct `export` or `default` modifier on a syntax node that can carry modifiers.
 *
 * Inputs: One TypeScript AST node.
 * Outputs: True when its modifier list includes export or default.
 * Does not handle: Named re-exports, export assignments, or semantic module analysis.
 * Side effects: Asks the Compiler API for modifiers and scans the returned list.
 */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some(
      /**
       * Tests one modifier for the two export-related syntax kinds recognized by this scanner.
       *
       * Inputs: One modifier node from the Compiler API list.
       * Outputs: True for `ExportKeyword` or `DefaultKeyword`.
       * Does not handle: Other modifier meanings or module-level export semantics.
       * Side effects: Reads `modifier.kind` during `.some`.
       */
(modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) ?? false
  );
}

/**
 * Strips nested transparent parenthesis and TypeScript type-assertion wrappers before syntax classification.
 *
 * Inputs: One expression AST node.
 * Outputs: The innermost non-parenthesized/non-assertion/non-null expression reference.
 * Does not handle: Evaluating expressions, removing runtime operators, or changing AST nodes.
 * Side effects: Reads AST wrapper fields in a loop; it does not allocate or mutate AST.
 */
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

/**
 * Recognizes a named runtime global only when an identifier spelling matches and lexical scopes do not shadow it.
 *
 * Inputs: An expression AST node, expected global name, and active scope.
 * Outputs: True for an unshadowed identifier of that exact name.
 * Does not handle: Imports, global declarations supplied by TypeScript libs, or semantic symbol resolution.
 * Side effects: Reads node text and lexical declaration sets.
 */
function isUnshadowedGlobal(
  node: ts.Expression,
  name: string,
  scope: LexicalScope,
): boolean {
  return ts.isIdentifier(node) && node.text === name && !scope.hasDeclaration(name);
}

/**
 * Recognizes exactly the TypeScript import-meta meta-property expression.
 *
 * Inputs: One expression AST node.
 * Outputs: True for an import-keyword meta-property named `meta`.
 * Does not handle: Import expressions, user objects named meta, or runtime module semantics.
 * Side effects: Reads AST token/name fields only.
 */
function isImportMeta(node: ts.Expression): boolean {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === "meta"
  );
}

/**
 * Recognizes common request-object property names as a conservative user-input convention.
 *
 * Inputs: A property-access AST node.
 * Outputs: True for `query`, `body`, `params`, `route`, or `webhook` property names.
 * Does not handle: Type checking the receiver, custom request APIs, or downstream properties.
 * Side effects: Reads the property name and searches a fixed literal list.
 */
function isRequestInputProperty(node: ts.PropertyAccessExpression): boolean {
  return ["query", "body", "params", "route", "webhook"].includes(node.name.text);
}

/**
 * Recognizes unshadowed Node/Bun/Deno argument access and Node standard input as user-controlled sources.
 *
 * Inputs: A property-access AST node and its lexical scope.
 * Outputs: True for supported `argv`, `args`, or `stdin` forms.
 * Does not handle: Other command-line libraries, stdin-derived aliases, or runtime availability.
 * Side effects: Reads AST/scope and invokes `isUnshadowedGlobal`.
 */
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

/**
 * Extracts an object property name only when the syntax is identifier/string/numeric or a statically literal computed expression.
 *
 * Inputs: One TypeScript property-name AST node.
 * Outputs: Its string spelling, or undefined for unsupported dynamic syntax.
 * Does not handle: Evaluating computed expressions or canonicalizing numeric text.
 * Side effects: Reads AST fields and may delegate to `staticElementIndex`.
 */
function staticPropertyName(node: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(node)) {
    return staticElementIndex(node.expression);
  }
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

/**
 * Extracts a string or numeric literal element index after peeling transparent TypeScript wrappers.
 *
 * Inputs: One element-index expression.
 * Outputs: Its literal text, or undefined for dynamic/nonliteral expressions.
 * Does not handle: Evaluating arbitrary expressions or parsing numeric values.
 * Side effects: Reads AST wrapper/literal fields; it does not mutate them.
 */
function staticElementIndex(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)
    ? expression.text
    : undefined;
}

/**
 * Marks a finite domain reused through an alias/map reference as constant-folded, leaving all other domain variants untouched.
 *
 * Inputs: One internal key domain.
 * Outputs: A shallow copied finite domain with `resolution: constant-folded`, or the original nonfinite domain reference.
 * Does not handle: Clearing `direct`, validating keys, or preserving object identity for finite domains.
 * Side effects: Allocates a finite-domain copy only.
 */
function referenceDomain(domain: KeyDomain): KeyDomain {
  return domain.kind === "finite"
    ? { ...domain, resolution: "constant-folded" }
    : domain;
}

/**
 * Constructs an unbounded domain and derives a default origin from its reason when no origin is provided.
 *
 * Inputs: An allowed unbounded reason and optional raw origin.
 * Outputs: A new unbounded domain whose default origin is user-controlled only for that reason, otherwise opaque.
 * Does not handle: Validating runtime input values or inferring a cause from syntax.
 * Side effects: Allocates one small domain object.
 */
function unbounded(
  reason: Extract<RawDynamicDomain, { readonly kind: "unbounded" }>["reason"],
  origin: RawDynamicOrigin = reason === "user-controlled" ? "user-controlled" : "opaque",
): KeyDomain {
  return { kind: "unbounded", reason, origin };
}

/**
 * Applies the origin dominance order user-controlled > opaque > lexical when combining evidence.
 *
 * Inputs: Two already-typed raw origin labels.
 * Outputs: The dominant origin label.
 * Does not handle: Explaining the source of dominance or retaining multiple origins.
 * Side effects: None; it uses fixed comparisons only.
 */
function mergeOrigins(left: RawDynamicOrigin, right: RawDynamicOrigin): RawDynamicOrigin {
  if (left === "user-controlled" || right === "user-controlled") {
    return "user-controlled";
  }
  if (left === "opaque" || right === "opaque") {
    return "opaque";
  }
  return "lexical";
}

/**
 * Builds a unique Cartesian concatenation only when both input sets and the resulting product fit the supplied cap.
 *
 * Inputs: Two finite key arrays and a maximum count.
 * Outputs: A unique concatenated key array or undefined for empty inputs or any pre/post-deduplication cap excess.
 * Does not handle: String safety filtering, stable sort order beyond nested iteration, or products with noninteger caps.
 * Side effects: Allocates/mutates a values array and deduplicating `Set`.
 */
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

/**
 * Compares raw prefix, suffix, and surrounded patterns by both kind and their fixed segment strings.
 *
 * Inputs: Two raw pattern variants.
 * Outputs: True only when both variants and all their represented fixed segments match.
 * Does not handle: Semantic equivalence between different pattern shapes or normalization of segment strings.
 * Side effects: Reads discriminants and string fields without allocation.
 */
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
 * Retrieves the optional parser-diagnostic list attached to a source file without accessing program diagnostics.
 *
 * Inputs: A TypeScript `SourceFile` produced by the syntax parser.
 * Outputs: Its `parseDiagnostics` array or a new empty array when that implementation detail is absent.
 * Does not handle: Semantic/declaration diagnostics, formatting diagnostics, or suppressing parse errors.
 * Side effects: Reads an optional Compiler API field and allocates the fallback empty array only.
 */
function parserDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
  return (
    source as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
}

/**
 * Maps the scanner's supported source-language tag to the matching TypeScript parser mode.
 *
 * Inputs: One compile-time `SourceLanguage` variant.
 * Outputs: The corresponding `ts.ScriptKind` enum member.
 * Does not handle: Unknown language values at runtime or language-specific compiler options.
 * Side effects: None; switches over the closed type union.
 */
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

/**
 * Converts an AST node's source span into zero-based start/end line and column coordinates.
 *
 * Inputs: The source file owning a node and the node to locate.
 * Outputs: A new raw location whose start excludes trivia according to `getStart` and whose end is `getEnd`.
 * Does not handle: Safe-path association, source-text retention, or malformed AST recovery.
 * Side effects: Calls Compiler API position methods and allocates location/position records.
 */
function locationFor(source: ts.SourceFile, node: ts.Node): RawSourceLocation {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character },
  };
}
