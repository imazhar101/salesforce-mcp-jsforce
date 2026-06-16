import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { credsFromHeaders, MissingCredentialsError } from "./auth.js";
import { PKG_NAME, PKG_VERSION } from "./config.js";

const MCP_PATH = "/mcp";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Dedicated, stateless streamable-HTTP host. Every request brings its own
 * Salesforce token via headers, so we build a throwaway server + transport per
 * request — nothing about one caller leaks into another.
 *
 * Headers: X-SF-Access-Token, X-SF-Instance-Url (X-SF-Api-Version optional).
 */
export async function startHttp(port: number): Promise<void> {
  const server = http.createServer(async (req, res) => {
    // Liveness probe for load balancers / container health checks.
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { status: "ok", name: PKG_NAME, version: PKG_VERSION });
    }

    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      return send(res, 404, { error: "Not found" });
    }

    if (req.method !== "POST") {
      // Stateless mode does not support the GET/DELETE session endpoints.
      return send(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed; POST to /mcp" },
        id: null,
      });
    }

    const creds = credsFromHeaders(req.headers);
    if (!creds) {
      return send(res, 401, {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Missing credentials. Provide X-SF-Access-Token and X-SF-Instance-Url headers.",
        },
        id: null,
      });
    }

    try {
      const body = await readBody(req);
      // Stateless: a fresh server + transport per request, no session id.
      const mcp = buildServer(() => {
        if (!creds) throw new MissingCredentialsError("No credentials");
        return creds;
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
          id: null,
        });
      }
    }
  });

  server.listen(port, () => {
    console.error(
      `${PKG_NAME} v${PKG_VERSION} listening on http://0.0.0.0:${port}${MCP_PATH} (stateless, BYO token)`
    );
  });
}
