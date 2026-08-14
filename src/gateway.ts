import crypto from 'node:crypto'
import fs from 'node:fs'
import { URL } from 'node:url'
import { GATEWAY_TOKEN_FILE, GATEWAY_CALLBACK_PORT, LOGIN_TIMEOUT_MS } from './config.js'
import { redactSecrets, writeSecretFile } from './auth.js'
import { awaitAuthorizationCode, buildRedirectUri } from './loopback.js'

/**
 * OAuth client for an MCP gateway that fronts this server.
 *
 * The gateway is a standard authorization server (RFC 8414 discovery, RFC 7591
 * dynamic registration, authorization_code + refresh_token grants, PKCE, and a
 * loopback redirect). Nothing here is gateway-specific beyond that, so a
 * different conformant gateway works with only a URL change.
 */

export interface GatewayTokens {
  accessToken: string
  refreshToken?: string
  /** Issued by dynamic registration; needed to refresh with some servers. */
  clientId?: string
  /** Issuer origin these tokens belong to — a guard against reusing them elsewhere. */
  issuer: string
  /** Absolute ms epoch, when the server told us. Absent means "unknown". */
  expiresAt?: number
}

export interface GatewayEndpoints {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
}

export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayAuthError'
  }
}

/**
 * The gateway holds the identity that authorizes every relayed call, so the
 * exchange must not happen in the clear. Loopback is allowed because tests and
 * local gateways run there and never leave the machine.
 */
export function assertSafeGatewayUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new GatewayAuthError(`Invalid gateway URL: ${raw}`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) {
    throw new GatewayAuthError(
      `Gateway URL must be https (got ${url.protocol.replace(':', '')}): ${raw}`,
    )
  }
  return url.toString()
}

/** Origin of a relay URL — `https://host/mcp/le-salesforce` → `https://host`. */
export function issuerOf(relayUrl: string): string {
  return new URL(assertSafeGatewayUrl(relayUrl)).origin
}

export async function discoverEndpoints(issuer: string): Promise<GatewayEndpoints> {
  const wellKnown = `${issuer}/.well-known/oauth-authorization-server`
  let resp: Response
  try {
    resp = await fetch(wellKnown)
  } catch (e) {
    throw new GatewayAuthError(
      `Could not reach the gateway at ${issuer} (${redactSecrets(
        e instanceof Error ? e.message : String(e),
      )}). Check your network or VPN and try again.`,
    )
  }
  if (!resp.ok) {
    throw new GatewayAuthError(
      `The gateway at ${issuer} did not publish OAuth metadata (HTTP ${resp.status} from ${wellKnown}).`,
    )
  }
  const doc = (await resp.json().catch(() => ({}))) as Record<string, string>
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new GatewayAuthError(
      `The gateway's OAuth metadata is missing an authorization or token endpoint.`,
    )
  }
  return {
    issuer: doc.issuer || issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    registrationEndpoint: doc.registration_endpoint,
  }
}

/**
 * Register as a public client. The gateway stores nothing and hands back an
 * identifier for protocol shape only — PKCE and the redirect allowlist are the
 * real boundary — so a registration failure is non-fatal.
 */
