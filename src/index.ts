#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'
import { READ_ONLY, PKG_NAME, PKG_VERSION, RELAY_URL } from './config.js'
import { redactSecrets, resolveStdioCredentials, saveToken } from './auth.js'
import { runLogin, runLogout } from './oauth.js'
import { startHttp } from './http.js'
import { startRelay } from './relay.js'
import { createSessionRunner } from './session.js'
import {
  assertSafeGatewayUrl,
  createGatewaySession,
  deleteGatewayTokens,
  gatewayLogin,
} from './gateway.js'

async function runStdio(): Promise<void> {
  // Credentials are resolved lazily per tool call, so `tools/list` works even
  // before a token is configured. `saveToken` is the persist hook: when the
  // access token expires, the renewed one is written back so the next process
  // (and any sibling client) starts from a live token.
  const server = buildServer(() => resolveStdioCredentials(), READ_ONLY, saveToken)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`${PKG_NAME} v${PKG_VERSION} ready (stdio)`)
}

/**
 * Relay mode. No tools are registered locally — every request is forwarded to
 * the gateway, which runs the real server and applies its own read-only policy,
 * scope checks and activity logging.
 */
function runRelay(): void {
  startRelay({
    relayUrl: assertSafeGatewayUrl(RELAY_URL),
    gateway: createGatewaySession(),
    session: createSessionRunner(() => resolveStdioCredentials(), saveToken),
  })
  console.error(`${PKG_NAME} v${PKG_VERSION} ready (relay → ${RELAY_URL})`)
}

/**
 * Which gateway `login --gateway` targets: an explicit --relay-url, else the
 * configured relay. Onboarding sets SF_RELAY_URL, so the flag is rarely needed.
 */
function relayUrlFrom(argv: string[]): string {
  const i = argv.indexOf('--relay-url')
  const explicit = i >= 0 ? argv[i + 1] : undefined
  const url = explicit || RELAY_URL
  if (!url) {
    throw new Error(
      'No gateway configured. Set SF_RELAY_URL or pass --relay-url <https://gateway/mcp/le-salesforce>.',
    )
  }
  return url
}

function printHelp(): void {
  console.error(`${PKG_NAME} v${PKG_VERSION}

Usage:
  salesforce-mcp-jsforce               Run the MCP server over stdio (default)
  salesforce-mcp-jsforce http          Run the dedicated streamable-HTTP server
  salesforce-mcp-jsforce login         OAuth login (PKCE) and save a token
  salesforce-mcp-jsforce login --gateway
                                       Sign in to the MCP gateway used by relay
                                       mode (--relay-url to override the target)
  salesforce-mcp-jsforce logout        Revoke the grant and delete the token
                                       (--local-only to skip the revoke,
                                        --gateway to drop the gateway token)

stdio credentials (one of):
  SF_ACCESS_TOKEN + SF_INSTANCE_URL    environment variables (cannot be renewed)
  ~/.config/${PKG_NAME}/token.json     written by \`login\`, renewed automatically

http credentials (per request):
  X-SF-Access-Token, X-SF-Instance-Url headers

relay mode (route calls through an MCP gateway instead of calling Salesforce):
  SF_RELAY_URL           e.g. https://conduit.example.com/mcp/le-salesforce
                         Requires \`login\` (Salesforce) and \`login --gateway\`.

Common env:
  SF_API_VERSION         default 62.0
  SF_READONLY=1          disable create/update/delete tools
  SF_LOGIN_URL           default https://login.salesforce.com (sandbox: test.salesforce.com)
  SF_MCP_CONFIG_DIR      where the token is stored
  SF_MCP_HOST            http bind address, default 127.0.0.1
  SF_MCP_ALLOWED_HOSTS   extra Host/Origin values accepted by the http server
`)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)

  switch (cmd) {
    case 'login':
      // `login --gateway` signs in to the MCP gateway; without it, Salesforce.
      // Relay mode needs both, and they are independent grants.
      if (rest.includes('--gateway')) {
        await gatewayLogin(assertSafeGatewayUrl(relayUrlFrom(rest)))
        console.error('\n✓ Signed in to the LE gateway. Relayed calls are now authorized.\n')
        process.exit(0)
      }
      await runLogin(rest)
      // The OAuth callback server can leave a keep-alive socket open, which
      // keeps the event loop alive and hangs the CLI. Exit explicitly.
      process.exit(0)
    case 'logout':
      if (rest.includes('--gateway')) {
        console.error(
          deleteGatewayTokens()
            ? '✓ Removed the stored gateway token'
            : '! No stored gateway token to remove',
        )
        process.exit(0)
      }
      await runLogout(rest)
      process.exit(0)
    case 'http': {
      const port = Number(process.env.PORT || rest[0] || 3000)
      await startHttp(port)
      return
    }
    case '-h':
    case '--help':
      printHelp()
      return
    default:
      if (process.env.SF_MCP_TRANSPORT === 'http') {
        await startHttp(Number(process.env.PORT || 3000))
        return
      }
      if (RELAY_URL) {
        runRelay()
        return
      }
      await runStdio()
  }
}

main().catch((err) => {
  // Redacted: a failed token exchange can carry credential material.
  console.error(`Fatal: ${redactSecrets(err instanceof Error ? err.message : String(err))}`)
  process.exit(1)
})
