import { describe, expect, it } from "vitest";
import { startMcpToolServer } from "../src/mcp.ts";

describe("ephemeral MCP tool server security", () => {
  it("rejects unauthenticated requests and unknown paths", async () => {
    const server = await startMcpToolServer([]);
    try {
      const unauthenticated = await fetch(server.url, { method: "POST" });
      const unknownPath = await fetch(new URL("/other", server.url), {
        method: "POST",
        headers: { Authorization: server.authorizationHeader },
      });

      expect(unauthenticated.status).toBe(401);
      expect(unknownPath.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("rejects DNS-rebound Host headers even with the bearer token", async () => {
    const server = await startMcpToolServer([]);
    try {
      const target = new URL(server.url);
      const status = await new Promise<number | undefined>((resolveStatus, reject) => {
        const outgoing = request(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: "POST",
            headers: {
              Authorization: server.authorizationHeader,
              Host: "attacker.example",
              "Content-Type": "application/json",
            },
          },
          (response) => {
            response.resume();
            resolveStatus(response.statusCode);
          },
        );
        outgoing.once("error", reject);
        outgoing.end("{}");
      });

      expect(status).toBe(421);
    } finally {
      await server.close();
    }
  });
});

import { request } from "node:http";
