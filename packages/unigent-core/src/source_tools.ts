import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import type { JsonSchema } from "./backend.js";
import { AgentConfigError } from "./errors.js";
import { compileJsonSchemaValidator } from "./json_schema_validator.js";
import type { CompiledTool, SourceToolFunction } from "./tool.js";

type TypeScriptApi = typeof import("typescript");

let loadedTypeScript: TypeScriptApi | undefined;

function loadTypeScript(): TypeScriptApi {
  if (loadedTypeScript !== undefined) {
    return loadedTypeScript;
  }
  try {
    loadedTypeScript = createRequire(import.meta.url)("typescript") as TypeScriptApi;
    return loadedTypeScript;
  } catch (error) {
    throw new AgentConfigError(
      "source tool reflection requires the optional typescript peer; install typescript or run `unigent bake <entry>` during the build",
      { cause: error },
    );
  }
}

function typeScript(): TypeScriptApi {
  return loadTypeScript();
}

interface FunctionMetadata {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameterNames: readonly string[];
  readonly parameters: JsonSchema;
  readonly checkpointKey: string;
}

interface SourceToolManifest {
  readonly version: 1;
  readonly source: string;
  readonly tools: readonly FunctionMetadata[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

function parseFunctionMetadata(value: unknown): FunctionMetadata | undefined {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["description"] !== "string" ||
    !isStringArray(value["parameterNames"]) ||
    !isJsonSchema(value["parameters"]) ||
    typeof value["checkpointKey"] !== "string" ||
    (value["promptSnippet"] !== undefined && typeof value["promptSnippet"] !== "string") ||
    (value["promptGuidelines"] !== undefined && !isStringArray(value["promptGuidelines"]))
  ) {
    return;
  }
  return {
    name: value["name"],
    description: value["description"],
    parameterNames: value["parameterNames"],
    parameters: value["parameters"],
    checkpointKey: value["checkpointKey"],
    ...(value["promptSnippet"] === undefined ? {} : { promptSnippet: value["promptSnippet"] }),
    ...(value["promptGuidelines"] === undefined
      ? {}
      : { promptGuidelines: value["promptGuidelines"] }),
  };
}

function parseManifest(value: unknown, path: string): SourceToolManifest {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["source"] !== "string" ||
    !Array.isArray(value["tools"])
  ) {
    throw new AgentConfigError(`invalid source tool manifest: ${path}`);
  }
  const tools = value["tools"].map(parseFunctionMetadata);
  if (tools.some((tool) => tool === undefined)) {
    throw new AgentConfigError(`invalid source tool manifest: ${path}`);
  }
  return {
    version: 1,
    source: value["source"],
    tools: tools.filter((tool): tool is FunctionMetadata => tool !== undefined),
  };
}

function manifestPath(anchorPath: string): string {
  const extension = extname(anchorPath);
  return join(dirname(anchorPath), `${basename(anchorPath, extension)}.unigent-tools.json`);
}

function readManifest(source: string): SourceToolManifest | undefined {
  const path = manifestPath(sourcePath(source));
  if (!existsSync(path)) {
    return;
  }
  try {
    return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      throw error;
    }
    throw new AgentConfigError(`unable to read source tool manifest: ${path}`, { cause: error });
  }
}

function objectTypeSchema(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  seen: Set<TypeScript.Type>,
): JsonSchema {
  if (seen.has(type)) {
    throw new AgentConfigError("recursive source tool parameter types are unsupported");
  }
  seen.add(type);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined) {
      continue;
    }
    properties[property.name] = typeSchema(
      checker,
      checker.getTypeOfSymbolAtLocation(property, declaration),
      seen,
    );
    if ((property.flags & typeScript().SymbolFlags.Optional) === 0) {
      required.push(property.name);
    }
  }
  seen.delete(type);
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
  };
}

function typeSchema(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  seen: Set<TypeScript.Type>,
): JsonSchema {
  if (type.isStringLiteral()) {
    return { type: "string", const: type.value };
  }
  if (type.isNumberLiteral()) {
    return { type: "number", const: type.value };
  }
  if ((type.flags & typeScript().TypeFlags.BooleanLiteral) !== 0) {
    return { type: "boolean", const: checker.typeToString(type) === "true" };
  }
  if ((type.flags & typeScript().TypeFlags.Null) !== 0) {
    return { type: "null" };
  }
  const primitives = [
    [typeScript().TypeFlags.StringLike, "string"],
    [typeScript().TypeFlags.NumberLike, "number"],
    [typeScript().TypeFlags.BooleanLike, "boolean"],
  ] as const;
  const primitive = primitives.find(([flags]) => (type.flags & flags) !== 0);
  if (primitive !== undefined) {
    return { type: primitive[1] };
  }
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as TypeScript.TypeReference);
    return {
      type: "array",
      items: element === undefined ? {} : typeSchema(checker, element, seen),
    };
  }
  if (type.isUnion()) {
    const members = type.types.filter(
      (member) => (member.flags & typeScript().TypeFlags.Undefined) === 0,
    );
    return { anyOf: members.map((member) => typeSchema(checker, member, seen)) };
  }
  if ((type.flags & typeScript().TypeFlags.Object) !== 0) {
    return objectTypeSchema(checker, type, seen);
  }
  throw new AgentConfigError(`unsupported source tool type: ${checker.typeToString(type)}`);
}

