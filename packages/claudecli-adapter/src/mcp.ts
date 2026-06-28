// An in-process Streamable-HTTP MCP server exposing this turn's FOOM tools. It
// runs INSIDE the program's process — so a tool's `execute` is the real core
// closure over the live program state — and Claude Code (the subprocess) connects
// back over localhost to call them. A stdio MCP server can't do this: it would be
// a separate process with no access to the running program.
//
// Only the minimal JSON-RPC subset Claude Code drives is implemented: initialize,
// tools/list, tools/call (verified against the real CLI). Tools are registered
// under their CANONICAL basenames (Claude Code adds the `mcp__<server>__` prefix
// itself); only the description text is renamed so its references match what the
// model sees.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { NeutralToolDef } from "@microfoom/core";
import { applyRename } from "./rename.js";

/** The protocol version we echo back; Claude Code negotiates from its own. */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/** Fold a tool's optional usage blurb + guideline bullets into the one
 *  model-native field an MCP tool has — its description. (Claude Code MCP tools
 *  carry no separate promptSnippet slot.) */
function toolDescription(tool: NeutralToolDef): string {
  const parts = [tool.description];
  if (tool.promptSnippet !== undefined) parts.push(tool.promptSnippet);
  if (tool.promptGuidelines !== undefined && tool.promptGuidelines.length > 0) {
    parts.push(["Guidelines:", ...tool.promptGuidelines.map((rule) => `- ${rule}`)].join("\n"));
  }
  return parts.join("\n\n");
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** A live MCP endpoint for one turn. */
export interface McpServerHandle {
  /** The URL Claude Code is pointed at via `--mcp-config`. */
  readonly url: string;
  /** True once a tool signalled a terminal outcome (foom_return / foom_throw). */
  terminated(): boolean;
  /** Shut the server down, force-closing any lingering keep-alive sockets. */
  close(): Promise<void>;
}

/** The pure JSON-RPC handler, transport-free so tests can drive it without a
 *  socket. Returns the response object, or `null` for a notification (no reply). */
export function createMcpHandler(
  tools: readonly NeutralToolDef[],
  serverName: string,
): {
  handle: (request: JsonRpcRequest) => Promise<Record<string, unknown> | null>;
  terminated: () => boolean;
} {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const names = tools.map((tool) => tool.name);
  let didTerminate = false;

  const listing = tools.map((tool) => ({
    name: tool.name,
    description: applyRename(toolDescription(tool), names, serverName),
    inputSchema: tool.parameters,
  }));

  // Dispatch a `tools/call`: look up the tool, run it, and map its result (or an
  // unknown-tool error) back to a JSON-RPC response. Flips the terminate latch.
  const callTool = async (request: JsonRpcRequest): Promise<Record<string, unknown>> => {
    const id = request.id ?? null;
    const params = request.params ?? {};
    const tool = byName.get(params.name as string);
    if (tool === undefined) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${String(params.name)}` },
      };
    }
    const result = await tool.execute(params.arguments ?? {});
    if (result.terminate === true) didTerminate = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      },
    };
  };

  const handle = async (request: JsonRpcRequest): Promise<Record<string, unknown> | null> => {
    const id = request.id ?? null;
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              (request.params?.protocolVersion as string | undefined) ?? FALLBACK_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: "0.0.0" },
          },
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listing } };
      case "tools/call":
        return callTool(request);
      default:
        // Notifications (no id) get no reply; unknown requests get method-not-found.
        if (request.id === undefined || request.id === null) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
    }
  };

  return { handle, terminated: () => didTerminate };
}

/** Read a whole request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Start the HTTP MCP server on an ephemeral localhost port for this turn. */
export async function startMcpServer(
  tools: readonly NeutralToolDef[],
  serverName: string,
): Promise<McpServerHandle> {
  const { handle, terminated } = createMcpHandler(tools, serverName);

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Only POST carries JSON-RPC; GET (SSE open) / DELETE / empty bodies are
      // acknowledged with 202 so the client proceeds over plain request/response.
      if (req.method !== "POST") {
        res.writeHead(202).end();
        return;
      }
      const body = await readBody(req);
      if (body.trim() === "") {
        res.writeHead(202).end();
        return;
      }
      let response: Record<string, unknown> | null;
      try {
        response = await handle(JSON.parse(body) as JsonRpcRequest);
      } catch (error) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: String(error) },
          }),
        );
        return;
      }
      if (response === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    terminated,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
