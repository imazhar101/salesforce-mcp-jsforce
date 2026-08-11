import crypto from 'node:crypto'
import http from 'node:http'
import { URL } from 'node:url'
import { spawn } from 'node:child_process'
import { DEFAULT_LOGIN_URL, DEFAULT_API_VERSION, LOGIN_TIMEOUT_MS } from './config.js'
import { deleteToken, credsFromFile, saveToken, tokenPath, type SfCredentials } from './auth.js'

interface LoginOptions {
  clientId: string
  clientSecret?: string // optional — public PKCE clients omit it
  loginUrl: string
  scope: string
  callbackPort: number
  quiet: boolean // suppress the printed config suggestion
}

/**
 * The login URL is the host we send an authorization code and (optionally) a
 * client secret to, so it must be https. Anything else — a typo, a copied
 * proxy URL, an injected value — would put the exchange in the clear.
 */
export function assertSafeLoginUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid --login-url: ${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`--login-url must be https (got ${url.protocol.replace(':', '')}): ${raw}`)
  }
  // Trailing slashes would double up when concatenated with /services/oauth2/…
  return url.origin
}

function parseArgs(argv: string[]): LoginOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const clientId = get('--client-id') || process.env.SF_CLIENT_ID
  if (!clientId) {
    throw new Error(
      'Missing client id. Pass --client-id <consumerKey> or set SF_CLIENT_ID ' +
        '(the consumer key of your Salesforce External Client App).',
    )
  }
  const port = Number(get('--port') || process.env.SF_CALLBACK_PORT || 1717)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port: ${port}`)
  }
  return {
    clientId,
    clientSecret: get('--client-secret') || process.env.SF_CLIENT_SECRET,
    loginUrl: assertSafeLoginUrl(get('--login-url') || DEFAULT_LOGIN_URL),
    scope: get('--scope') || process.env.SF_SCOPE || 'api refresh_token',
    callbackPort: port,
    quiet: argv.includes('--quiet'),
  }
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Hand the URL to the OS opener as an argv entry, never as part of a shell
 * string — the URL carries caller-supplied values, and a shell would happily
 * execute anything smuggled through them.
 */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // cmd's `start` treats the first quoted arg as a window title.
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {
      /* the URL is already printed for manual use */
    })
    child.unref()
  } catch {
    /* same — printing the URL is the fallback */
  }
}

/**
 * Run the authorization-code + PKCE flow against a Salesforce External Client
 * App, exchange the code for a token and persist it. The refresh token saved
 * here is what lets the server renew itself later without another sign-in.
 */
export async function runLogin(argv: string[]): Promise<void> {
  const opts = parseArgs(argv)
  const { verifier, challenge } = pkce()
  // 127.0.0.1, not localhost: the callback server binds the loopback address
  // only, so nothing else on the network can race it for the code.
  const redirectUri = `http://127.0.0.1:${opts.callbackPort}/callback`
  const state = crypto.randomBytes(16).toString('hex')

  const authUrl = new URL(`${opts.loginUrl}/services/oauth2/authorize`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', opts.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', opts.scope)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404).end()
        return
      }
      const url = new URL(req.url, redirectUri)
      const err = url.searchParams.get('error')
      if (err) {
        res
          .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          .end(`Login failed: ${err} ${url.searchParams.get('error_description') ?? ''}`)
        server.close()
        reject(new Error(`OAuth error: ${err}`))
        return
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('State mismatch')
        server.close()
        reject(new Error('OAuth state mismatch — possible CSRF, aborting.'))
        return
      }
      const got = url.searchParams.get('code')
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Authenticated. You can close this tab and return to your terminal.')
      server.close()
      if (got) resolve(got)
      else reject(new Error('No authorization code returned.'))
    })

    // Never wait forever: an abandoned sign-in used to leave the callback
    // server (and the process) alive indefinitely.
    const timer = setTimeout(() => {
      server.close()
      reject(
        new Error(
          `Timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s waiting for the Salesforce sign-in to complete.`,
        ),
      )
    }, LOGIN_TIMEOUT_MS)
    timer.unref()
    server.on('close', () => clearTimeout(timer))
    server.on('error', reject)

    server.listen(opts.callbackPort, '127.0.0.1', () => {
      console.error(`\nOpening Salesforce login in your browser…`)
      console.error(`If it does not open, visit:\n${authUrl.toString()}\n`)
      openBrowser(authUrl.toString())
    })
  })

  // Exchange the code for a token (PKCE; secret only sent if provided).
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret)

  const resp = await fetch(`${opts.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await resp.json().catch(() => ({}))) as Record<string, string>
  if (!resp.ok || !json.access_token) {
    throw new Error(
      `Token exchange failed: ${json.error ?? resp.status} ${json.error_description ?? ''}`,
    )
  }
  if (!json.refresh_token) {
    console.error(
      '\n! Salesforce did not return a refresh token — the session cannot be renewed and you\n' +
        '  will have to sign in again when it expires. Add the `refresh_token` scope to the\n' +
        '  Connected App (and pass --scope "api refresh_token") to fix this.',
    )
  }

  const creds: SfCredentials = {
    accessToken: json.access_token,
    instanceUrl: json.instance_url,
    apiVersion: DEFAULT_API_VERSION,
    refreshToken: json.refresh_token,
    clientId: opts.clientId,
    // Persisted only for confidential clients, which need it to refresh.
    clientSecret: opts.clientSecret,
    loginUrl: opts.loginUrl,
  }
  saveToken(creds)

  console.error(`\n✓ Logged in. Token saved to ${tokenPath()}`)
  console.error(`  Instance: ${creds.instanceUrl}`)
  console.error('  The session now renews itself; no re-login until you revoke the grant.\n')

  if (opts.quiet) return

  // The config snippet deliberately carries no token: SF_ACCESS_TOKEN pins a
  // credential that cannot be renewed, and printing a live token drops it into
  // terminal scrollback, shell history files and CI logs.
  console.error('Add to Claude Code (stdio) with:\n')
  console.error('  claude mcp add salesforce -- npx -y @imazhar101/salesforce-mcp-jsforce\n')
  console.error('…or paste into .mcp.json:\n')
  console.error(
    JSON.stringify(
      {
        mcpServers: {
          salesforce: {
            command: 'npx',
            args: ['-y', '@imazhar101/salesforce-mcp-jsforce'],
            env: { SF_READONLY: '1' },
          },
        },
      },
      null,
      2,
    ),
  )
  console.error(`\n(The token file at ${tokenPath()} is read automatically.)\n`)
}

/**
 * Revoke the stored grant at Salesforce and delete the local token. Revoking
 * server-side matters: deleting the file alone leaves a live refresh token
 * outstanding on the org.
 */
export async function runLogout(argv: string[]): Promise<void> {
  const keepRemote = argv.includes('--local-only')
  const creds = credsFromFile()
  if (!creds) {
    console.error(`No stored token at ${tokenPath()} — nothing to do.`)
    return
  }

  if (!keepRemote) {
    const target = creds.loginUrl || creds.instanceUrl
    const token = creds.refreshToken || creds.accessToken
    try {
      const resp = await fetch(`${target}/services/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      })
      if (resp.ok) console.error('✓ Grant revoked at Salesforce')
      else console.error(`! Salesforce returned ${resp.status} for the revoke request`)
    } catch {
      console.error('! Could not reach Salesforce to revoke — removing the local token anyway')
    }
  }

  console.error(deleteToken() ? `✓ Removed ${tokenPath()}` : `! Could not remove ${tokenPath()}`)
}
