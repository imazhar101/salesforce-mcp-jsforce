import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

// The config module reads SF_MCP_CONFIG_DIR at import time, so the override has
// to be in place before anything under src/ is loaded.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sfmcp-auth-'))
process.env.SF_MCP_CONFIG_DIR = path.join(SANDBOX, 'config')

const { deleteToken, credsFromFile, redactSecrets, saveToken, tokenPath } =
  await import('../src/auth.js')

after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }))

describe('saveToken', () => {
  it('writes the token 0600 inside a 0700 directory', () => {
    saveToken({
      accessToken: 'access-1',
      instanceUrl: 'https://example.my.salesforce.com',
      refreshToken: 'refresh-1',
      clientId: 'cid',
      loginUrl: 'https://login.salesforce.com',
    })

    const file = fs.statSync(tokenPath())
    const dir = fs.statSync(path.dirname(tokenPath()))
    assert.equal(file.mode & 0o777, 0o600)
    assert.equal(dir.mode & 0o777, 0o700)
  })

  it('round-trips through credsFromFile', () => {
    const creds = credsFromFile()
    assert.equal(creds?.accessToken, 'access-1')
    assert.equal(creds?.refreshToken, 'refresh-1')
    assert.equal(creds?.clientId, 'cid')
  })

  it('leaves no readable temp file behind', () => {
    const leftovers = fs
      .readdirSync(path.dirname(tokenPath()))
      .filter((f) => f !== path.basename(tokenPath()))
    assert.deepEqual(leftovers, [])
  })

  it('replaces the token atomically, never truncating in place', () => {
    // A reader that opens the old inode must still see a complete document.
    const before = fs.statSync(tokenPath()).ino
    saveToken({
      accessToken: 'access-2',
      instanceUrl: 'https://example.my.salesforce.com',
      refreshToken: 'refresh-1',
    })
    assert.notEqual(fs.statSync(tokenPath()).ino, before)
    assert.equal(credsFromFile()?.accessToken, 'access-2')
  })
})

describe('deleteToken', () => {
  it('removes the file and is safe to call twice', () => {
    assert.equal(deleteToken(), true)
    assert.equal(fs.existsSync(tokenPath()), false)
    assert.equal(deleteToken(), false)
    assert.equal(credsFromFile(), null)
  })
})

describe('redactSecrets', () => {
  it('masks bearer tokens and Salesforce session ids', () => {
    const sessionId = '00D8b0000008yLm!ARsAQPBmOMTHISLOOKSLIKEASESSIONID'
    const out = redactSecrets(`Bearer abc.def.ghi failed for ${sessionId}`)
    assert.ok(!out.includes('abc.def.ghi'))
    assert.ok(!out.includes(sessionId))
    assert.ok(out.includes('[redacted]'))
  })

  it('masks refresh tokens and oauth form fields', () => {
    const out = redactSecrets('grant_type=refresh_token&refresh_token=5Aep861xyz&client_id=3MVG9')
    assert.ok(!out.includes('5Aep861xyz'))
    assert.ok(out.includes('refresh_token=[redacted]'))
  })

  it('leaves ordinary Salesforce errors intact', () => {
    const msg = 'INVALID_FIELD: No such column Foo__c on entity Account'
    assert.equal(redactSecrets(msg), msg)
  })
})
