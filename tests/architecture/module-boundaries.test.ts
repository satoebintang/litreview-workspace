import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import fixture from "./fixtures/slice35-v034-api.json";
import { schema } from "@/db/schema";

const root = path.resolve(process.cwd());
const sourceRoot = path.join(root, "src");
const schemaFacade = path.join(sourceRoot, "db", "schema.ts");
const schemaDirectory = path.join(sourceRoot, "db", "schema");
const repositoriesFacade = path.join(sourceRoot, "application", "repositories.ts");
const repositoriesDirectory = path.join(sourceRoot, "application", "repositories");
const servicesFacade = path.join(sourceRoot, "application", "services.ts");
const reviewServicesDirectory = path.join(sourceRoot, "application", "review-services");
const actionsFacade = path.join(sourceRoot, "app", "actions.ts");
const actionsDirectory = path.join(sourceRoot, "app", "actions");
const actionHelpers = path.join(sourceRoot, "app", "action-helpers.ts");

let program: ts.Program;
let checker: ts.TypeChecker;
let compilerOptions: ts.CompilerOptions;

type ModuleEdge = {
  from: string;
  to: string;
  specifier: string;
  syntax: "import" | "export" | "dynamic-import" | "import-type";
  typeOnly: boolean;
};

function absolute(file: string): string {
  return path.resolve(root, file);
}

function normalized(file: string): string {
  return path.resolve(file).toLowerCase();
}

function isInside(file: string, directory: string): boolean {
  const relative = path.relative(normalized(directory), normalized(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameFile(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function sourceFile(file: string): ts.SourceFile {
  const result = program.getSourceFile(path.resolve(file));
  if (!result) throw new Error(`TypeScript program did not include ${file}`);
  return result;
}

function moduleSymbol(file: string): ts.Symbol {
  const source = sourceFile(file);
  const symbol = (source as ts.SourceFile & { symbol?: ts.Symbol }).symbol ?? checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`TypeScript module symbol was unavailable for ${file}`);
  return symbol;
}

function moduleExports(file: string): string[] {
  return checker.getExportsOfModule(moduleSymbol(file)).map((symbol) => symbol.getName()).sort();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
}

function hasUseServerDirective(source: ts.SourceFile): boolean {
  const firstStatement = source.statements[0];
  return !!firstStatement
    && ts.isExpressionStatement(firstStatement)
    && ts.isStringLiteral(firstStatement.expression)
    && firstStatement.expression.text === "use server";
}

function moduleEdges(): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const sourceFiles = program.getSourceFiles().filter((source) => isInside(source.fileName, sourceRoot));

  for (const source of sourceFiles) {
    const add = (
      specifier: string,
      syntax: ModuleEdge["syntax"],
      typeOnly: boolean,
    ) => {
      const resolved = ts.resolveModuleName(specifier, source.fileName, compilerOptions, ts.sys).resolvedModule;
      if (!resolved) return;
      edges.push({
        from: path.resolve(source.fileName),
        to: path.resolve(resolved.resolvedFileName),
        specifier,
        syntax,
        typeOnly,
      });
    };

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause;
        const typeOnly = !!clause?.isTypeOnly
          || (!!clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.length > 0
            && clause.namedBindings.elements.every((element) => element.isTypeOnly));
        add(node.moduleSpecifier.text, "import", typeOnly);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.exportClause;
        const typeOnly = node.isTypeOnly
          || (!!clause && ts.isNamedExports(clause)
            && clause.elements.length > 0
            && clause.elements.every((element) => element.isTypeOnly));
        add(node.moduleSpecifier.text, "export", typeOnly);
      } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])) {
        add(node.arguments[0].text, "dynamic-import", false);
      } else if (ts.isImportTypeNode(node)
        && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteralLike(node.argument.literal)) {
        add(node.argument.literal.text, "import-type", true);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }
  return edges;
}

function contextModules(): string[] {
  return program.getSourceFiles()
    .map((source) => path.resolve(source.fileName))
    .filter((file) => isInside(file, sourceRoot))
    .filter((file) => sameFile(file, schemaFacade)
      || isInside(file, schemaDirectory)
      || sameFile(file, repositoriesFacade)
      || isInside(file, repositoriesDirectory)
      || sameFile(file, servicesFacade)
      || isInside(file, reviewServicesDirectory)
      || sameFile(file, actionsFacade)
      || isInside(file, actionsDirectory)
      || sameFile(file, actionHelpers));
}

