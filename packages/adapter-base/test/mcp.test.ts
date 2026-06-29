// The shared in-process MCP server: prove the JSON-RPC handler lists tools (default
// + custom `describe`), executes a call against the real `execute` closure, flips
// the terminate latch, and round-trips over real localhost HTTP.

import type { NeutralToolDef, ToolExecResult } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createMcpHandler, startMcpServer, toolDescription } from "../src/mcp.ts";

function tool(
  name: string,
  execute: (args: unknown) => Promise<ToolExecResult>,
  extra: Partial<NeutralToolDef> = {},
): NeutralToolDef {
  return {
    name,
    description: `does ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
    ...extra,
  };
}

const ok = (content: string, terminate = false): Promise<ToolExecResult> =>
  Promise.resolve({ content, isError: false, ...(terminate ? { terminate } : {}) });

describe("toolDescription", () => {
  it("folds promptSnippet + guidelines into the description", () => {
    const text = toolDescription(
      tool("foom_return", () => ok("x"), {
        promptSnippet: "return the value",
        promptGuidelines: ["call once", "no prose"],
      }),
    );
    expect(text).toContain("does foom_return");
    expect(text).toContain("return the value");
    expect(text).toContain("- call once");
    expect(text).toContain("- no prose");
  });
});

describe("createMcpHandler", () => {
  it("lists tools under bare names with the default description", async () => {
    const { handle } = createMcpHandler([tool("foom_return", () => ok("done"))], "foom");
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = res?.["result"] as { tools: Array<{ name: string; description: string }> };
    expect(tools[0]?.name).toBe("foom_return");
    expect(tools[0]?.description).toBe("does foom_return");
  });

  it("applies a custom describe hook to the listing", async () => {
    const { handle } = createMcpHandler(
      [tool("foom_return", () => ok("done"))],
      "foom",
      (t) => `RENAMED ${t.name}`,
    );
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = res?.["result"] as { tools: Array<{ description: string }> };
    expect(tools[0]?.description).toBe("RENAMED foom_return");
  });

  it("executes a tool call and flips the terminate latch", async () => {
    let seen: unknown;
    const handler = createMcpHandler(
      [
        tool("foom_return", (args) => {
          seen = args;
          return ok("returned", true);
        }),
      ],
      "foom",
    );
    const res = await handler.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "foom_return", arguments: { value: 1 } },
    });
    expect(seen).toEqual({ value: 1 });
    expect((res?.["result"] as { isError: boolean }).isError).toBe(false);
    expect(handler.terminated()).toBe(true);
  });

  it("returns an error for an unknown tool and null for a notification", async () => {
    const { handle } = createMcpHandler([tool("foom_return", () => ok("x"))], "foom");
    const unknown = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(unknown?.["error"]).toMatchObject({ code: -32_602 });
    const notification = await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification).toBeNull();
  });

  it("answers initialize with the server name", async () => {
    const { handle } = createMcpHandler([tool("foom_return", () => ok("x"))], "foom");
    const res = await handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
    expect((res?.["result"] as { serverInfo: { name: string } }).serverInfo.name).toBe("foom");
  });
});

describe("startMcpServer", () => {
  it("round-trips a tools/call over real localhost HTTP", async () => {
    const server = await startMcpServer([tool("foom_return", () => ok("hi from http"))], "foom");
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "foom_return", arguments: {} },
        }),
      });
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      expect(body.result.content[0]?.text).toBe("hi from http");
    } finally {
      await server.close();
    }
  });

  it("acknowledges non-POST requests with 202", async () => {
    const server = await startMcpServer([tool("foom_return", () => ok("x"))], "foom");
    try {
      const res = await fetch(server.url, { method: "GET" });
      expect(res.status).toBe(202);
    } finally {
      await server.close();
    }
  });
});
