import http from 'node:http'
import { URL } from 'node:url'
import { spawn } from 'node:child_process'

/**
 * Loopback capture of an OAuth authorization code.
 *
 * Extracted from the Salesforce login so the gateway login can reuse it: both
 * flows are the same authorization-code dance against a different issuer, and
 * the tricky parts (dual-stack binding, state checking, timeout) are worth
 * having in exactly one place.
 */
export interface LoopbackOptions {
  /** Fully-built authorize URL, including state and PKCE challenge. */
  authUrl: string
  /** Redirect URI advertised to the issuer. Must be loopback. */
  redirectUri: string
  port: number
  /** Opaque value echoed back by the issuer; mismatch aborts the flow. */
  state: string
  timeoutMs: number
  /** Human name of the issuer, used in the messages printed to the terminal. */
  label: string
}

export const LOOPBACK_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * The redirect URI the issuer is told to come back to.
 *
 * Issuers match this byte-for-byte against a registered callback URL, so the
 * host is NOT interchangeable: `http://localhost:1717/...` and
 * `http://127.0.0.1:1717/...` are different values. This is independent of
 * what the callback server binds to — see awaitAuthorizationCode.
 */
export function buildRedirectUri(override: string | undefined, port: number): string {
  if (!override) return `http://localhost:${port}/callback`
  let url: URL
  try {
    url = new URL(override)
  } catch {
    throw new Error(`Invalid --redirect-uri: ${override}`)
  }
  if (!LOOPBACK_REDIRECT_HOSTS.has(url.hostname)) {
    throw new Error(
      `--redirect-uri must point at the loopback interface (localhost, 127.0.0.1 or [::1]); got ${url.hostname}`,
    )
  }
  return url.toString()
}

/**
 * Hand the URL to the OS opener as an argv entry, never as part of a shell
 * string — the URL carries caller-supplied values, and a shell would happily
 * execute anything smuggled through them.
 */
export function openBrowser(url: string): void {
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
 * Open the browser at `authUrl` and resolve with the authorization code the
 * issuer redirects back with.
 */
export function awaitAuthorizationCode(opts: LoopbackOptions): Promise<string> {
  const { authUrl, redirectUri, port, state, timeoutMs, label } = opts

  return new Promise<string>((resolve, reject) => {
    const servers: http.Server[] = []
    const closeAll = () => servers.forEach((s) => s.close())

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
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
        closeAll()
        reject(new Error(`OAuth error: ${err}`))
        return
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('State mismatch')
        closeAll()
        reject(new Error('OAuth state mismatch — possible CSRF, aborting.'))
        return
      }
      const got = url.searchParams.get('code')
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Authenticated. You can close this tab and return to your terminal.')
      closeAll()
      if (got) resolve(got)
      else reject(new Error('No authorization code returned.'))
    }

    // Never wait forever: an abandoned sign-in used to leave the callback
    // server (and the process) alive indefinitely.
    const timer = setTimeout(() => {
      closeAll()
      reject(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the ${label} sign-in to complete.`,
        ),
      )
    }, timeoutMs)
    timer.unref()

    /**
     * Listen on the loopback interface only — never every interface, so nothing
     * else on the network can race the browser for the authorization code.
     *
     * Both loopback addresses get a listener when the redirect says `localhost`:
     * that name resolves to ::1 on some machines and 127.0.0.1 on others, and
     * the browser picks. Binding one and hoping is how you get an intermittent
     * ECONNREFUSED on the callback that looks like a broken login.
     */
    const redirectHost = new URL(redirectUri).hostname
    const hosts = redirectHost === 'localhost' ? ['127.0.0.1', '::1'] : [redirectHost]

    let bound = 0
    let failed = 0
    let announced = false

    const fatal = (e: Error) => {
      clearTimeout(timer)
      closeAll()
      reject(e)
    }

    for (const host of hosts) {
      const server = http.createServer(handler)
      servers.push(server)

      server.on('error', (e: NodeJS.ErrnoException) => {
        // A busy port means someone else would receive our authorization code —
        // never quietly continue on the other address.
        if (e.code === 'EADDRINUSE') {
          return fatal(
            new Error(
              `Port ${port} is already in use on ${host}. Close whatever holds it, or pass --port <free port> (and register that callback URL).`,
            ),
          )
        }
        // Otherwise this is usually a host with no IPv6 stack: tolerable, as
        // long as the other address bound.
        failed++
        if (bound === 0 && failed === hosts.length) fatal(e)
      })

      server.listen(port, host, () => {
        bound++
        if (announced) return
        announced = true
        console.error(`\nOpening ${label} login in your browser…`)
        console.error(`If it does not open, visit:\n${authUrl}\n`)
        openBrowser(authUrl)
      })
    }
  })
}
