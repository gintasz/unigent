import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonSchema } from "./backend.js";
import { AgentConfigError } from "./errors.js";

interface JsonSchemaValidator {
  readonly validate: (value: unknown) => readonly string[];
}

function issueMessage(issue: ErrorObject): string {
  const location = issue.instancePath.length === 0 ? "input" : `input${issue.instancePath}`;
  return `${location} ${issue.message ?? "is invalid"}`;
}

/** Compile source-derived JSON Schema through the isolated validator boundary. */
function compileJsonSchemaValidator(schema: JsonSchema): JsonSchemaValidator {
  let validate: ValidateFunction;
  try {
    const ajv = new Ajv({ allErrors: true, strict: true });
    validate = ajv.compile(schema);
  } catch (error) {
    throw new AgentConfigError("failed to compile source tool parameter schema", { cause: error });
  }
  return {
    validate: (value: unknown): readonly string[] => {
      if (validate(value)) {
        return [];
      }
      return (validate.errors ?? []).map(issueMessage);
    },
  };
}

export { compileJsonSchemaValidator };
