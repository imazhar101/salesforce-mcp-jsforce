import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeGatewayUrl,
  issuerOf,
  createGatewaySession,
  GatewayAuthError,
  type GatewayTokens,
} from '../src/gateway.ts'

const TOKENS: GatewayTokens = {
  accessToken: 'gw-access-1',
  refreshToken: 'gw-refresh-1',
  issuer: 'https://gateway.example.com',
}

describe('assertSafeGatewayUrl', () => {
  test('accepts https', () => {
    assert.equal(
      assertSafeGatewayUrl('https://gateway.example.com/mcp/le-salesforce'),
      'https://gateway.example.com/mcp/le-salesforce',
    )
  })

  test('accepts loopback over http for local gateways', () => {
    assert.match(assertSafeGatewayUrl('http://localhost:3000/mcp/le-salesforce'), /^http:\/\//)
  })

  test('rejects plaintext to a remote host — the bearer token would be exposed', () => {
    assert.throws(
      () => assertSafeGatewayUrl('http://gateway.example.com/mcp/le-salesforce'),
      GatewayAuthError,
    )
  })

  test('rejects a malformed URL', () => {
    assert.throws(() => assertSafeGatewayUrl('not a url'), GatewayAuthError)
  })
})

describe('issuerOf', () => {
  test('reduces a relay URL to its origin', () => {
    assert.equal(
      issuerOf('https://gateway.example.com/mcp/le-salesforce'),
      'https://gateway.example.com',
    )
  })
})

describe('createGatewaySession', () => {
  test('demands a sign-in when no token is stored', async () => {
    const session = createGatewaySession(
      () => null,
      async () => TOKENS,
    )
    await assert.rejects(() => session.authorization(), /login --gateway/)
  })

  test('returns the stored token as a bearer value', async () => {
    const session = createGatewaySession(
      () => TOKENS,
      async () => TOKENS,
    )
    assert.equal(await session.authorization(), 'Bearer gw-access-1')
  })

  test('refreshes up front when the stored token has already expired', async () => {
    let refreshes = 0
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() - 1000 }),
      async () => {
        refreshes++
        return { ...TOKENS, accessToken: 'gw-access-2', expiresAt: Date.now() + 3_600_000 }
      },
    )
    assert.equal(await session.authorization(), 'Bearer gw-access-2')
    assert.equal(refreshes, 1)
    // The renewed token is held in memory — a second call must not refresh again.
    assert.equal(await session.authorization(), 'Bearer gw-access-2')
    assert.equal(refreshes, 1)
  })

  test('refreshes just before expiry rather than letting a call race the clock', async () => {
    let refreshes = 0
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() + 5_000 }),
      async () => {
        refreshes++
        return { ...TOKENS, accessToken: 'gw-access-2', expiresAt: Date.now() + 3_600_000 }
      },
    )
    await session.authorization()
    assert.equal(refreshes, 1)
  })

  test('treats an unknown expiry as usable and does not pre-emptively refresh', async () => {
    let refreshes = 0
    const session = createGatewaySession(
      () => TOKENS,
      async () => {
        refreshes++
        return TOKENS
      },
    )
    await session.authorization()
    assert.equal(refreshes, 0)
  })

  test('shares one refresh between concurrent callers', async () => {
    let refreshes = 0
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() - 1000 }),
      async () => {
        refreshes++
        await new Promise((r) => setTimeout(r, 10))
        return { ...TOKENS, accessToken: 'gw-access-2', expiresAt: Date.now() + 3_600_000 }
      },
    )
    const results = await Promise.all([
      session.authorization(),
      session.authorization(),
      session.authorization(),
    ])
    assert.deepEqual(results, ['Bearer gw-access-2', 'Bearer gw-access-2', 'Bearer gw-access-2'])
    assert.equal(refreshes, 1)
  })

  test('renew() forces a refresh even when the token looks live', async () => {
    let refreshes = 0
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() + 3_600_000 }),
      async () => {
        refreshes++
        return { ...TOKENS, accessToken: 'gw-access-2' }
      },
    )
    assert.equal(await session.authorization(), 'Bearer gw-access-1')
    assert.equal(await session.renew(), 'Bearer gw-access-2')
    assert.equal(refreshes, 1)
  })

  test('surfaces a failed refresh with a re-login instruction', async () => {
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() - 1000 }),
      async () => {
        throw new GatewayAuthError('The gateway refused to renew the session. Run login --gateway')
      },
    )
    await assert.rejects(() => session.authorization(), /login --gateway/)
  })

  test('a failed refresh does not wedge the session — a later attempt can retry', async () => {
    let attempts = 0
    const session = createGatewaySession(
      () => ({ ...TOKENS, expiresAt: Date.now() - 1000 }),
      async () => {
        attempts++
        if (attempts === 1) throw new GatewayAuthError('transient')
        return { ...TOKENS, accessToken: 'gw-access-2', expiresAt: Date.now() + 3_600_000 }
      },
    )
    await assert.rejects(() => session.authorization())
    assert.equal(await session.authorization(), 'Bearer gw-access-2')
    assert.equal(attempts, 2)
  })
})
