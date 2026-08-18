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

  test('surfaces a bare 403 with its status and body', async () => {
    // A 403 means something IN FRONT of the gateway rejected the call (proxy,
    // WAF). A gateway scope denial arrives as 200 + JSON-RPC error instead and
    // is covered by the pass-through test below.
    const fetchImpl = (async () =>
      new Response('Forbidden by proxy', { status: 403 })) as unknown as typeof fetch

    await assert.rejects(
      () => relayRequest(REQUEST, deps(fetchImpl)),
      /HTTP 403\. Forbidden by proxy/,
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

describe('looksSfExpired — expiry that arrives without an error code (#18)', () => {
  // The server-side child renders errors with fail(), which emits only
  // error.message. Salesforce's expiry message carries no code, so relayed
  // expiry looks nothing like the jsforce exception direct mode sees.
  test("detects Salesforce's bare expiry wording", () => {
    assert.equal(
      looksSfExpired({
        result: { isError: true, content: [{ text: '{"error":"Session expired or invalid"}' }] },
      }),
      true,
    )
  })

  test('detects the same wording in prose', () => {
    assert.equal(
      looksSfExpired({ result: { isError: true, content: [{ text: 'Session expired' }] } }),
      true,
    )
  })

  test('still detects the coded form, for children that preserve errorCode', () => {
    assert.equal(
      looksSfExpired({
        result: {
          isError: true,
          content: [{ text: '{"error":"...","errorCode":"INVALID_SESSION_ID"}' }],
        },
      }),
      true,
    )
  })

  test('does not treat an ordinary query failure as expiry', () => {
    assert.equal(
      looksSfExpired({
        result: { isError: true, content: [{ text: '{"error":"MALFORMED_QUERY: bad SOQL"}' }] },
      }),
      false,
    )
  })

  test('does not treat a session-shaped SUCCESS as expiry', () => {
    // A describe() of a field literally named "session expired" must not
    // trigger a refresh — only errors can mean expiry.
    assert.equal(
      looksSfExpired({ result: { content: [{ text: 'Session expired or invalid' }] } }),
      false,
    )
  })
})

describe('gateway JSON-RPC errors pass through (#18)', () => {
  test('a scope denial is forwarded verbatim, not swallowed or retried', async () => {
    // The gateway answers 200 + JSON-RPC error (-32003) for policy denials, so
    // the reason reaches the user. The relay must not reinterpret that.
    let calls = 0
    const denial = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32003, message: 'Access denied: Missing required scope: le-salesforce:*' },
    }
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify(denial), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const reply = await relayRequest(REQUEST, deps(fetchImpl))
    assert.deepEqual(reply, denial)
    assert.equal(calls, 1, 'a denial must not trigger a retry')
  })
})

describe('handshake is answered locally (#20)', () => {
  // Forwarding initialize made the MCP handshake require credentials, so any
  // auth problem killed the whole server and the client could only show
  // "-32603" — a number with nothing actionable in it.
  const failIfCalled = (async () => {
    throw new Error('the gateway must not be contacted for the handshake')
  }) as unknown as typeof fetch

  test('initialize succeeds with no gateway session and never leaves the machine', async () => {
    const reply = await relayRequest(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      {
        relayUrl: RELAY_URL,
        gateway: {
          async authorization() {
            throw new Error('not signed in')
          },
          async renew() {
            throw new Error('not signed in')
          },
        },
        session: createSessionRunner(
          () => CREDS,
          () => {},
        ),
        fetchImpl: failIfCalled,
      },
    )
    const result = reply?.result as { protocolVersion?: string; serverInfo?: { name?: string } }
    assert.equal(reply?.id, 0)
    assert.ok(result?.protocolVersion, 'must negotiate a protocol version')
    assert.ok(result?.serverInfo?.name, 'must identify the server')
    assert.equal(reply?.error, undefined)
  })

  test('ping is answered locally too', async () => {
    const reply = await relayRequest({ jsonrpc: '2.0', id: 9, method: 'ping' }, {
      relayUrl: RELAY_URL,
      gateway: {
        async authorization() {
          throw new Error('not signed in')
        },
        async renew() {
          throw new Error('not signed in')
        },
      },
      session: createSessionRunner(
        () => CREDS,
        () => {},
      ),
      fetchImpl: failIfCalled,
    } as RelayDeps)
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 9, result: {} })
  })

  test('a real call still requires the gateway session', async () => {
    await assert.rejects(
      () =>
        relayRequest(REQUEST, {
          relayUrl: RELAY_URL,
          gateway: {
            async authorization() {
              throw new Error('Not signed in to the LE gateway. Run login --gateway first.')
            },
            async renew() {
              throw new Error('not signed in')
            },
          },
          session: createSessionRunner(
            () => CREDS,
            () => {},
          ),
          fetchImpl: failIfCalled,
        }),
      /login --gateway/,
    )
  })

  test('tools/list is still forwarded — the handshake exemption is narrow', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await relayRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps(fetchImpl))
    assert.equal(calls, 1)
  })
})
