import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertSafeLoginUrl, buildRedirectUri } from '../src/oauth.js'
import { isAllowedHost } from '../src/http.js'

describe('buildRedirectUri', () => {
  it('defaults to localhost — Salesforce matches the registered URL byte-for-byte', () => {
    // Connected Apps (ASU LE's included) register http://localhost:1717/callback.
    // Sending 127.0.0.1 instead fails the flow with redirect_uri_mismatch, which
    // is exactly what shipped in 0.4.0. Do not "modernise" this host.
    assert.equal(buildRedirectUri(undefined, 1717), 'http://localhost:1717/callback')
    assert.equal(buildRedirectUri(undefined, 1718), 'http://localhost:1718/callback')
  })

  it('honours an explicit loopback override', () => {
    assert.equal(
      buildRedirectUri('http://127.0.0.1:1717/callback', 1717),
      'http://127.0.0.1:1717/callback',
    )
  })

  it('refuses a non-loopback redirect', () => {
    assert.throws(() => buildRedirectUri('https://evil.example.com/callback', 1717), /loopback/)
  })

  it('refuses a malformed redirect', () => {
    assert.throws(() => buildRedirectUri('not-a-url', 1717), /Invalid --redirect-uri/)
  })
})

describe('assertSafeLoginUrl', () => {
  it('accepts https hosts and normalises to the origin', () => {
    assert.equal(
      assertSafeLoginUrl('https://asulearningenterprise.my.salesforce.com/'),
      'https://asulearningenterprise.my.salesforce.com',
    )
  })

  it('rejects plaintext http — the code exchange would be in the clear', () => {
    assert.throws(() => assertSafeLoginUrl('http://login.salesforce.com'), /must be https/)
  })

  it('rejects shell-injection attempts outright', () => {
    // Previously this string reached an exec() shell via the browser opener.
    assert.throws(() => assertSafeLoginUrl('https://x.com"; touch /tmp/pwned; #'), /Invalid|https/)
  })

  it('rejects non-URLs', () => {
    assert.throws(() => assertSafeLoginUrl('not-a-url'), /Invalid --login-url/)
  })
})

describe('isAllowedHost', () => {
  it('allows loopback requests with no Origin (CLI/gateway clients)', () => {
    assert.equal(isAllowedHost({ host: '127.0.0.1:3000' }), true)
    assert.equal(isAllowedHost({ host: 'localhost:3000' }), true)
    assert.equal(isAllowedHost({ host: '[::1]:3000' }), true)
  })

  it('rejects a rebound hostname pointed at the loopback listener', () => {
    assert.equal(isAllowedHost({ host: 'attacker.example.com:3000' }), false)
  })

  it('rejects a browser Origin that is not loopback', () => {
    assert.equal(
      isAllowedHost({ host: '127.0.0.1:3000', origin: 'https://evil.example.com' }),
      false,
    )
  })

  it('allows a loopback Origin', () => {
    assert.equal(isAllowedHost({ host: '127.0.0.1:3000', origin: 'http://localhost:5173' }), true)
  })

  it('rejects a missing Host header', () => {
    assert.equal(isAllowedHost({}), false)
  })
})
