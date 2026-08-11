import { redactSecrets, type SfCredentials } from './auth.js'

/**
 * Credentials complete enough to run the `refresh_token` grant. `login` saves
 * all three; env-var and per-request BYO credentials carry none of them, which
 * is why those callers keep owning their own token lifecycle.
 */
export type RefreshableCreds = SfCredentials & {
  refreshToken: string
  clientId: string
  loginUrl: string
}

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

export class RefreshFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshFailedError'
  }
}

/** Salesforce error codes that mean "this access token is no longer usable". */
const EXPIRED_CODES = ['INVALID_SESSION_ID', 'INVALID_LOGIN', 'INVALID_AUTH_HEADER']

export function isSessionExpired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { errorCode?: unknown; name?: unknown; status?: unknown; message?: unknown }
  const code =
    typeof e.errorCode === 'string' ? e.errorCode : typeof e.name === 'string' ? e.name : ''
  if (EXPIRED_CODES.includes(code)) return true
  if (e.status === 401) return true
  // jsforce sometimes only puts the code in the message text.
  const message = typeof e.message === 'string' ? e.message : ''
  return EXPIRED_CODES.some((c) => message.includes(c))
}

export function canRefresh(creds: SfCredentials): creds is RefreshableCreds {
  return Boolean(creds.refreshToken && creds.clientId && creds.loginUrl)
}

/**
 * Exchange the stored refresh token for a new access token. Salesforce does not
 * rotate refresh tokens on this grant, so the stored one stays valid until the
 * user revokes it or an admin expires it — which is what makes silent renewal
 * possible in the first place.
 */
export async function refreshAccessToken(creds: RefreshableCreds): Promise<SfCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
  })
  // Public PKCE clients have no secret; only send one if the user configured it.
  if (creds.clientSecret) body.set('client_secret', creds.clientSecret)

  let resp: Response
  try {
    resp = await fetch(`${creds.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (e) {
    throw new RefreshFailedError(
      `Could not reach Salesforce to renew the session (${redactSecrets(
        e instanceof Error ? e.message : String(e),
      )}). Check your network, then run \`salesforce-mcp-jsforce login\` if it persists.`,
    )
  }

  const json = (await resp.json().catch(() => ({}))) as Record<string, string>
  if (!resp.ok || !json.access_token) {
    // error_description can echo back what we sent, so redact before surfacing.
    throw new RefreshFailedError(
      `Salesforce refused to renew the session (${redactSecrets(
        json.error ?? String(resp.status),
      )}). The grant was probably revoked or expired — run \`salesforce-mcp-jsforce login\` to sign in again.`,
    )
  }

  return {
    ...creds,
    accessToken: json.access_token,
    // Salesforce returns instance_url on refresh; adopt it so an org move or
    // My Domain change does not silently strand us on the old host.
    instanceUrl: json.instance_url || creds.instanceUrl,
  }
}

export interface SessionRunner {
  /** Run `fn` with live credentials, renewing and retrying once if expired. */
  run<T>(fn: (creds: SfCredentials) => Promise<T>): Promise<T>
}

/**
 * Wrap credential resolution with transparent renewal.
 *
 * `resolve` is consulted until the first successful refresh, after which the
 * renewed credentials are held in memory for the life of the process — the
 * point is that a long-lived stdio server outlives its access token.
 *
 * `persist` writes the renewed credentials back so sibling processes (Claude
 * Desktop alongside the CLI, or the next cold start) skip the round trip.
 * Concurrent expiries share a single refresh; a second expiry after a
 * successful renewal is a real failure and surfaces to the caller.
 */
export function createSessionRunner(
  resolve: () => SfCredentials,
  persist: (creds: SfCredentials) => void,
): SessionRunner {
  let current: SfCredentials | null = null
  let inFlight: Promise<SfCredentials> | null = null

  const creds = () => current ?? resolve()

  const renew = (stale: SfCredentials): Promise<SfCredentials> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      if (!canRefresh(stale)) {
        throw new SessionExpiredError(
          'The Salesforce session has expired and there is no refresh token to renew it with. ' +
            'Run `salesforce-mcp-jsforce login` (or supply a fresh token) and try again.',
        )
      }
      const next = await refreshAccessToken(stale)
      current = next
      try {
        persist(next)
      } catch {
        // A read-only or unwritable config dir must not break the live call.
      }
      return next
    })()
    try {
      return inFlight
    } finally {
      // Clear on settle so a later expiry can refresh again.
      inFlight.catch(() => {}).finally(() => (inFlight = null))
    }
  }

  return {
    async run<T>(fn: (c: SfCredentials) => Promise<T>): Promise<T> {
      const first = creds()
      try {
        return await fn(first)
      } catch (err) {
        if (!isSessionExpired(err)) throw err
        const renewed = await renew(first)
        // One retry only: if the fresh token is rejected too, the problem is not
        // token age and a retry loop would just hammer Salesforce.
        return await fn(renewed)
      }
    },
  }
}
