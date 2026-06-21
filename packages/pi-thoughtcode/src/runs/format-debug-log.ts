interface RawEntry {
  ts?: string;
  traceId?: string;
  runId?: string;
  parentRunId?: string;
  depth?: number;
  kind?: string;
  [key: string]: unknown;
}

function indent(depth: number): string {
  return "  ".repeat(Math.max(0, (depth || 1) - 1));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

/**
 * Render a multi-line value under a marker. The first line carries the entry head (timestamp +
 * indent + marker); continuation lines are blank-padded to the same width so the timestamp isn't
 * repeated and the text stays aligned.
 */
function block(head: string, prefix: string, text: string): string {
  const [first, ...rest] = text.split("\n");
  const continuation = " ".repeat(head.length + prefix.length);
  return [`${head}${prefix}${first}`, ...rest.map((line) => `${continuation}${line}`)].join("\n");
}

function formatEntry(entry: RawEntry): string {
  const pad = indent(entry.depth ?? 1);
  const t = entry.ts ?? "";
  const head = `${t}  ${pad}`;
  const run = entry.runId ?? "?";

  switch (entry.kind) {
    case "run.start":
      return `${head}▶ run ${run} ${str(entry.name)}(${str(entry.args)})  ${str(entry.file)}`;
    case "run.end":
      return `${head}■ run ${run} ${str(entry.status)}${entry.value !== undefined ? ` → ${truncateInline(str(entry.value))}` : ""}`;
    case "thinking":
      return block(head, "· thinking ", str(entry.text));
    case "text":
      return block(head, "· text ", str(entry.text));
    case "tool.start":
      return `${head}→ ${str(entry.toolName)} ${truncateInline(str(entry.args))}`;
    case "tool.end":
      return `${head}← ${str(entry.toolName)}${entry.isError ? " [ERROR]" : ""} ${truncateInline(str(entry.result))}`;
    case "return":
      return `${head}⏎ return ${truncateInline(str(entry.value))}`;
    case "reminder":
      return block(head, "! reminder ", str(entry.text));
    case "agent.error":
      return block(head, "✗ error ", str(entry.text));
    default:
      return `${head}${str(entry.kind)} ${JSON.stringify(omit(entry, ["ts", "traceId", "runId", "parentRunId", "depth", "kind"]))}`;
  }
}

function truncateInline(text: string, max = 200): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function omit(entry: RawEntry, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!keys.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render a JSONL debug log (the output of THOUGHTCODE_DEBUG_LOG) as an indented, human-readable
 * trace: depth-indented, timestamps relative to the first event, prompts collapsed, one line per
 * milestone. Invalid lines are skipped.
 */
export function formatDebugLog(jsonl: string): string {
  const entries: RawEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as RawEntry);
    } catch {
      // Skip malformed lines rather than failing the whole render.
    }
  }
  if (entries.length === 0) {
    return "";
  }
  const out: string[] = [];
  let lastTrace: string | undefined;
  for (const entry of entries) {
    if (entry.traceId && entry.traceId !== lastTrace) {
      if (lastTrace !== undefined) {
        out.push("");
      }
      out.push(`=== trace ${entry.traceId} ===`);
      lastTrace = entry.traceId;
    }
    out.push(formatEntry(entry));
  }
  return out.join("\n");
}