async function registerClient(
  endpoints: GatewayEndpoints,
  redirectUri: string,
): Promise<string | undefined> {
  if (!endpoints.registrationEndpoint) return undefined
  try {
    const resp = await fetch(endpoints.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'salesforce-mcp-jsforce (relay)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    if (!resp.ok) return undefined
    const doc = (await resp.json().catch(() => ({}))) as Record<string, string>
    return doc.client_id || undefined
  } catch {
    return undefined
  }
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function tokensFrom(
  json: Record<string, string | number>,
  issuer: string,
  clientId: string | undefined,
  previous?: GatewayTokens,
): GatewayTokens {
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: String(json.access_token),
    // Servers that rotate refresh tokens send a new one; those that don't
    // expect the original to keep working, so never drop what we already hold.
    refreshToken: (json.refresh_token as string) || previous?.refreshToken,
    clientId: clientId || previous?.clientId,
    issuer,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
  }
}

/** Run the browser sign-in against the gateway and persist the result. */
export async function gatewayLogin(relayUrl: string): Promise<GatewayTokens> {
  const issuer = issuerOf(relayUrl)
  const endpoints = await discoverEndpoints(issuer)
  const redirectUri = buildRedirectUri(undefined, GATEWAY_CALLBACK_PORT)
  const clientId = await registerClient(endpoints, redirectUri)
  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(16).toString('hex')

  const authUrl = new URL(endpoints.authorizationEndpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  if (clientId) authUrl.searchParams.set('client_id', clientId)

  const code = await awaitAuthorizationCode({
    authUrl: authUrl.toString(),
    redirectUri,
    port: GATEWAY_CALLBACK_PORT,
    state,
    timeoutMs: LOGIN_TIMEOUT_MS,
    label: 'LE gateway',
  })

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  if (clientId) body.set('client_id', clientId)

  const resp = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await resp.json().catch(() => ({}))) as Record<string, string>
  if (!resp.ok || !json.access_token) {
    throw new GatewayAuthError(
      `Gateway token exchange failed: ${redactSecrets(
        json.error ?? String(resp.status),
      )} ${redactSecrets(json.error_description ?? '')}`.trim(),
    )
  }

  const tokens = tokensFrom(json, endpoints.issuer, clientId)
  saveGatewayTokens(tokens)
  return tokens
}

export async function refreshGatewayToken(
  tokens: GatewayTokens,
  endpoints?: GatewayEndpoints,
): Promise<GatewayTokens> {
  if (!tokens.refreshToken) {
    throw new GatewayAuthError(
      'The gateway session expired and there is no refresh token to renew it with. ' +
        'Run `salesforce-mcp-jsforce login --gateway` to sign in again.',
    )
  }
  const eps = endpoints ?? (await discoverEndpoints(tokens.issuer))
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  })
  if (tokens.clientId) body.set('client_id', tokens.clientId)

  let resp: Response
  try {
    resp = await fetch(eps.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (e) {
    throw new GatewayAuthError(
      `Could not reach the gateway to renew the session (${redactSecrets(
        e instanceof Error ? e.message : String(e),
      )}).`,
    )
  }
  const json = (await resp.json().catch(() => ({}))) as Record<string, string>
  if (!resp.ok || !json.access_token) {
    throw new GatewayAuthError(
      `The gateway refused to renew the session (${redactSecrets(json.error ?? String(resp.status))}). ` +
        'Run `salesforce-mcp-jsforce login --gateway` to sign in again.',
    )
  }
  const next = tokensFrom(json, tokens.issuer, tokens.clientId, tokens)
  try {
    saveGatewayTokens(next)
  } catch {
    // An unwritable config dir must not break the live call.
  }
  return next
}

export function loadGatewayTokens(): GatewayTokens | null {
  try {
    const data = JSON.parse(fs.readFileSync(GATEWAY_TOKEN_FILE, 'utf8')) as Partial<GatewayTokens>
    if (!data.accessToken || !data.issuer) return null
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      clientId: data.clientId,
      issuer: data.issuer,
      expiresAt: data.expiresAt,
    }
  } catch {
    return null
  }
}

/** Holds a long-lived refresh token, so it gets the same 0600 treatment. */
export function saveGatewayTokens(tokens: GatewayTokens): void {
  writeSecretFile(GATEWAY_TOKEN_FILE, JSON.stringify(tokens, null, 2))
}

export function deleteGatewayTokens(): boolean {
  try {
    fs.unlinkSync(GATEWAY_TOKEN_FILE)
    return true
  } catch {
    return false
  }
}

export interface GatewaySession {
  /** Current bearer value, refreshing first if it is known to be expired. */
  authorization(): Promise<string>
  /** Force a refresh after the gateway rejected the current token. */
  renew(): Promise<string>
}

/**
 * Bearer-token lifecycle for relay mode.
 *
 * Tokens are refreshed proactively when the stored expiry has passed, and
 * reactively when the gateway answers 401 — the expiry is only a hint, and a
 * revoked grant produces a 401 long before it lapses.
 */
export function createGatewaySession(
  load: () => GatewayTokens | null = loadGatewayTokens,
  refresh: (t: GatewayTokens) => Promise<GatewayTokens> = refreshGatewayToken,
): GatewaySession {
  let current: GatewayTokens | null = null
  let inFlight: Promise<GatewayTokens> | null = null

  const held = (): GatewayTokens => {
    const tokens = current ?? load()
    if (!tokens) {
      throw new GatewayAuthError(
        'Not signed in to the LE gateway. Run `salesforce-mcp-jsforce login --gateway` first.',
      )
    }
    current = tokens
    return tokens
  }

  // Treat a token as expired slightly early: a call that starts inside the
  // window would otherwise arrive just after expiry and fail for no reason.
  const EXPIRY_SKEW_MS = 30_000

  const renew = (stale: GatewayTokens): Promise<GatewayTokens> => {
    if (inFlight) return inFlight
    inFlight = refresh(stale).then((next) => {
      current = next
      return next
    })
    try {
      return inFlight
    } finally {
      inFlight.catch(() => {}).finally(() => (inFlight = null))
    }
  }

  return {
    async authorization(): Promise<string> {
      let tokens = held()
      if (tokens.expiresAt && Date.now() + EXPIRY_SKEW_MS >= tokens.expiresAt) {
        tokens = await renew(tokens)
      }
      return `Bearer ${tokens.accessToken}`
    },
    async renew(): Promise<string> {
      const tokens = await renew(held())
      return `Bearer ${tokens.accessToken}`
    },
  }
}
