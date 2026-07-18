import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer as ProtocolServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackendTool } from "./backend.js";

/** Ephemeral Streamable HTTP MCP endpoint exposing one Unigent turn's tools. */
interface McpToolServer {
  readonly url: string;
  readonly authorizationHeader: string;
  readonly close: () => Promise<void>;
}

const METHOD_NOT_ALLOWED = 405;
const MISDIRECTED_REQUEST = 421;
const NOT_FOUND = 404;
const UNAUTHORIZED = 401;
const INTERNAL_SERVER_ERROR = 500;
const TOKEN_BYTES = 32;

function authorized(request: IncomingMessage, token: Buffer): boolean {
  const supplied = request.headers.authorization;
  const prefix = "Bearer ";
  if (supplied?.startsWith(prefix) !== true) {
    return false;
  }
  const candidate = Buffer.from(supplied.slice(prefix.length), "base64url");
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

function registerTools(server: ProtocolServer, tools: readonly BackendTool[]): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async () =>
      await Promise.resolve({
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      }),
  );
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const tool = byName.get(request.params.name);
      if (tool === undefined) {
        return {
          content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
          isError: true,
        };
      }
      const result = await tool.execute(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      };
    },
  );
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_603, message },
    }),
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  tools: readonly BackendTool[],
  allowedHost: string,
): Promise<void> {
  const mcp = new ProtocolServer(
    { name: "unigent", version: "0.1.6" },
    { capabilities: { tools: {} } },
  );
  registerTools(mcp, tools);
  const options = {
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [allowedHost],
  } satisfies StreamableHTTPServerTransportOptions;
  const transport = new StreamableHTTPServerTransport(options);
  try {
    // The SDK's optional callback properties do not satisfy exactOptionalPropertyTypes.
    await mcp.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response);
  } finally {
    await mcp.close();
  }
}

/** Start an isolated MCP server for a single backend turn. */
async function startMcpToolServer(tools: readonly BackendTool[]): Promise<McpToolServer> {
  const token = randomBytes(TOKEN_BYTES);
  const authorizationHeader = `Bearer ${token.toString("base64url")}`;
  let allowedHost = "";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== "/mcp") {
      sendError(response, NOT_FOUND, "not found");
      return;
    }
    if (request.method !== "POST") {
      sendError(response, METHOD_NOT_ALLOWED, "method not allowed");
      return;
    }
    if (request.headers.host !== allowedHost) {
      sendError(response, MISDIRECTED_REQUEST, "invalid host");
      return;
    }
    if (!authorized(request, token)) {
      sendError(response, UNAUTHORIZED, "unauthorized");
      return;
    }
    handleRequest(request, response, tools, allowedHost).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
      } else {
        sendError(response, INTERNAL_SERVER_ERROR, String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  allowedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${allowedHost}/mcp`,
    authorizationHeader,
    close: async (): Promise<void> => await closeServer(server),
  };
}

export type { McpToolServer };
export { startMcpToolServer };
