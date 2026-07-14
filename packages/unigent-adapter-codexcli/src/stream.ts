import type { BackendEvent, BackendTurnResult, BackendUsage } from "@unigent/core";

type JsonObject = Readonly<Record<string, unknown>>;

const UNIGENT_TOOL_PREFIX = /^mcp__unigent__/;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function toolName(value: unknown): string {
  return (string(value) ?? "").replace(UNIGENT_TOOL_PREFIX, "");
}

function toolInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const content = object(value)?.["content"];
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => string(object(part)?.["text"]) ?? "").join("");
}

/** Fold Codex `exec --json` events into Unigent events and a settled turn result. */
export class CodexStreamReader {
  private session: string | undefined;
  private completed = false;
  private failure: string | undefined;
  private text = "";
  private usage: BackendUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  public constructor(private readonly emit: (event: BackendEvent) => void) {}

  public handle(event: JsonObject): void {
    switch (event["type"]) {
      case "thread.started":
        this.session = string(event["thread_id"]) ?? this.session;
        break;
      case "item.started":
        this.handleStarted(object(event["item"]));
        break;
      case "item.completed":
        this.handleCompleted(object(event["item"]));
        break;
      case "turn.completed":
        this.completed = true;
        this.usage = usageFromTurn(event["usage"]);
        break;
      case "turn.failed":
        this.failure = string(object(event["error"])?.["message"]) ?? "Codex CLI turn failed";
        break;
      case "error":
        this.failure = string(event["message"]) ?? "Codex CLI failed";
        break;
      default:
        break;
    }
  }

  public sessionId(): string | undefined {
    return this.session;
  }

  public error(): string | undefined {
    return this.failure;
  }

  public result(): BackendTurnResult | undefined {
    return this.completed ? { text: this.text, usage: this.usage } : undefined;
  }

  private handleStarted(item: JsonObject | undefined): void {
    if (item?.["type"] !== "mcp_tool_call" && item?.["type"] !== "function_call") {
      return;
    }
    this.emit({
      type: "tool_call",
      callId: string(item["id"]) ?? "",
      name: toolName(item["tool"] ?? item["name"]),
      input: toolInput(item["arguments"]),
    });
  }

  private handleCompleted(item: JsonObject | undefined): void {
    if (item === undefined) {
      return;
    }
    if (item["type"] === "agent_message") {
      const text = string(item["text"]) ?? "";
      this.text = text;
      if (text.length > 0) {
        this.emit({ type: "text", text });
      }
      return;
    }
    if (item["type"] === "reasoning") {
      const text = string(item["text"]) ?? "";
      if (text.length > 0) {
        this.emit({ type: "reasoning", text });
      }
      return;
    }
    if (item["type"] === "mcp_tool_call" || item["type"] === "function_call") {
      this.emit({
        type: "tool_result",
        callId: string(item["id"]) ?? "",
        name: toolName(item["tool"] ?? item["name"]),
        output: toolOutput(item["result"]),
        isError: item["status"] === "failed" || object(item["error"]) !== undefined,
      });
    }
  }
}

/** Map Codex usage blocks to the neutral Unigent usage shape. */
export function usageFromTurn(usageBlock: unknown): BackendUsage {
  const usage = object(usageBlock);
  const inputTokens = number(usage?.["input_tokens"]);
  const outputTokens = number(usage?.["output_tokens"]);
  const cachedInputTokens = number(usage?.["cached_input_tokens"]);
  const reasoningTokens = number(usage?.["reasoning_output_tokens"]);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
  };
}
