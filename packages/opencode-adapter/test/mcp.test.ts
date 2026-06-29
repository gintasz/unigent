import type { NeutralToolDef } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createMcpHandler, startMcpServer } from "../src/mcp.ts";

function tool(over: Partial<NeutralToolDef> = {}): NeutralToolDef {
  return {
    name: "foom_return",
    description: "Return the value. See foom_throw to abort.",
    parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
    execute: async (args) => ({
      content: `got ${JSON.stringify(args)}`,
      isError: false,
      terminate: true,
    }),
    ...over,
  };
}

describe("mcp handler (pure)", () => {
  it("lists tools by canonical name with prefix-renamed descriptions", async () => {
    const { handle } = createMcpHandler([tool({ name: "foom_throw" }), tool()], "foom");
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = res?.["result"] as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(tools.map((t) => t.name)).toEqual(["foom_throw", "foom_return"]);
    // cross-reference in the description is rewritten to the model-visible name
    expect(tools[1]?.description).toContain("foom_foom_throw");
  });

  it("executes a tool and reports the terminate signal", async () => {
    const { handle, terminated } = createMcpHandler([tool()], "foom");
    const res = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "foom_return", arguments: { value: 9 } },
    });
    expect((res?.["result"] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      'got {"value":9}',
    );
    expect(terminated()).toBe(true);
  });

  it("returns no reply for a notification", async () => {
    const { handle } = createMcpHandler([tool()], "foom");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("errors on an unknown tool", async () => {
    const { handle } = createMcpHandler([tool()], "foom");
    const res = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(res?.["error"]).toBeDefined();
  });
});

describe("mcp http server", () => {
  it("serves initialize + tools/call over real localhost HTTP", async () => {
    let executed: unknown;
    const server = await startMcpServer(
      [
        tool({
          execute: async (args) => {
            executed = args;
            return { content: "ok", isError: false };
          },
        }),
      ],
      "foom",
    );
    try {
      const post = (body: unknown) =>
        fetch(server.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      const init = (await post({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
        result: { serverInfo: { name: string } };
      };
      expect(init.result.serverInfo.name).toBe("foom");

      const call = (await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "foom_return", arguments: { value: 5 } },
      })) as { result: { content: Array<{ text: string }> } };
      expect(call.result.content[0]?.text).toBe("ok");
      expect(executed).toEqual({ value: 5 });
    } finally {
      await server.close();
    }
  });

  it("acknowledges a GET (SSE open) with 202 so the client falls back to POST", async () => {
    const server = await startMcpServer([tool()], "foom");
    try {
      const res = await fetch(server.url, { method: "GET" });
      expect(res.status).toBe(202);
    } finally {
      await server.close();
    }
  });
});