function stronglyConnectedComponents(nodes: string[], edges: ModuleEdge[]): string[][] {
  const nodeSet = new Set(nodes.map(normalized));
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(normalized(node), []);
  for (const edge of edges) {
    const from = normalized(edge.from);
    const to = normalized(edge.to);
    if (nodeSet.has(from) && nodeSet.has(to)) adjacency.get(from)?.push(to);
  }

  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (node: string) => {
    index.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!index.has(target)) {
        connect(target);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(target)!));
      }
    }

    if (lowLink.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);

    if (component.length > 1 || (adjacency.get(node) ?? []).includes(node)) components.push(component);
  };

  for (const node of adjacency.keys()) if (!index.has(node)) connect(node);
  return components.map((component) => component.map((file) => path.relative(root, file).replaceAll("\\", "/")));
}

function directFactoryObject(factory: ts.Node): ts.ObjectLiteralExpression {
  let body: ts.ConciseBody | ts.Block | undefined;
  if (ts.isFunctionDeclaration(factory) || ts.isMethodDeclaration(factory)) body = factory.body;
  else if (ts.isVariableDeclaration(factory) && factory.initializer
    && (ts.isArrowFunction(factory.initializer) || ts.isFunctionExpression(factory.initializer))) body = factory.initializer.body;

  if (!body) throw new Error(`Expected a function body for factory at ${factory.getSourceFile().fileName}`);
  if (!ts.isBlock(body)) {
    if (ts.isObjectLiteralExpression(body)) return body;
    throw new Error(`Expected an object-literal factory body at ${factory.getSourceFile().fileName}`);
  }

  const returned = body.statements.find((statement): statement is ts.ReturnStatement =>
    ts.isReturnStatement(statement) && !!statement.expression && ts.isObjectLiteralExpression(statement.expression));
  if (!returned?.expression || !ts.isObjectLiteralExpression(returned.expression)) {
    throw new Error(`Expected a direct returned object literal for ${factory.getSourceFile().fileName}`);
  }
  return returned.expression;
}

function factoryReturnExpression(factory: ts.Node): ts.Expression {
  let body: ts.ConciseBody | ts.Block | undefined;
  if (ts.isFunctionDeclaration(factory) || ts.isMethodDeclaration(factory)) body = factory.body;
  else if (ts.isVariableDeclaration(factory) && factory.initializer
    && (ts.isArrowFunction(factory.initializer) || ts.isFunctionExpression(factory.initializer))) body = factory.initializer.body;
  if (!body) throw new Error(`Expected a function body for factory at ${factory.getSourceFile().fileName}`);
  if (!ts.isBlock(body)) return body;
  const returned = [...body.statements].reverse().find((statement): statement is ts.ReturnStatement =>
    ts.isReturnStatement(statement) && !!statement.expression);
  if (!returned?.expression) throw new Error(`Expected a returned expression for ${factory.getSourceFile().fileName}`);
  return returned.expression;
}