function tagText(tag: TypeScript.JSDocTagInfo): string {
  return (
    tag.text
      ?.map((part) => part.text)
      .join("")
      .trim() ?? ""
  );
}

function signatureForSymbol(
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol,
): TypeScript.Signature {
  const symbolDeclaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (symbolDeclaration === undefined) {
    throw new AgentConfigError(`source tool ${symbol.name} has no declaration`);
  }
  const signatures = checker.getSignaturesOfType(
    checker.getTypeOfSymbolAtLocation(symbol, symbolDeclaration),
    typeScript().SignatureKind.Call,
  );
  const [signature] = signatures;
  if (signatures.length !== 1 || signature === undefined) {
    throw new AgentConfigError(`source tool ${symbol.name} must have exactly one call signature`);
  }
  if (signature.typeParameters !== undefined) {
    throw new AgentConfigError(`generic source tool ${symbol.name} is unsupported`);
  }
  return signature;
}

function parameterMetadata(
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol,
  signature: TypeScript.Signature,
): Pick<FunctionMetadata, "parameterNames" | "parameters"> {
  const parameterNames: string[] = [];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const parameter of signature.parameters) {
    const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (
      parameterDeclaration === undefined ||
      !typeScript().isParameter(parameterDeclaration) ||
      !typeScript().isIdentifier(parameterDeclaration.name)
    ) {
      throw new AgentConfigError(`source tool ${symbol.name} requires named parameters`);
    }
    if (parameterDeclaration.dotDotDotToken !== undefined) {
      throw new AgentConfigError(`source tool ${symbol.name} cannot use rest parameters`);
    }
    parameterNames.push(parameter.name);
    properties[parameter.name] = typeSchema(
      checker,
      checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
      new Set(),
    );
    if (
      parameterDeclaration.questionToken === undefined &&
      parameterDeclaration.initializer === undefined
    ) {
      required.push(parameter.name);
    }
  }
  return {
    parameterNames,
    parameters: { type: "object", properties, additionalProperties: false, required },
  };
}

function metadataForSymbol(
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol,
): FunctionMetadata {
  const description = typeScript()
    .displayPartsToString(symbol.getDocumentationComment(checker))
    .trim();
  if (description.length === 0) {
    throw new AgentConfigError(`source tool ${symbol.name} requires a JSDoc description`);
  }
  const parameters = parameterMetadata(checker, symbol, signatureForSymbol(checker, symbol));
  const tags = symbol.getJsDocTags(checker);
  const promptSnippet = tags.find((tag) => tag.name === "promptSnippet");
  const promptGuidelines = tags
    .filter((tag) => tag.name === "promptGuideline")
    .map(tagText)
    .filter((text) => text.length > 0);
  return {
    name: symbol.name,
    description,
    ...parameters,
    checkpointKey:
      symbol.valueDeclaration?.getText() ?? symbol.declarations?.[0]?.getText() ?? symbol.name,
    ...(promptSnippet === undefined ? {} : { promptSnippet: tagText(promptSnippet) }),
    ...(promptGuidelines.length === 0 ? {} : { promptGuidelines }),
  };
}

function directDeclarationSymbol(
  checker: TypeScript.TypeChecker,
  node: TypeScript.Node,
  name: string,
): TypeScript.Symbol | undefined {
  if (typeScript().isFunctionDeclaration(node) && node.name?.text === name) {
    return checker.getSymbolAtLocation(node.name);
  }
  if (
    typeScript().isVariableDeclaration(node) &&
    typeScript().isIdentifier(node.name) &&
    node.name.text === name
  ) {
    return checker.getSymbolAtLocation(node.name);
  }
  return;
}

