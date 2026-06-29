// Parameter-schema derivation (P1b / ADR-0003). A program runs from source, so an
// exposed method's TypeScript parameter types are available at load. This reads
// the method signature with the TS compiler API and emits both a JSON Schema
// (advertised to the model for the `{ tool }` tier and returned by foom_inspect)
// and a Standard Schema validator over the call arguments (F4) — the author never
// writes `parameters`. Unrecognised types degrade to permissive (`{}`), never an
// error. Derivation is pure given a file; callers cache per file.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import ts from "typescript";
import { FoomConfigError } from "./errors.js";
import type { JsonSchema } from "./session.js";
import { makeStandardSchema } from "./standard_schema.js";

/** The derived parameter schema for one method. */
export interface DerivedParameters {
  /** JSON Schema of the arguments object (advertised to the model). */
  readonly jsonSchema: JsonSchema;
  /** Standard Schema validating a raw arguments object (F4). */
  readonly schema: StandardSchemaV1<unknown, Record<string, unknown>>;
  /** Parameter names, in declaration order. */
  readonly paramNames: readonly string[];
}

interface TypeShape {
  readonly json: JsonSchema;
  readonly check: (value: unknown) => boolean;
}

interface ParamSpec {
  readonly name: string;
  readonly optional: boolean;
  readonly shape: TypeShape;
}

const anyShape: TypeShape = { json: {}, check: () => true };

function arrayElementType(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  const objectFlags = (type as ts.ObjectType).objectFlags;
  if ((type.flags & ts.TypeFlags.Object) !== 0 && (objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const reference = type as ts.TypeReference;
    if (reference.target.symbol.getName() === "Array") {
      return checker.getTypeArguments(reference)[0];
    }
  }
  return undefined;
}

/** Shape for a union: an `enum` when every member is a string/number literal,
 *  else `anyOf`; the check accepts a value any member accepts. */
function unionShape(type: ts.UnionType, checker: ts.TypeChecker): TypeShape {
  const shapes = type.types.map((member) => typeToShape(member, checker));
  const consts = type.types.every((member) => member.isStringLiteral() || member.isNumberLiteral());
  const json: JsonSchema = consts
    ? { enum: type.types.map((member) => (member as ts.LiteralType).value) }
    : { anyOf: shapes.map((shape) => shape.json) };
  return { json, check: (v: unknown): boolean => shapes.some((shape) => shape.check(v)) };
}

/** Shape for an object type with named properties (each prop recursed, optionals
 *  tracked). Returns undefined for a property-less object, so the caller falls
 *  back to the open `anyShape`. */
function objectShape(type: ts.Type, checker: ts.TypeChecker): TypeShape | undefined {
  const properties = type.getProperties();
  if (properties.length === 0) return undefined;
  const props: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const checks: Array<{ name: string; optional: boolean; check: (v: unknown) => boolean }> = [];
  for (const prop of properties) {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = declaration
      ? checker.getTypeOfSymbolAtLocation(prop, declaration)
      : checker.getDeclaredTypeOfSymbol(prop);
    const shape = typeToShape(propType, checker);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    props[prop.getName()] = shape.json;
    if (!optional) required.push(prop.getName());
    checks.push({ name: prop.getName(), optional, check: shape.check });
  }
  return {
    json: { type: "object", properties: props, required, additionalProperties: false },
    check: (v: unknown): boolean => {
      if (typeof v !== "object" || v === null) return false;
      const record = v as Record<string, unknown>;
      return checks.every((entry) =>
        entry.name in record ? entry.check(record[entry.name]) : entry.optional,
      );
    },
  };
}

function typeToShape(type: ts.Type, checker: ts.TypeChecker): TypeShape {
  const flags = type.flags;
  if (flags & ts.TypeFlags.StringLiteral) {
    const value = (type as ts.StringLiteralType).value;
    return { json: { const: value }, check: (v: unknown): boolean => v === value };
  }
  if (flags & ts.TypeFlags.NumberLiteral) {
    const value = (type as ts.NumberLiteralType).value;
    return { json: { const: value }, check: (v: unknown): boolean => v === value };
  }
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) {
    return { json: { type: "string" }, check: (v: unknown): boolean => typeof v === "string" };
  }
  if (flags & ts.TypeFlags.Number) {
    return { json: { type: "number" }, check: (v: unknown): boolean => typeof v === "number" };
  }
  if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) {
    return { json: { type: "boolean" }, check: (v: unknown): boolean => typeof v === "boolean" };
  }
  if (type.isUnion()) return unionShape(type, checker);
  const element = arrayElementType(type, checker);
  if (element !== undefined) {
    const item = typeToShape(element, checker);
    return {
      json: { type: "array", items: item.json },
      check: (v: unknown): boolean => Array.isArray(v) && v.every((entry) => item.check(entry)),
    };
  }
  if (flags & ts.TypeFlags.Object) {
    const shape = objectShape(type, checker);
    if (shape !== undefined) return shape;
  }
  return anyShape;
}

