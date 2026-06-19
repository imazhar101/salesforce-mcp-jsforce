#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { resolveStdioCredentials } from "./auth.js";
import { runLogin } from "./oauth.js";
import { startHttp } from "./http.js";
import { PKG_NAME, PKG_VERSION } from "./config.js";

async function runStdio(): Promise<void> {
  // Credentials are resolved lazily per tool call, so `tools/list` works even
  // before a token is configured.
  const server = buildServer(() => resolveStdioCredentials());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${PKG_NAME} v${PKG_VERSION} ready (stdio)`);
}

function printHelp(): void {
  console.error(`${PKG_NAME} v${PKG_VERSION}

Usage:
  salesforce-mcp-jsforce               Run the MCP server over stdio (default)
  salesforce-mcp-jsforce http          Run the dedicated streamable-HTTP server
  salesforce-mcp-jsforce login         OAuth login (PKCE) and save a token

stdio credentials (one of):
  SF_ACCESS_TOKEN + SF_INSTANCE_URL    environment variables
  ~/.config/${PKG_NAME}/token.json     written by \`login\`

http credentials (per request):
  X-SF-Access-Token, X-SF-Instance-Url headers

Common env:
  SF_API_VERSION   default 62.0
  SF_READONLY=1    disable create/update/delete tools
  SF_LOGIN_URL     default https://login.salesforce.com (sandbox: test.salesforce.com)
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "login":
      await runLogin(rest);
      // The OAuth callback server can leave a keep-alive socket open, which
      // keeps the event loop alive and hangs the CLI. Exit explicitly.
      process.exit(0);
    case "http": {
      const port = Number(process.env.PORT || rest[0] || 3000);
      await startHttp(port);
      return;
    }
    case "-h":
    case "--help":
      printHelp();
      return;
    default:
      if (process.env.SF_MCP_TRANSPORT === "http") {
        await startHttp(Number(process.env.PORT || 3000));
        return;
      }
      await runStdio();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
