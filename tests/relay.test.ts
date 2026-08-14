import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { relayRequest, looksSfExpired, rpcError, type RelayDeps } from '../src/relay.ts'
import { createSessionRunner } from '../src/session.ts'
import type { SfCredentials } from '../src/auth.ts'

const RELAY_URL = 'https://gateway.example.com/mcp/le-salesforce'

const CREDS: SfCredentials = {
  accessToken: '00Dxx0000001gPF!SUPERSECRETSESSIONID',
  instanceUrl: 'https://example.my.salesforce.com',
  apiVersion: '62.0',
}

const REFRESHABLE: SfCredentials = {
  ...CREDS,
  refreshToken: '5AepFakeRefreshToken',
  clientId: 'client-abc',
  loginUrl: 'https://example.my.salesforce.com',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A gateway session with scripted tokens, recording how often it renewed. */
function fakeGateway(tokens = ['tok-1', 'tok-2']) {
  let i = 0
  const calls = { authorization: 0, renew: 0 }
  return {
    calls,
    session: {
      async authorization() {
        calls.authorization++
        return `Bearer ${tokens[i]}`
      },
      async renew() {
        calls.renew++
        i = Math.min(i + 1, tokens.length - 1)
        return `Bearer ${tokens[i]}`
      },
    },
  }
}

function deps(
  fetchImpl: typeof fetch,
  opts: { creds?: SfCredentials; gatewayTokens?: string[] } = {},
): RelayDeps & { gatewayCalls: { authorization: number; renew: number } } {
  const gw = fakeGateway(opts.gatewayTokens)
  return {
    relayUrl: RELAY_URL,
    gateway: gw.session,
    session: createSessionRunner(
      () => opts.creds ?? CREDS,
      () => {},
    ),
    fetchImpl,
    gatewayCalls: gw.calls,
  }
}

const REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soql_query' } }

describe('relayRequest', () => {
  test('forwards to the gateway with both credentials attached', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    }) as unknown as typeof fetch

    const reply = await relayRequest(REQUEST, deps(fetchImpl))

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, RELAY_URL)
    const headers = seen[0].init.headers as Record<string, string>
    assert.equal(headers.authorization, 'Bearer tok-1')
    assert.equal(headers['x-sf-access-token'], CREDS.accessToken)
    assert.equal(headers['x-sf-instance-url'], CREDS.instanceUrl)
    assert.equal(headers['x-sf-api-version'], '62.0')
    // The body is passed through untouched — the relay never interprets it.
    assert.deepEqual(JSON.parse(seen[0].init.body as string), REQUEST)
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { content: [] } })
  })

  test('renews the gateway token once on 401 and retries', async () => {
    const tokensUsed: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      tokensUsed.push(headers.authorization)
      if (tokensUsed.length === 1) return new Response('unauthorized', { status: 401 })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    }) as unknown as typeof fetch

    const d = deps(fetchImpl)
    const reply = await relayRequest(REQUEST, d)

    assert.deepEqual(tokensUsed, ['Bearer tok-1', 'Bearer tok-2'])
    assert.equal(d.gatewayCalls.renew, 1)
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { ok: true } })
  })

  test('gives up after a second 401 rather than looping', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof fetch

    await assert.rejects(() => relayRequest(REQUEST, deps(fetchImpl)), /login --gateway/)
    assert.equal(calls, 2)
  })

  test('explains a 403 as a missing scope', async () => {
    const fetchImpl = (async () =>
      new Response('Access denied: Missing required scope: le-salesforce:soql_query', {
        status: 403,
      })) as unknown as typeof fetch

    await assert.rejects(
      () => relayRequest(REQUEST, deps(fetchImpl)),
      /not scoped for le-salesforce/,
    )
  })

  test('refreshes Salesforce and replays when the gateway reports an expired session', async () => {
    const sfTokensUsed: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      sfTokensUsed.push(headers['x-sf-access-token'])
      if (sfTokensUsed.length === 1) {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'INVALID_SESSION_ID: expired' }],
          },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    }) as unknown as typeof fetch

    // The Salesforce refresh in session.ts uses the global fetch, so that leg
    // is stubbed at the global rather than through the relay's injected impl.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      assert.match(String(url), /\/services\/oauth2\/token$/)
      return jsonResponse({
        access_token: '00Dxx0000001gPF!RENEWEDSESSIONID',
        instance_url: CREDS.instanceUrl,
      })
    }) as unknown as typeof fetch

    try {
      const reply = await relayRequest(REQUEST, deps(fetchImpl, { creds: REFRESHABLE }))
      assert.equal(sfTokensUsed.length, 2)
      assert.equal(sfTokensUsed[1], '00Dxx0000001gPF!RENEWEDSESSIONID')
      assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { ok: true } })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('never leaks the Salesforce token into an error surfaced to the model', async () => {
    // A gateway that echoes the request back in its error body — the realistic
    // way a token ends up somewhere it should not be.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      return new Response(`upstream failed for token ${headers['x-sf-access-token']}`, {
        status: 502,
      })
    }) as unknown as typeof fetch

    await assert.rejects(
      () => relayRequest(REQUEST, deps(fetchImpl)),
      (err: Error) => {
        assert.ok(!err.message.includes(CREDS.accessToken), 'access token must not appear')
        assert.match(err.message, /\[redacted\]/)
        return true
      },
    )
  })

  test('returns null for an empty gateway body', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
    assert.equal(await relayRequest(REQUEST, deps(fetchImpl)), null)
  })
})

describe('looksSfExpired', () => {
  test('detects an expired session reported as a tool error', () => {
    assert.equal(
      looksSfExpired({
        result: { isError: true, content: [{ text: 'INVALID_SESSION_ID: Session expired' }] },
      }),
      true,
    )
  })

  test('ignores an ordinary tool error', () => {
    assert.equal(
      looksSfExpired({ result: { isError: true, content: [{ text: 'MALFORMED_QUERY' }] } }),
      false,
    )
  })

  test('ignores a successful result', () => {
    assert.equal(looksSfExpired({ result: { content: [{ text: 'INVALID_SESSION_ID' }] } }), false)
  })
})

describe('rpcError', () => {
  test('uses a null id when the request had none', () => {
    assert.deepEqual(rpcError(undefined, 'boom'), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'boom' },
    })
  })
})
