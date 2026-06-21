import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function textResult<TDetails>(text: string, details: TDetails, terminate = false): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details,
    terminate,
  };
}

export function getTextContent(content: AgentToolResult<unknown>["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