function variableStatementSymbol(
  checker: TypeScript.TypeChecker,
  node: TypeScript.Node,
  name: string,
): TypeScript.Symbol | undefined {
  if (!typeScript().isVariableStatement(node)) {
    return;
  }
  for (const declaration of node.declarationList.declarations) {
    const symbol = directDeclarationSymbol(checker, declaration, name);
    if (symbol !== undefined) {
      return symbol;
    }
  }
  return;
}

function importSymbol(
  checker: TypeScript.TypeChecker,
  node: TypeScript.Node,
  name: string,
): TypeScript.Symbol | undefined {
  if (!typeScript().isImportDeclaration(node) || node.importClause === undefined) {
    return;
  }
  const named = node.importClause.namedBindings;
  const identifiers = [
    node.importClause.name,
    ...(named !== undefined && typeScript().isNamedImports(named)
      ? named.elements.map((element) => element.name)
      : []),
  ];
  const identifier = identifiers.find((candidate) => candidate?.text === name);
  const alias = identifier === undefined ? undefined : checker.getSymbolAtLocation(identifier);
  if (alias === undefined || (alias.flags & typeScript().SymbolFlags.Alias) === 0) {
    return alias;
  }
  return checker.getAliasedSymbol(alias);
}

function declarationSymbol(
  checker: TypeScript.TypeChecker,
  node: TypeScript.Node,
  name: string,
): TypeScript.Symbol | undefined {
  return (
    directDeclarationSymbol(checker, node, name) ??
    variableStatementSymbol(checker, node, name) ??
    importSymbol(checker, node, name)
  );
}

function sourcePath(source: string): string {
  return source.startsWith("file:") ? fileURLToPath(source) : source;
}

function findSymbol(program: TypeScript.Program, source: string, name: string): TypeScript.Symbol {
  const checker = program.getTypeChecker();
  const anchor = program.getSourceFile(sourcePath(source));
  if (anchor === undefined) {
    throw new AgentConfigError(`source tool anchor not found: ${source}`);
  }
  const topLevel = anchor.statements.flatMap((statement): TypeScript.Symbol[] => {
    const symbol = declarationSymbol(checker, statement, name);
    return symbol === undefined ? [] : [symbol];
  });
  const [topLevelMatch] = topLevel;
  if (topLevel.length === 1 && topLevelMatch !== undefined) {
    return topLevelMatch;
  }
  const matches: TypeScript.Symbol[] = [];
  const visit = (node: TypeScript.Node): void => {
    const symbol = declarationSymbol(checker, node, name);
    if (symbol !== undefined && !matches.includes(symbol)) {
      matches.push(symbol);
    }
    typeScript().forEachChild(node, visit);
  };
  visit(anchor);
  if (matches.length !== 1) {
    throw new AgentConfigError(
      `source tool ${name} resolved to ${matches.length} declarations in its source module; keep its name unique or use tool(...) for an explicit portable definition`,
    );
  }
  const [match] = matches;
  if (match === undefined) {
    throw new AgentConfigError(`source tool ${name} has no declaration`);
  }
  return match;
}

interface ProgramContext {
  readonly program: TypeScript.Program;
  readonly sourcePath: string;
  readonly configPath?: string;
  readonly rootDirectory?: string;
  readonly outputDirectory?: string;
}

