import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserCommand } from '../src/loopback.js'

const URL_WITH_PARAMS =
  'https://example.my.salesforce.com/services/oauth2/authorize?response_type=code&client_id=3MVG9abc&redirect_uri=http%3A%2F%2Flocalhost%3A1717%2Fcallback&state=xyz'

test('windows never routes the URL through cmd.exe (which splits it at &)', () => {
  const [cmd, args] = browserCommand('win32', URL_WITH_PARAMS)
  assert.notEqual(cmd.toLowerCase(), 'cmd')
  assert.equal(cmd, 'rundll32')
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', URL_WITH_PARAMS])
})

test('the full URL, every query param intact, is one argv entry on every platform', () => {
  for (const p of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
    const [, args] = browserCommand(p, URL_WITH_PARAMS)
    assert.equal(args.at(-1), URL_WITH_PARAMS, p)
  }
})

test('mac and linux openers are unchanged', () => {
  assert.deepEqual(browserCommand('darwin', 'https://x/?a=1&b=2'), ['open', ['https://x/?a=1&b=2']])
  assert.deepEqual(browserCommand('linux', 'https://x/?a=1&b=2'), [
    'xdg-open',
    ['https://x/?a=1&b=2'],
  ])
})
