import { DEFAULT_API_VERSION, PKG_NAME } from './config.js'
import { redactSecrets, type SfCredentials } from './auth.js'
import { isSessionExpired, type SessionRunner } from './session.js'
import { GatewayAuthError, type GatewaySession } from './gateway.js'

/**
 * Relay mode: forward JSON-RPC to an MCP gateway instead of calling Salesforce.
 *
 * In direct mode this package talks straight to Salesforce, which leaves the
 * traffic invisible to the gateway that is supposed to govern it: no activity
 * log, no scope enforcement, and read-only enforced by a client-side env var
 * the user can simply remove. Relay mode keeps the Salesforce refresh token on
 * the user's machine — the gateway stores no Salesforce credentials, by design
 * — while making the gateway the thing that actually executes the call.
 *
 * Two independent credentials ride along, each with its own refresh path:
 *
 *   Authorization: Bearer …    who the caller is, for scope checks and logging
 *   X-SF-Access-Token / …      which Salesforce data they may see
 *
 * The gateway reads the X-SF-* headers into a per-request injection and strips
 * them before writing its activity log, so the Salesforce token is never
 * persisted centrally.
 */

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** JSON-RPC error codes used for failures that happen inside the relay. */
const INTERNAL_ERROR = -32603

export function rpcError(id: JsonRpcMessage['id'], message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: INTERNAL_ERROR, message } }
}

/**
 * Salesforce's own wording for an expired session.
 *
 * Direct mode never needs this: jsforce raises an exception carrying
 * `errorCode: INVALID_SESSION_ID`, and `isSessionExpired` reads that field.
 * Across the relay the failure is a tool *result*, rendered by the server-side
 * child's `fail()`, which emits only `error.message` — so the code is gone and
 * the text reads simply "Session expired or invalid". Matching the wording is
 * what makes renewal work against children already deployed (the gateway pins
 * an older one), rather than only against versions we ship next.
 */
const EXPIRED_PHRASES = [/session expired/i, /invalid session/i]

/**
 * Does this gateway response mean the Salesforce token specifically is stale?
 *
 * The gateway answers 200 with an MCP tool error in that case — the HTTP call
 * succeeded, Salesforce is what rejected the credential — so the signal is in
 * the payload text, not the status code.
 *
 * Only errors qualify. A *successful* result may legitimately contain this
 * wording (describing a field named "Session Expired", say) and must never
 * trigger a refresh.
 */
export function looksSfExpired(message: JsonRpcMessage): boolean {
  const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined
  if (!result?.isError) return false
  const text = (result.content || [])
    .map((c) => c?.text || '')
    .join(' ')
    .slice(0, 4000)
  // Code first (exact), then wording (works against children that drop it).
  return isSessionExpired({ message: text }) || EXPIRED_PHRASES.some((re) => re.test(text))
}

export interface RelayDeps {
  relayUrl: string
  gateway: GatewaySession
  /** Supplies live Salesforce credentials, renewing them when they expire. */
  session: SessionRunner
  fetchImpl?: typeof fetch
}

/**
 * Forward one JSON-RPC request and return the gateway's reply.
 *
 * Each credential gets exactly one retry, and only for the failure that
 * credential can fix: a 401 renews the gateway token, an expired-session
 * payload renews the Salesforce token. Retrying more than once would just
 * hammer the far side with a credential that is not the problem.
 */
export async function relayRequest(
  message: JsonRpcMessage,
  deps: RelayDeps,
): Promise<JsonRpcMessage | null> {
  const doFetch = deps.fetchImpl ?? fetch

  const post = async (creds: SfCredentials, authorization: string): Promise<Response> =>
    doFetch(deps.relayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization,
        'x-sf-access-token': creds.accessToken,
        'x-sf-instance-url': creds.instanceUrl,
        'x-sf-api-version': creds.apiVersion || DEFAULT_API_VERSION,
      },
      body: JSON.stringify(message),
    })

  // The Salesforce retry is the outer loop: session.run renews the SF token and
  // replays the whole exchange, gateway retry included.
  return deps.session.run(async (creds) => {
    let authorization = await deps.gateway.authorization()
    let resp = await post(creds, authorization)

    if (resp.status === 401) {
      // The stored expiry is only a hint — a revoked or rotated grant shows up
      // here first. Renew once, then take the answer as final.
      authorization = await deps.gateway.renew()
      resp = await post(creds, authorization)
    }

    if (resp.status === 401) {
      throw new GatewayAuthError(
        'The LE gateway rejected this session even after renewing it. ' +
          `Run \`${PKG_NAME} login --gateway\` to sign in again.`,
      )
    }

    // NB: a gateway SCOPE denial does not arrive here. The gateway answers
    // 200 with a JSON-RPC error (-32003) on purpose, so clients show the reason
    // instead of hanging; that body is passed through verbatim below, which
    // already reads "Access denied: Missing required scope: …". This branch is
    // for a 403 from something in front of the gateway — a proxy or WAF — where
    // there is no JSON-RPC body to forward.
    if (resp.status === 403) {
      const detail = redactSecrets((await resp.text().catch(() => '')).slice(0, 500))
      throw new Error(`The gateway rejected this call with HTTP 403. ${detail}`.trim())
    }

    if (!resp.ok) {
      const detail = redactSecrets((await resp.text().catch(() => '')).slice(0, 500))
      throw new Error(`The LE gateway returned HTTP ${resp.status}. ${detail}`.trim())
    }

    // Notifications get an empty body: nothing to hand back to the client.
    const raw = await resp.text()
    if (!raw.trim()) return null

    let parsed: JsonRpcMessage
    try {
      parsed = JSON.parse(raw) as JsonRpcMessage
    } catch {
      throw new Error('The LE gateway returned a response that was not valid JSON.')
    }

    // Surface as a thrown session error so session.run does the SF refresh and
    // replays the call, exactly as direct mode does for a jsforce 401.
    if (looksSfExpired(parsed)) {
      throw { errorCode: 'INVALID_SESSION_ID', message: 'Relayed call reported an expired session' }
    }

    return parsed
  })
}

/**
 * Pump newline-delimited JSON-RPC from stdin to the gateway and back.
 *
 * A hand-rolled pump rather than an MCP Server instance: relay mode must not
 * interpret the protocol at all. Anything this package understood would have to
 * be kept in sync with whatever the gateway's copy of the server exposes, and
 * the two drifting is precisely the failure this is meant to avoid.
 */
export function startRelay(deps: RelayDeps): void {
  const write = (msg: JsonRpcMessage) => process.stdout.write(`${JSON.stringify(msg)}\n`)

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) void handleLine(line)
    }
  })

  async function handleLine(line: string): Promise<void> {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      write(rpcError(null, 'Invalid JSON'))
      return
    }

    // Notifications carry no id and expect no reply. Answering one would be a
    // protocol violation, so they are dropped rather than forwarded.
    const isRequest = message.id !== undefined && message.id !== null
    if (!isRequest) return

    try {
      const reply = await relayRequest(message, deps)
      if (reply) write(reply)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      write(rpcError(message.id, redactSecrets(raw)))
    }
  }
}
