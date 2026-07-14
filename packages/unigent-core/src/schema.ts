import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonSchema } from "./backend.js";
import { AgentConfigError } from "./errors.js";

/** Standard Schema accepted for structured agent output. */
type OutputSchema<Output> = StandardSchemaV1<unknown, Output>;

function issueMessage(issue: StandardSchemaV1.Issue): string {
  const path = issue.path?.map((part) => (typeof part === "object" ? part.key : part)).join(".");
  return path === undefined || path.length === 0 ? issue.message : `${path}: ${issue.message}`;
}

/** Parse unknown input through Standard Schema. */
async function parseSchema<Output>(
  schema: OutputSchema<Output>,
  input: unknown,
): Promise<{ readonly value?: Output; readonly error?: string }> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    return { error: result.issues.map(issueMessage).join("; ") };
  }
  return { value: result.value };
}

interface JsonSchemaProjector {
  readonly toJSONSchema: () => unknown;
}

interface StandardJsonSchemaProjector {
  readonly input: (options: { readonly target: string }) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasJsonSchemaProjector(value: object): value is JsonSchemaProjector {
  return "toJSONSchema" in value && typeof value.toJSONSchema === "function";
}

function standardJsonSchemaProjector(
  schema: OutputSchema<unknown>,
): StandardJsonSchemaProjector | undefined {
  const standard: object = schema["~standard"];
  if (!("jsonSchema" in standard) || !isRecord(standard.jsonSchema)) {
    return;
  }
  const input = standard.jsonSchema["input"];
  return typeof input === "function"
    ? {
        input: (options: { readonly target: string }): unknown =>
          Reflect.apply(input, standard.jsonSchema, [options]),
      }
    : undefined;
}

function bareJsonSchema(value: unknown): JsonSchema | undefined {
  if (!isRecord(value)) {
    return;
  }
  const projected = { ...value };
  Reflect.deleteProperty(projected, "$schema");
  return projected;
}

function optionalJsonSchema(schema: OutputSchema<unknown>): JsonSchema | undefined {
  const standardProjector = standardJsonSchemaProjector(schema);
  if (standardProjector !== undefined) {
    try {
      const projected = bareJsonSchema(standardProjector.input({ target: "draft-2020-12" }));
      if (projected !== undefined) {
        return projected;
      }
    } catch {
      // A compatibility projector below may still be available.
    }
  }
  if (!hasJsonSchemaProjector(schema)) {
    return;
  }
  const projected = bareJsonSchema(schema.toJSONSchema());
  if (projected === undefined) {
    throw new AgentConfigError("schema produced invalid JSON Schema");
  }
  return projected;
}

/** Project a portable tool input schema to provider JSON Schema. */
function projectJsonSchema(schema: OutputSchema<unknown>): JsonSchema {
  const projected = optionalJsonSchema(schema);
  if (projected === undefined) {
    throw new AgentConfigError(
      "portable tool input schemas must expose toJSONSchema(); raw source tools derive JSON Schema from TypeScript",
    );
  }
  return projected;
}

export type { OutputSchema };
export { optionalJsonSchema, parseSchema, projectJsonSchema };
