import os from 'node:os'
import path from 'node:path'

/** Package identity (kept in sync with package.json). */
export const PKG_NAME = 'salesforce-mcp-jsforce'
export const PKG_VERSION = '0.5.1'

/** Salesforce REST API version used for all jsforce connections. */
export const DEFAULT_API_VERSION = process.env.SF_API_VERSION || '62.0'

/**
 * OAuth login host. Production: https://login.salesforce.com.
 * Sandbox: https://test.salesforce.com (or your My Domain URL).
 */
export const DEFAULT_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com'

/** Where the `login` command persists the issued token for stdio use. */
export const CONFIG_DIR =
  process.env.SF_MCP_CONFIG_DIR || path.join(os.homedir(), '.config', PKG_NAME)
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json')

/**
 * Relay mode. When set, this server stops calling Salesforce itself and
 * forwards every JSON-RPC request to an MCP gateway route, attaching the
 * caller's Salesforce credentials as X-SF-* headers. The gateway then runs the
 * real server, so the call is authenticated, scope-checked and logged centrally
 * instead of leaving the machine untracked.
 *
 * Direct mode (unset) is unchanged — relay is purely additive.
 */
export const RELAY_URL = process.env.SF_RELAY_URL || ''

/** Gateway OAuth tokens, kept beside the Salesforce token and equally secret. */
export const GATEWAY_TOKEN_FILE = path.join(CONFIG_DIR, 'gateway.json')

/**
 * Loopback port for the gateway sign-in. Deliberately not the Salesforce
 * callback port (1717): the two logins run back to back during onboarding, and
 * a lingering listener from one must not collide with the other.
 */
export const GATEWAY_CALLBACK_PORT = Number(process.env.SF_GATEWAY_CALLBACK_PORT || 1718)

/** How long `login` waits for the browser round trip before giving up. */
export const LOGIN_TIMEOUT_MS = Number(process.env.SF_LOGIN_TIMEOUT_MS || 5 * 60 * 1000)

/**
 * Read-only mode strips all write tools (create/update/delete). Recommended
 * for the publicly hosted server. Set SF_READONLY=1 to enable.
 */
export const READ_ONLY = process.env.SF_READONLY === '1' || process.env.SF_READONLY === 'true'

/**
 * HTTP transport bind address. Loopback by default: this server authenticates
 * nobody itself — it forwards whatever token a request carries — so exposing it
 * beyond the host must be deliberate (SF_MCP_HOST=0.0.0.0) and paired with a
 * fronting proxy that does authenticate.
 */
export const HTTP_HOST = process.env.SF_MCP_HOST || '127.0.0.1'

/** Largest JSON-RPC body accepted, to bound memory use on a listener. */
export const HTTP_MAX_BODY_BYTES = Number(process.env.SF_MCP_MAX_BODY_BYTES || 1024 * 1024)

/**
 * Extra hostnames accepted in the Host/Origin headers. Loopback names are
 * always allowed; this guards a local listener against DNS rebinding from a
 * page in the user's browser. Add your public hostname when behind a proxy.
 */
export const HTTP_ALLOWED_HOSTS = (process.env.SF_MCP_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
