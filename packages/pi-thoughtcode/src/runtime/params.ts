import { validateValue, type ParsedParam } from "thoughtcode-core";

export type ArgBinding = { ok: true; bound: Record<string, unknown> } | { ok: false; error: string };

/**
 * Bind caller-supplied arg values to declared params: apply defaults, reject missing-required and
 * unknown args, then type-check each value against its declared ArkType type.
 */
export function bindAndCheckArgs(params: ParsedParam[], values: Record<string, unknown>): ArgBinding {
  const bound: Record<string, unknown> = {};
  const declared = new Set(params.map((param) => param.name));

  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      return { ok: false, error: `unknown argument \`${key}\`` };
    }
  }

  for (const param of params) {
    if (Object.prototype.hasOwnProperty.call(values, param.name)) {
      bound[param.name] = values[param.name];
    } else if (param.hasDefault) {
      bound[param.name] = param.default;
    } else {
      return { ok: false, error: `missing required argument \`${param.name}\`` };
    }
  }

  for (const param of params) {
    if (!param.type) continue;
    const check = validateValue(bound[param.name], param.type);
    if (!check.ok) {
      return { ok: false, error: `argument \`${param.name}\` must be \`${param.type}\`: ${check.message}` };
    }
  }

  return { ok: true, bound };
}