function createProgram(source: string): ProgramContext {
  const path = sourcePath(source);
  const compiler = typeScript();
  const configPath = compiler.findConfigFile(path, compiler.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) {
    return {
      program: compiler.createProgram([path], { module: compiler.ModuleKind.NodeNext }),
      sourcePath: path,
    };
  }
  const config = compiler.readConfigFile(configPath, compiler.sys.readFile);
  if (config.error !== undefined) {
    throw new AgentConfigError(
      compiler.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const configDirectory = dirname(configPath);
  const parsed = compiler.parseJsonConfigFileContent(config.config, compiler.sys, configDirectory);
  const program = compiler.createProgram({
    rootNames: parsed.fileNames.includes(path) ? parsed.fileNames : [...parsed.fileNames, path],
    options: parsed.options,
  });
  return {
    program,
    sourcePath: path,
    configPath,
    ...(parsed.options.rootDir === undefined ? {} : { rootDirectory: parsed.options.rootDir }),
    ...(parsed.options.outDir === undefined ? {} : { outputDirectory: parsed.options.outDir }),
  };
}

function compiledTool(metadata: FunctionMetadata, fn: SourceToolFunction): CompiledTool {
  const validator = compileJsonSchemaValidator(metadata.parameters);
  return {
    ...metadata,
    invoke: async (input: unknown): Promise<unknown> => {
      const errors = validator.validate(input);
      if (errors.length > 0) {
        throw new AgentConfigError(errors.join("; "));
      }
      const record = input as Record<string, unknown>;
      return await Reflect.apply(
        fn,
        undefined,
        metadata.parameterNames.map((name) => record[name]),
      );
    },
  };
}

function compileFromManifest(
  manifest: SourceToolManifest,
  functions: readonly SourceToolFunction[],
): CompiledTool[] {
  return functions.map((fn) => {
    const matches = manifest.tools.filter((candidate) => candidate.name === fn.name);
    const [metadata] = matches;
    if (matches.length !== 1 || metadata === undefined) {
      throw new AgentConfigError(
        `source tool ${fn.name} is missing or duplicated in the baked manifest; rerun \`unigent bake <entry>\``,
      );
    }
    return compiledTool(metadata, fn);
  });
}

function isTypeScriptSource(path: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(path));
}

/** Compile source-visible functions using a baked manifest or live TypeScript source. */
function compileSourceTools(
  source: string,
  functions: readonly SourceToolFunction[],
): CompiledTool[] {
  const manifest = readManifest(source);
  if (manifest !== undefined) {
    return compileFromManifest(manifest, functions);
  }
  const path = sourcePath(source);
  if (!isTypeScriptSource(path)) {
    throw new AgentConfigError(
      `source tool anchor ${source} is compiled JavaScript without ${manifestPath(path)}; run \`unigent bake <entry>\` during the build or point source at TypeScript in development`,
    );
  }
  const { program } = createProgram(source);
  const checker = program.getTypeChecker();
  return functions.map((fn): CompiledTool => {
    const metadata = metadataForSymbol(checker, findSymbol(program, source, fn.name));
    return compiledTool(metadata, fn);
  });
}

function propertyName(node: TypeScript.PropertyName): string | undefined {
  return typeScript().isIdentifier(node) || typeScript().isStringLiteral(node)
    ? node.text
    : undefined;
}

function declaredSourceToolNames(anchor: TypeScript.SourceFile): readonly string[] {
  const names = new Set<string>();
  const visit = (node: TypeScript.Node): void => {
    if (
      typeScript().isPropertyAssignment(node) &&
      propertyName(node.name) === "tools" &&
      typeScript().isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (typeScript().isIdentifier(element)) {
          names.add(element.text);
        }
      }
    }
    typeScript().forEachChild(node, visit);
  };
  visit(anchor);
  return [...names];
}

function bakedMetadata(
  program: TypeScript.Program,
  source: string,
  names: readonly string[],
): readonly FunctionMetadata[] {
  const checker = program.getTypeChecker();
  return names.flatMap((name): FunctionMetadata[] => {
    const symbol = findSymbol(program, source, name);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (
      declaration === undefined ||
      symbol.getDocumentationComment(checker).length === 0 ||
      checker.getSignaturesOfType(
        checker.getTypeOfSymbolAtLocation(symbol, declaration),
        typeScript().SignatureKind.Call,
      ).length === 0
    ) {
      return [];
    }
    return [metadataForSymbol(checker, symbol)];
  });
}

function defaultManifestOutput(context: ProgramContext): string {
  if (context.outputDirectory === undefined) {
    return manifestPath(context.sourcePath);
  }
  const rootDirectory = context.rootDirectory ?? dirname(context.sourcePath);
  const relativeSource = relative(rootDirectory, context.sourcePath);
  if (relativeSource.startsWith("..")) {
    throw new AgentConfigError(
      `source tool entry ${context.sourcePath} is outside tsconfig rootDir ${rootDirectory}`,
    );
  }
  return manifestPath(join(context.outputDirectory, relativeSource));
}

/** Bake source-derived tool schemas next to the entry's compiled JavaScript output. */
function bakeSourceTools(source: string, output?: string): string {
  const absoluteSource = isAbsolute(source) ? source : resolve(source);
  if (!isTypeScriptSource(absoluteSource)) {
    throw new AgentConfigError(`unigent bake requires a TypeScript entry: ${source}`);
  }
  const context = createProgram(absoluteSource);
  const anchor = context.program.getSourceFile(absoluteSource);
  if (anchor === undefined) {
    throw new AgentConfigError(`source tool anchor not found: ${source}`);
  }
  const names = declaredSourceToolNames(anchor);
  const tools = bakedMetadata(context.program, absoluteSource, names);
  if (tools.length === 0) {
    throw new AgentConfigError(`no source-derived tools found in ${source}`);
  }
  const path = output === undefined ? defaultManifestOutput(context) : resolve(output);
  const manifest: SourceToolManifest = {
    version: 1,
    source: basename(absoluteSource),
    tools,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return path;
}

export { bakeSourceTools, compileSourceTools };