function factoryObjectKeys(factory: ts.Node): string[] {
  const appendUnique = (target: string[], additions: string[]) => {
    for (const key of additions) if (!target.includes(key)) target.push(key);
  };
  const keysFrom = (input: ts.Expression, seen: Set<ts.Symbol>, trail: string[]): string[] => {
    const expression = unwrapExpression(input);
    if (ts.isObjectLiteralExpression(expression)) {
      const keys: string[] = [];
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          appendUnique(keys, keysFrom(property.expression, seen, trail));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          appendUnique(keys, [property.name.text]);
        } else if ((ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)
          || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property))
          && property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))) {
          appendUnique(keys, [property.name.text]);
        } else {
          throw new Error(`Unexpected service object member ${property.getText(expression.getSourceFile())}`);
        }
      }
      return keys;
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Object"
      && expression.expression.name.text === "assign") {
      const keys: string[] = [];
      for (const argument of expression.arguments) appendUnique(keys, keysFrom(argument, seen, trail));
      return keys;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (!symbol || seen.has(symbol)) throw new Error(`Could not resolve service object ${expression.text}`);
      seen.add(symbol);
      const declaration = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol).valueDeclaration : symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration)) {
        throw new Error(`Expected ${expression.text} to refer to a service object initializer`);
      }
      if (!declaration.initializer || declaration.initializer.kind === ts.SyntaxKind.NullKeyword) {
        const nonNullableType = checker.getNonNullableType(checker.getTypeAtLocation(expression));
        const typedKeys = checker.getPropertiesOfType(nonNullableType).map((property) => property.getName());
        if (typedKeys.length) return typedKeys;
      }
      if (!declaration.initializer) throw new Error(`Expected ${expression.text} to have a service object initializer`);
      return keysFrom(declaration.initializer, seen, [...trail, expression.text]);
    }
    throw new Error(`Unsupported service factory return expression ${expression.getText(expression.getSourceFile())} via ${trail.join(" -> ") || factory.getSourceFile().fileName}`);
  };
  return keysFrom(factoryReturnExpression(factory), new Set(), []);
}

function objectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties.map((property) => {
    if (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property) || ts.isGetAccessorDeclaration(property)) {
      if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))) {
        return property.name.text;
      }
    }
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    throw new Error(`Unexpected service object member ${property.getText(object.getSourceFile())}`);
  });
}

function normalizeExpression(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ").trim();
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function objectAssignArguments(expression: ts.Expression | undefined, source: ts.SourceFile): string[] {
  if (!expression) throw new Error(`Missing initializer in ${source.fileName}`);
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)
    || value.expression.expression.getText(source) !== "Object"
    || value.expression.name.text !== "assign") {
    throw new Error(`Expected Object.assign in ${source.fileName}: ${value.getText(source)}`);
  }
  return value.arguments.map((argument) => normalizeExpression(argument, source));
}

function findVariableDeclaration(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) result = node;
    if (!result) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!result) throw new Error(`Could not find ${name} in ${source.fileName}`);
  return result;
}

function findFunctionDeclaration(file: string, name: string): ts.FunctionDeclaration {
  const source = sourceFile(file);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declaration) throw new Error(`Could not find function ${name} in ${file}`);
  return declaration;
}

function findFactoryDeclaration(files: string[], name: string): ts.Node | undefined {
  for (const file of files) {
    const source = sourceFile(file);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name
        && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return statement;
      if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      const declaration = statement.declarationList.declarations.find((candidate) => ts.isIdentifier(candidate.name)
        && candidate.name.text === name && !!candidate.initializer
        && (ts.isArrowFunction(candidate.initializer) || ts.isFunctionExpression(candidate.initializer)));
      if (declaration) return declaration;
    }
  }
  return undefined;
}

function factoryDeclarationFromCall(call: ts.CallExpression): ts.Node {
  const symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol) throw new Error(`Could not resolve factory ${call.expression.getText(call.getSourceFile())}`);
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = target.declarations?.find((candidate) => ts.isFunctionDeclaration(candidate)
    || (ts.isVariableDeclaration(candidate) && !!candidate.initializer
      && (ts.isArrowFunction(candidate.initializer) || ts.isFunctionExpression(candidate.initializer))));
  if (!declaration) throw new Error(`Resolved factory ${target.getName()} had no function declaration`);
  return declaration;
}

function firstCallExpression(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node)) return node;
  let result: ts.CallExpression | undefined;
  ts.forEachChild(node, (child) => {
    if (!result) result = firstCallExpression(child);
  });
  return result;
}

function functionSignature(declaration: ts.FunctionLikeDeclaration): string {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) throw new Error(`Could not read signature for ${declaration.getText(declaration.getSourceFile())}`);
  const parameters = signature.getParameters().map((symbol, index) => {
    const parameterNode = declaration.parameters[index];
    const type = checker.getTypeOfSymbolAtLocation(symbol, parameterNode ?? declaration);
    const rest = !!parameterNode?.dotDotDotToken;
    const optional = !!(symbol.flags & ts.SymbolFlags.Optional);
    const renderedType = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
    return `${rest ? "..." : ""}${symbol.getName()}${optional ? "?" : ""}: ${renderedType}`;
  });
  const result = checker.getReturnTypeOfSignature(signature);
  return `(${parameters.join(", ")}) => ${checker.typeToString(result, declaration, ts.TypeFormatFlags.NoTruncation)}`;
}

