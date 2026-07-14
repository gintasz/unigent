interface ValidationIssue {
  readonly message: string;
  readonly path: readonly unknown[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;
const INVALID_INPUT_PREFIX_PATTERN = /^Invalid input:\s*/u;
const WHITESPACE_PATTERN = /\s+/gu;

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function validationIssues(error: unknown): readonly ValidationIssue[] | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error)) {
    return;
  }
  const issues: unknown = error.issues;
  if (!isUnknownArray(issues)) {
    return;
  }
  const parsed = issues.flatMap((issue): ValidationIssue[] => {
    if (typeof issue !== "object" || issue === null || !("message" in issue)) {
      return [];
    }
    const message: unknown = issue.message;
    const rawPath: unknown = "path" in issue ? issue.path : undefined;
    const path = isUnknownArray(rawPath) ? rawPath : [];
    return [{ message: String(message), path }];
  });
  return parsed.length === 0 ? undefined : parsed;
}

function validationPath(path: readonly unknown[]): string {
  let formatted = "input";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else if (typeof segment === "string" && IDENTIFIER_PATTERN.test(segment)) {
      formatted += `.${segment}`;
    } else {
      formatted += `[${JSON.stringify(String(segment))}]`;
    }
  }
  return formatted;
}

function conciseIssueMessage(message: string): string {
  return message.replace(INVALID_INPUT_PREFIX_PATTERN, "").replace(WHITESPACE_PATTERN, " ").trim();
}

function validationMessage(issues: readonly ValidationIssue[]): string {
  const [onlyIssue] = issues;
  if (issues.length === 1 && onlyIssue !== undefined && onlyIssue.path.length === 0) {
    return onlyIssue.message;
  }
  const details = issues.map(
    (issue) => `  ${validationPath(issue.path)}: ${conciseIssueMessage(issue.message)}`,
  );
  return `validation failed:\n${details.join("\n")}`;
}

export function fatalErrorMessage(error: unknown): string {
  const issues = validationIssues(error);
  if (issues !== undefined) {
    return validationMessage(issues);
  }
  return error instanceof Error ? error.message : String(error);
}