function findMethod(
  source: ts.SourceFile,
  className: string,
  methodName: string,
): ts.MethodDeclaration | undefined {
  let found: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText(source) === methodName) {
          found = member;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The `main` method of the file's `export default class …` (named or anonymous). */
function findDefaultExportMain(source: ts.SourceFile): ts.MethodDeclaration | undefined {
  let found: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true
    ) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText(source) === "main") {
          found = member;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function compileSource(filePath: string): { checker: ts.TypeChecker; source: ts.SourceFile } {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const source = program.getSourceFile(filePath);
  if (source === undefined) {
    throw new FoomConfigError(`Cannot read program source for derivation: ${filePath}`);
  }
  return { checker: program.getTypeChecker(), source };
}

/** Validate a decoded arguments object against the derived param specs: one issue
 *  per missing-required or wrong-typed argument (optional + absent is fine). */
function collectArgIssues(
  specs: readonly ParamSpec[],
  record: Record<string, unknown>,
): StandardSchemaV1.Issue[] {
  const issues: StandardSchemaV1.Issue[] = [];
  for (const spec of specs) {
    if (!(spec.name in record)) {
      if (!spec.optional) {
        issues.push({ message: `missing required argument "${spec.name}"`, path: [spec.name] });
      }
      continue;
    }
    if (!spec.shape.check(record[spec.name])) {
      issues.push({ message: `argument "${spec.name}" has the wrong type`, path: [spec.name] });
    }
  }
  return issues;
}

function buildDerived(
  method: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): DerivedParameters {
  const specs: ParamSpec[] = method.parameters.map((param) => {
    const rawType = checker.getTypeAtLocation(param);
    const nullable =
      rawType.isUnion() &&
      rawType.types.some(
        (member) =>
          (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
      );
    return {
      name: param.name.getText(source),
      optional: param.questionToken !== undefined || param.initializer !== undefined || nullable,
      shape: typeToShape(checker.getNonNullableType(rawType), checker),
    };
  });

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const spec of specs) {
    properties[spec.name] = spec.shape.json;
    if (!spec.optional) required.push(spec.name);
  }
  const jsonSchema: JsonSchema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };

  const schema = makeStandardSchema<Record<string, unknown>>((input) => {
    if (typeof input !== "object" || input === null) {
      return { issues: [{ message: "arguments must be an object" }] };
    }
    const record = input as Record<string, unknown>;
    const issues = collectArgIssues(specs, record);
    return issues.length > 0 ? { issues } : { value: record };
  });

  return { jsonSchema, schema, paramNames: specs.map((spec) => spec.name) };
}

/** Derive the parameter schema of `className.methodName` declared in `filePath`. */
export function deriveMethodParameters(
  filePath: string,
  className: string,
  methodName: string,
): DerivedParameters {
  const { checker, source } = compileSource(filePath);
  const method = findMethod(source, className, methodName);
  if (method === undefined) {
    throw new FoomConfigError(`Method ${className}.${methodName} not found in ${filePath}`);
  }
  return buildDerived(method, checker, source);
}

/**
 * Derive the input schema of a program's `main` from its `export default class`
 * (named or anonymous). Used to advertise a program as an agent tool: the result
 * is an object schema keyed by main's single parameter name.
 */
export function deriveProgramInput(filePath: string): DerivedParameters {
  const { checker, source } = compileSource(filePath);
  const method = findDefaultExportMain(source);
  if (method === undefined) {
    throw new FoomConfigError(
      `${filePath} must \`export default class … extends Program(...)\` with a main() method`,
    );
  }
  return buildDerived(method, checker, source);
}