function normalizedParameterType(type: string): string {
  return type.replace(/;\s*}/g, " }").replace(/\s+/g, " ").trim();
}

function parameterContract(declaration: ts.FunctionLikeDeclaration): Array<{
  name: string;
  optional: boolean;
  rest: boolean;
  type: string;
}> {
  const source = declaration.getSourceFile();
  return declaration.parameters.map((parameter) => ({
    name: parameter.name.getText(source),
    optional: !!parameter.questionToken || !!parameter.initializer,
    rest: !!parameter.dotDotDotToken,
    type: normalizedParameterType(parameter.type
      ? parameter.type.getText(source)
      : checker.typeToString(checker.getTypeAtLocation(parameter), declaration, ts.TypeFormatFlags.NoTruncation)),
  }));
}

function expectedParameterContract(signature: string): Array<{
  name: string;
  optional: boolean;
  rest: boolean;
  type: string;
}> {
  const source = ts.createSourceFile(
    "expected-service-signature.ts",
    `type Expected = ${signature};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements[0];
  if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isFunctionTypeNode(declaration.type)) {
    throw new Error(`Invalid service signature manifest entry: ${signature}`);
  }
  return declaration.type.parameters.map((parameter) => ({
    name: parameter.name.getText(source),
    optional: !!parameter.questionToken,
    rest: !!parameter.dotDotDotToken,
    type: normalizedParameterType(parameter.type?.getText(source) ?? "<infer>"),
  }));
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(absolute(file))).digest("hex");
}

beforeAll(() => {
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  compilerOptions = parsed.options;
  program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  checker = program.getTypeChecker();
});

describe("bounded-context module boundaries", () => {
  it("keeps the schema façade exports and canonical schema key order", () => {
    expect(moduleExports(schemaFacade)).toEqual([...fixture.schema.exports].sort());
    expect(Object.keys(schema)).toEqual(fixture.schema.keys);
    expect(fixture.schema.exports).toHaveLength(113);
    expect(fixture.schema.keys).toHaveLength(112);
  });

  it("keeps all 22 repository classes on the compatibility barrel", () => {
    expect(moduleExports(repositoriesFacade)).toEqual([...fixture.repositories.exports].sort());
    const repositoryClasses = program.getSourceFiles()
      .filter((source) => isInside(source.fileName, repositoriesDirectory))
      .flatMap((source) => source.statements.filter((statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && !!statement.name && hasModifier(statement, ts.SyntaxKind.ExportKeyword))
        .map((declaration) => declaration.name!.text))
      .sort();
    expect(repositoryClasses).toEqual([...fixture.repositories.classes].sort());
    expect(fixture.repositories.exports).toHaveLength(22);
    expect(fixture.repositories.classes).toHaveLength(22);
  });

  it("keeps the services root exports and the exact core service API manifest", () => {
    expect(moduleExports(servicesFacade)).toEqual([...fixture.services.exports].sort());
    expect(fixture.services.coreMethods).toHaveLength(67);
  });

  it("keeps the 137 action signatures and async forwarding façade frozen", () => {
    const facade = sourceFile(actionsFacade);
    expect(hasUseServerDirective(facade)).toBe(true);
    const exportedStatements = facade.statements.filter((statement) => hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement));
    expect(exportedStatements).toHaveLength(137);
    expect(exportedStatements.every((statement) => ts.isFunctionDeclaration(statement)
      && hasModifier(statement, ts.SyntaxKind.AsyncKeyword))).toBe(true);

    const namespaceImports = new Map<string, string>();
    for (const statement of facade.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaceImports.set(bindings.name.text, statement.moduleSpecifier.text);
    }

    const wrappers = new Map(facade.statements
      .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.name)
      .map((declaration) => [declaration.name!.text, declaration]));
    expect([...wrappers.keys()].sort()).toEqual([...fixture.actions.exports].sort());
    expect(wrappers.size).toBe(137);

    const implementationModules = new Set<string>();
    const implementationExports: string[] = [];
    const implementations = new Map<string, ts.FunctionDeclaration>();
    for (const [, specifier] of namespaceImports) {
      const resolved = ts.resolveModuleName(specifier, facade.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      expect(resolved, `Could not resolve action module ${specifier}`).toBeTruthy();
      const implementation = sourceFile(resolved!);
      expect(isInside(implementation.fileName, actionsDirectory)).toBe(true);
      expect(hasUseServerDirective(implementation)).toBe(true);
      implementationModules.add(path.resolve(implementation.fileName));

      const exportedFunctions = implementation.statements.filter((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword));
      const otherExports = implementation.statements.filter((statement) =>
        (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))
        || (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !ts.isFunctionDeclaration(statement)));
      expect(otherExports, `Unexpected runtime export in ${implementation.fileName}`).toEqual([]);
      for (const declaration of exportedFunctions) {
        expect(hasModifier(declaration, ts.SyntaxKind.AsyncKeyword), declaration.name?.text).toBe(true);
        implementationExports.push(declaration.name!.text);
        implementations.set(declaration.name!.text, declaration);
      }

    }
    expect(implementationModules.size).toBe(16);
    expect(implementationExports.sort()).toEqual([...fixture.actions.exports].sort());

    for (const expected of fixture.actions.functions) {
      const wrapper = wrappers.get(expected.name);
      const implementation = implementations.get(expected.name);
      expect(wrapper, `Missing façade wrapper ${expected.name}`).toBeDefined();
      expect(implementation, `Missing implementation ${expected.name}`).toBeDefined();
      expect(hasModifier(wrapper!, ts.SyntaxKind.AsyncKeyword), expected.name).toBe(true);
      expect(functionSignature(implementation!)).toBe(expected.signature);

      const wrapperType = checker.getTypeAtLocation(wrapper!.name!);
      const implementationType = checker.getTypeAtLocation(implementation!.name!);
      expect(checker.isTypeAssignableTo(wrapperType, implementationType), `${expected.name} wrapper accepts extra or different inputs`).toBe(true);
      expect(checker.isTypeAssignableTo(implementationType, wrapperType), `${expected.name} wrapper changes its return or input contract`).toBe(true);
      expect(wrapper!.parameters.map((parameter) => parameter.name.getText(facade)))
        .toEqual(implementation!.parameters.map((parameter) => parameter.name.getText(implementation!.getSourceFile())));
      expect(wrapper!.parameters).toHaveLength(implementation!.parameters.length);

      const statements = wrapper!.body?.statements ?? [];
      expect(statements).toHaveLength(1);
      expect(ts.isReturnStatement(statements[0])).toBe(true);
      const returned = (statements[0] as ts.ReturnStatement).expression;
      expect(returned && ts.isCallExpression(returned)).toBe(true);
      if (!returned || !ts.isCallExpression(returned) || !ts.isPropertyAccessExpression(returned.expression)) continue;
      const namespace = returned.expression.expression;
      expect(ts.isIdentifier(namespace)).toBe(true);
      expect(returned.expression.name.text).toBe(expected.name);
      expect(returned.arguments.map((argument) => argument.getText(facade)))
        .toEqual(wrapper!.parameters.map((parameter) => parameter.name.getText(facade)));
      const specifier = namespaceImports.get(namespace.getText(facade));
      expect(specifier).toBeDefined();
      const resolved = ts.resolveModuleName(specifier!, facade.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      expect(resolved && sameFile(resolved, implementation!.getSourceFile().fileName)).toBe(true);
    }
  });

  it("keeps the shared action helpers outside use-server modules", () => {
    const helpers = sourceFile(actionHelpers);
    expect(hasUseServerDirective(helpers)).toBe(false);
  });

  it("resolves architecture imports with tsconfig aliases and reports no context cycles", () => {
    const edges = moduleEdges();
    const contexts = contextModules();
    expect(stronglyConnectedComponents(contexts, edges)).toEqual([]);

    const unresolvedModules = program.getSourceFiles()
      .filter((source) => isInside(source.fileName, sourceRoot))
      .flatMap((source) => {
        const unresolved: string[] = [];
        const visit = (node: ts.Node) => {
          const specifier = ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
              ? node.moduleSpecifier.text
              : undefined;
          const isStaticAsset = !!specifier && /\.(css|scss|sass|less|svg|png|jpe?g|webp|avif|ico)$/i.test(specifier);
          if (specifier && !isStaticAsset && (specifier.startsWith("@/") || specifier.startsWith("."))
            && !ts.resolveModuleName(specifier, source.fileName, compilerOptions, ts.sys).resolvedModule) unresolved.push(`${source.fileName}: ${specifier}`);
          ts.forEachChild(node, visit);
        };
        visit(source);
        return unresolved;
      });
    expect(unresolvedModules).toEqual([]);

    const rootSchemaImports = edges.filter((edge) => isInside(edge.from, schemaDirectory) && sameFile(edge.to, schemaFacade));
    expect(rootSchemaImports).toEqual([]);
    expect(stronglyConnectedComponents(contexts.filter((file) => isInside(file, schemaDirectory) || sameFile(file, schemaFacade)), edges)).toEqual([]);
  });

  it("prevents dependencies from crossing upward into services, actions, or UI modules", () => {
    const edges = moduleEdges();
    const violations = edges.filter((edge) => {
      const fromDb = isInside(edge.from, path.join(sourceRoot, "db"));
      const fromRepository = sameFile(edge.from, repositoriesFacade) || isInside(edge.from, repositoriesDirectory);
      const fromReviewService = sameFile(edge.from, servicesFacade) || isInside(edge.from, reviewServicesDirectory);
      const fromActionImplementation = isInside(edge.from, actionsDirectory);
      const toApplication = isInside(edge.to, path.join(sourceRoot, "application"));
      const toApp = isInside(edge.to, path.join(sourceRoot, "app"));
      const isUiModule = toApp && (path.basename(edge.to).match(/^(page|layout|template|default|loading|error|not-found|global-error)\./) !== null
        || path.relative(path.join(sourceRoot, "app"), edge.to).split(path.sep).some((part) => part === "components" || part === "_components"));

      return (fromDb && (toApplication || toApp))
        || (fromRepository && (toApp || isInside(edge.to, reviewServicesDirectory) || sameFile(edge.to, servicesFacade)))
        || (fromReviewService && toApp)
        || (fromActionImplementation && sameFile(edge.to, actionsFacade))
        || (isInside(edge.from, actionsDirectory) && isUiModule);
    });
    expect(violations.map((edge) => `${path.relative(root, edge.from)} -> ${edge.specifier}`)).toEqual([]);
  });

  it("preserves configuration bytes", () => {
    for (const manifest of fixture.configHashes) expect(sha256(manifest.file), manifest.file).toBe(manifest.sha256);
  });

  it.skipIf(!existsSync(reviewServicesDirectory))("preserves review-service ownership, composition order, collisions, and core signatures", () => {
    const services = sourceFile(servicesFacade);
    const createReviewServices = findFunctionDeclaration(servicesFacade, "createReviewServices");
    const coreVariables = fixture.services.coreFactories.map(({ factory }) => factory.replace(/^create/, "").replace(/^./, (letter) => letter.toLowerCase()));
    const coreKeysByOwner = new Map<string, string[]>();
    const methodDeclarations = new Map<string, ts.FunctionLikeDeclaration>();

    for (const factory of fixture.services.coreFactories) {
      const candidates = readdirSync(reviewServicesDirectory)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(reviewServicesDirectory, file));
      const declaration = findFactoryDeclaration(candidates, factory.factory);
      expect(declaration, `Missing core factory ${factory.factory}`).toBeDefined();
      const object = directFactoryObject(declaration!);
      expect(objectKeys(object)).toEqual(factory.keys);
      coreKeysByOwner.set(factory.factory, factory.keys);
      for (const property of object.properties) {
        if ((ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) && property.name
          && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
          const fn = ts.isMethodDeclaration(property) ? property
            : property.initializer && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
              ? property.initializer : undefined;
          if (fn) methodDeclarations.set(property.name.text, fn);
        }
      }
    }

    const coreMethodNames = [...coreKeysByOwner.values()].flat();
    expect(coreMethodNames).toHaveLength(67);
    expect(new Set(coreMethodNames).size).toBe(67);
    expect([...methodDeclarations.keys()].sort()).toEqual(fixture.services.coreMethods.map(({ name }) => name).sort());
    for (const expected of fixture.services.coreMethods) {
      const declaration = methodDeclarations.get(expected.name);
      expect(declaration, `Missing core method ${expected.name}`).toBeDefined();
      expect(parameterContract(declaration!), expected.name).toEqual(expectedParameterContract(expected.signature));
    }

    const coreServices = findVariableDeclaration(services, "services");
    const coreArguments = objectAssignArguments(coreServices.initializer, services);
    expect(coreArguments[0]).toBe("{}");
    expect(coreArguments.slice(1)).toEqual(coreVariables);

    const baseServices = findVariableDeclaration(services, "baseServices");
    expect(objectAssignArguments(baseServices.initializer, services)).toEqual(fixture.services.composition.base);

    const finalReturn = createReviewServices.body?.statements.find((statement): statement is ts.ReturnStatement =>
      ts.isReturnStatement(statement) && !!statement.expression && ts.isCallExpression(unwrapExpression(statement.expression)));
    expect(finalReturn?.expression).toBeDefined();
    expect(objectAssignArguments(finalReturn?.expression, services)).toEqual(fixture.services.composition.final);

    const factoryKeys = new Map<string, string[]>(coreKeysByOwner);
    for (const factory of fixture.services.specializedFactories) {
      const variable = findVariableDeclaration(services, factory.source);
      const call = variable.initializer && firstCallExpression(variable.initializer);
      expect(call, `Expected ${factory.source} to be initialized from a service factory`).toBeDefined();
      if (!call) continue;
      const declaration = factoryDeclarationFromCall(call);
      factoryKeys.set(factory.source, factoryObjectKeys(declaration));
      expect(factoryKeys.get(factory.source)).toEqual(factory.keys);
    }

    const layers = [
      ...fixture.services.coreFactories.map((factory) => ({ owner: factory.factory, keys: factoryKeys.get(factory.factory)! })),
      ...fixture.services.composition.base.slice(1).map((expression) => {
        const owner = expression.replace(/\s+as\s+unknown\s+as\s+Record<.*$/, "");
        return { owner, keys: factoryKeys.get(owner)! };
      }),
      ...fixture.services.composition.final.slice(1).map((expression) => {
        const match = expression.match(/([A-Za-z_$][\w$]*)/g);
        const owner = expression.startsWith("...") ? match?.[1] : expression;
        if (!owner) throw new Error(`Could not identify composition owner from ${expression}`);
        return { owner, keys: factoryKeys.get(owner)! };
      }),
    ];
    const owners = new Map<string, string>();
    const collisions: Array<{ key: string; earlier: string; later: string; winner: string; intentional: true }> = [];
    for (const layer of layers) {
      expect(layer.keys, `No key manifest for ${layer.owner}`).toBeDefined();
      for (const key of layer.keys) {
        const earlier = owners.get(key);
        if (earlier) collisions.push({ key, earlier, later: layer.owner, winner: layer.owner, intentional: true });
        owners.set(key, layer.owner);
      }
    }
    expect(collisions).toEqual(fixture.services.baselineCollisions);

    const thisSites: Array<{ owner: string; callee: string }> = [];
    const scanThisCalls = (node: ts.Node, owner?: string) => {
      const nextOwner = (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name
        ? node.name.getText(node.getSourceFile()) : owner;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        thisSites.push({ owner: nextOwner ?? "<unknown>", callee: node.expression.name.text });
      }
      ts.forEachChild(node, (child) => scanThisCalls(child, nextOwner));
    };
    for (const file of readdirSync(reviewServicesDirectory).filter((entry) => entry.endsWith(".ts"))) {
      scanThisCalls(sourceFile(path.join(reviewServicesDirectory, file)));
    }
    const expectedThisSites = fixture.services.thisCalls.map(({ owner, callee }) => ({ owner, callee }));
    const sortSite = (site: { owner: string; callee: string }) => `${site.owner}.${site.callee}`;
    expect(thisSites.map(sortSite).sort()).toEqual(expectedThisSites.map(sortSite).sort());
  });
});
