import type { BackendEvent, BackendTurnResult, BackendUsage } from "@unigent/core";

type JsonObject = Readonly<Record<string, unknown>>;

interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly initialInput: unknown;
  readonly partialInput: string;
}

const UNIGENT_TOOL_PREFIX = /^mcp__unigent__/;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolName(value: unknown): string {
  return (string(value) ?? "").replace(UNIGENT_TOOL_PREFIX, "");
}

function parsedInput(pending: PendingToolCall): unknown {
  if (pending.partialInput.trim().length === 0) {
    return pending.initialInput;
  }
  try {
    return JSON.parse(pending.partialInput) as unknown;
  } catch {
    // A malformed partial stream is diagnostic-only; the completed assistant event is the fallback.
    return pending.initialInput;
  }
}

/** Mutable Claude stream-json fold. */
export class ClaudeStreamReader {
  private readonly streamedMessages = new Set<string>();
  private readonly pendingTools = new Map<number, PendingToolCall>();
  private readonly toolNames = new Map<string, string>();
  private session: string | undefined;
  private completed = false;
  private failure: string | undefined;
  private text = "";
  private usageValue: BackendUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  public constructor(private readonly emit: (event: BackendEvent) => void) {}

  public handle(event: JsonObject): void {
    this.session = string(event["session_id"]) ?? this.session;
    if (event["type"] === "stream_event") {
      this.handleStreamEvent(object(event["event"]));
    } else if (event["type"] === "assistant") {
      this.handleAssistant(object(event["message"]));
    } else if (event["type"] === "user") {
      this.handleUser(object(event["message"]));
    } else if (event["type"] === "result") {
      this.handleResult(event);
    }
  }

  private handleStreamEvent(event: JsonObject | undefined): void {
    if (event?.["type"] === "message_start") {
      const id = string(object(event["message"])?.["id"]);
      if (id !== undefined) {
        this.streamedMessages.add(id);
      }
      return;
    }
    if (event?.["type"] === "content_block_start") {
      this.startContentBlock(event);
    } else if (event?.["type"] === "content_block_delta") {
      this.updateContentBlock(event);
    } else if (event?.["type"] === "content_block_stop") {
      this.finishContentBlock(event);
    }
  }

  private startContentBlock(event: JsonObject): void {
    const content = object(event["content_block"]);
    if (content?.["type"] !== "tool_use") {
      return;
    }
    const index = number(event["index"]);
    this.pendingTools.set(index, {
      callId: string(content["id"]) ?? "",
      name: toolName(content["name"]),
      initialInput: content["input"],
      partialInput: "",
    });
  }

  private updateContentBlock(event: JsonObject): void {
    const delta = object(event["delta"]);
    if (delta?.["type"] === "text_delta") {
      const text = string(delta["text"]) ?? "";
      this.text += text;
      this.emit({ type: "text", text });
      return;
    }
    if (delta?.["type"] === "thinking_delta") {
      const thinking = string(delta["thinking"]) ?? "";
      if (thinking.length > 0) {
        this.emit({ type: "reasoning", text: thinking });
      }
      return;
    }
    if (delta?.["type"] !== "input_json_delta") {
      return;
    }
    const index = number(event["index"]);
    const pending = this.pendingTools.get(index);
    if (pending !== undefined) {
      this.pendingTools.set(index, {
        ...pending,
        partialInput: pending.partialInput + (string(delta["partial_json"]) ?? ""),
      });
    }
  }

  private finishContentBlock(event: JsonObject): void {
    const index = number(event["index"]);
    const pending = this.pendingTools.get(index);
    if (pending === undefined) {
      return;
    }
    this.pendingTools.delete(index);
    this.emitToolCall(pending.callId, pending.name, parsedInput(pending));
  }

  private emitToolCall(callId: string, name: string, input: unknown): void {
    this.toolNames.set(callId, name);
    this.emit({ type: "tool_call", callId, name, input });
  }

  private handleAssistant(message: JsonObject | undefined): void {
    const messageId = string(message?.["id"]);
    if (messageId !== undefined && this.streamedMessages.has(messageId)) {
      return;
    }
    for (const raw of array(message?.["content"])) {
      const part = object(raw);
      if (part?.["type"] === "text") {
        const text = string(part["text"]) ?? "";
        this.text += text;
        this.emit({ type: "text", text });
      } else if (part?.["type"] === "tool_use") {
        this.emitToolCall(string(part["id"]) ?? "", toolName(part["name"]), part["input"]);
      }
    }
  }

  private handleUser(message: JsonObject | undefined): void {
    for (const raw of array(message?.["content"])) {
      const part = object(raw);
      if (part?.["type"] !== "tool_result") {
        continue;
      }
      const callId = string(part["tool_use_id"]) ?? "";
      const rawContent = part["content"];
      const output =
        typeof rawContent === "string"
          ? rawContent
          : array(rawContent)
              .map((item) => string(object(item)?.["text"]) ?? "")
              .join("");
      this.emit({
        type: "tool_result",
        callId,
        name: this.toolNames.get(callId) ?? "",
        output,
        isError: part["is_error"] === true,
      });
    }
  }

  private handleResult(event: JsonObject): void {
    this.completed = true;
    const usage = object(event["usage"]) ?? {};
    const inputTokens = number(usage["input_tokens"]);
    const outputTokens = number(usage["output_tokens"]);
    const cachedInputTokens =
      number(usage["cache_read_input_tokens"]) + number(usage["cache_creation_input_tokens"]);
    this.usageValue = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens + cachedInputTokens,
      ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
      ...(typeof event["total_cost_usd"] === "number" ? { costUsd: event["total_cost_usd"] } : {}),
    };
    const finalText = string(event["result"]);
    if (finalText !== undefined && finalText.length > 0) {
      this.text = finalText;
    }
    if (event["is_error"] === true || (string(event["subtype"]) ?? "success") !== "success") {
      this.failure = this.text.length > 0 ? this.text : "Claude CLI failed";
    }
  }

  public sessionId(): string | undefined {
    return this.session;
  }

  public error(): string | undefined {
    return this.failure;
  }

  public result(): BackendTurnResult | undefined {
    return this.completed ? { text: this.text, usage: this.usageValue } : undefined;
  }
}
