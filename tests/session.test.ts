import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type { SfCredentials } from '../src/auth.js'
import {
  RefreshFailedError,
  SessionExpiredError,
  canRefresh,
  createSessionRunner,
  isSessionExpired,
  refreshAccessToken,
} from '../src/session.js'

const FILE_CREDS: SfCredentials = {
  accessToken: 'stale',
  instanceUrl: 'https://example.my.salesforce.com',
  refreshToken: 'refresh-1',
  clientId: 'cid',
  loginUrl: 'https://login.salesforce.com',
}

/** jsforce surfaces an expired session as an errorCode on a plain Error. */
function sessionError(): Error {
  const err = new Error('Session expired or invalid') as Error & { errorCode: string }
  err.errorCode = 'INVALID_SESSION_ID'
  return err
}

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: string }> = []
  const impl = async (url: string | URL, init?: RequestInit) => {
    const next = responses.shift() ?? { status: 500, body: { error: 'no stub left' } }
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response
  }
  mock.method(globalThis, 'fetch', impl as typeof fetch)
  return calls
}

describe('isSessionExpired', () => {
  it('recognises the Salesforce error codes and 401s', () => {
    assert.equal(isSessionExpired(sessionError()), true)
    assert.equal(isSessionExpired(new Error('INVALID_SESSION_ID: Session expired')), true)
    assert.equal(isSessionExpired({ errorCode: 'INVALID_LOGIN' }), true)
    assert.equal(isSessionExpired(Object.assign(new Error('nope'), { status: 401 })), true)
  })

  it('does not swallow ordinary query errors', () => {
    assert.equal(isSessionExpired(new Error('MALFORMED_QUERY: unexpected token')), false)
    assert.equal(isSessionExpired(Object.assign(new Error('boom'), { status: 500 })), false)
  })
})

describe('canRefresh', () => {
  it('needs a refresh token, a client id and a login url', () => {
    assert.equal(canRefresh(FILE_CREDS), true)
    assert.equal(canRefresh({ ...FILE_CREDS, refreshToken: undefined }), false)
    assert.equal(canRefresh({ accessToken: 'a', instanceUrl: 'b' }), false)
  })
})

describe('refreshAccessToken', () => {
  it('posts the refresh_token grant and returns the new access token', async (t) => {
    const calls = stubFetch({
      status: 200,
      body: { access_token: 'fresh', instance_url: 'https://renamed.my.salesforce.com' },
    })
    t.after(() => mock.restoreAll())

    const next = await refreshAccessToken(FILE_CREDS as never)

    assert.equal(next.accessToken, 'fresh')
    // Salesforce can hand back a different instance during org moves — adopt it.
    assert.equal(next.instanceUrl, 'https://renamed.my.salesforce.com')
    // The refresh token is not rotated by Salesforce; keep the one we hold.
    assert.equal(next.refreshToken, 'refresh-1')
    assert.equal(calls[0].url, 'https://login.salesforce.com/services/oauth2/token')
    assert.match(calls[0].body, /grant_type=refresh_token/)
    assert.match(calls[0].body, /refresh_token=refresh-1/)
  })

  it('raises RefreshFailedError with a re-login hint when the grant is dead', async (t) => {
    stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: 'expired' } })
    t.after(() => mock.restoreAll())

    await assert.rejects(() => refreshAccessToken(FILE_CREDS as never), {
      name: 'RefreshFailedError',
      message: /login/i,
    })
  })

  it('never leaks the refresh token into the error message', async (t) => {
    stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: 'refresh-1' } })
    t.after(() => mock.restoreAll())

    const err = await refreshAccessToken(FILE_CREDS as never).catch((e) => e as RefreshFailedError)
    assert.ok(!err.message.includes('refresh-1'))
  })
})

describe('createSessionRunner', () => {
  it('refreshes, persists and retries the call once', async (t) => {
    stubFetch({
      status: 200,
      body: { access_token: 'fresh', instance_url: FILE_CREDS.instanceUrl },
    })
    t.after(() => mock.restoreAll())

    const saved: SfCredentials[] = []
    const runner = createSessionRunner(
      () => ({ ...FILE_CREDS }),
      (c) => saved.push(c),
    )

    const seen: string[] = []
    const result = await runner.run(async (creds) => {
      seen.push(creds.accessToken)
      if (creds.accessToken === 'stale') throw sessionError()
      return 'ok'
    })

    assert.equal(result, 'ok')
    assert.deepEqual(seen, ['stale', 'fresh'])
    assert.equal(saved.length, 1)
    assert.equal(saved[0].accessToken, 'fresh')
  })

  it('reuses the refreshed token for later calls without re-refreshing', async (t) => {
    stubFetch({
      status: 200,
      body: { access_token: 'fresh', instance_url: FILE_CREDS.instanceUrl },
    })
    t.after(() => mock.restoreAll())

    const runner = createSessionRunner(
      () => ({ ...FILE_CREDS }),
      () => {},
    )
    await runner.run(async (c) => {
      if (c.accessToken === 'stale') throw sessionError()
      return 1
    })

    const seen: string[] = []
    await runner.run(async (c) => {
      seen.push(c.accessToken)
      return 2
    })
    assert.deepEqual(seen, ['fresh'])
    assert.equal(
      (globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount(),
      1,
    )
  })

  it('refreshes once when concurrent calls all hit an expired session', async (t) => {
    stubFetch({
      status: 200,
      body: { access_token: 'fresh', instance_url: FILE_CREDS.instanceUrl },
    })
    t.after(() => mock.restoreAll())

    const runner = createSessionRunner(
      () => ({ ...FILE_CREDS }),
      () => {},
    )
    const call = () =>
      runner.run(async (c) => {
        if (c.accessToken === 'stale') throw sessionError()
        return c.accessToken
      })

    const out = await Promise.all([call(), call(), call()])
    assert.deepEqual(out, ['fresh', 'fresh', 'fresh'])
    assert.equal(
      (globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount(),
      1,
    )
  })

  it('retries only once — a second expiry surfaces to the caller', async (t) => {
    stubFetch({
      status: 200,
      body: { access_token: 'fresh', instance_url: FILE_CREDS.instanceUrl },
    })
    t.after(() => mock.restoreAll())

    const runner = createSessionRunner(
      () => ({ ...FILE_CREDS }),
      () => {},
    )
    await assert.rejects(() => runner.run(async () => Promise.reject(sessionError())), {
      errorCode: 'INVALID_SESSION_ID',
    })
  })

  it('tells BYO callers to re-authenticate when there is nothing to refresh with', async () => {
    const runner = createSessionRunner(
      () => ({ accessToken: 'stale', instanceUrl: FILE_CREDS.instanceUrl }),
      () => {},
    )
    await assert.rejects(() => runner.run(async () => Promise.reject(sessionError())), {
      name: 'SessionExpiredError',
      message: /login/i,
    })
    assert.ok(SessionExpiredError.prototype instanceof Error)
  })
})
