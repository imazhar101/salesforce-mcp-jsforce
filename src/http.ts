import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from './server.js'
import { credsFromHeaders, MissingCredentialsError, redactSecrets } from './auth.js'
import {
  HTTP_ALLOWED_HOSTS,
  HTTP_HOST,
  HTTP_MAX_BODY_BYTES,
  PKG_NAME,
  PKG_VERSION,
} from './config.js'

const MCP_PATH = '/mcp'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' }).end(text)
}

class BodyTooLargeError extends Error {}

/**
 * Read the request body with a hard ceiling. Without one a single request can
 * grow the process until the OS kills it.
 */
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > HTTP_MAX_BODY_BYTES) throw new BodyTooLargeError('Request body too large')
    chunks.push(buf)
  }
  if (!chunks.length) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function hostname(value: string | undefined): string {
  if (!value) return ''
  // Strip the port, keeping bracketed IPv6 literals intact.
  const m = value
    .trim()
    .toLowerCase()
    .match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/)
  return m ? m[1] : ''
}

/**
 * Reject requests whose Host/Origin we do not recognise. A web page can point a
 * hostname it controls at 127.0.0.1 (DNS rebinding) and then talk to a loopback
 * listener from the user's browser; checking these headers is what stops it.
 */
export function isAllowedHost(headers: http.IncomingHttpHeaders): boolean {
  const allowed = (h: string) =>
    Boolean(h) && (LOOPBACK_HOSTS.has(h) || HTTP_ALLOWED_HOSTS.includes(h))

  if (!allowed(hostname(headers.host as string | undefined))) return false

  const origin = headers.origin as string | undefined
  if (!origin || origin === 'null') return true // non-browser client
  try {
    return allowed(hostname(new URL(origin).host))
  } catch {
    return false
  }
}

/**
 * Dedicated, stateless streamable-HTTP host. Every request brings its own
 * Salesforce token via headers, so we build a throwaway server + transport per
 * request — nothing about one caller leaks into another.
 *
 * Headers: X-SF-Access-Token, X-SF-Instance-Url (X-SF-Api-Version optional).
 */
export async function startHttp(port: number, host: string = HTTP_HOST): Promise<void> {
  const server = http.createServer(async (req, res) => {
    // Liveness probe for load balancers / container health checks.
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok', name: PKG_NAME, version: PKG_VERSION })
    }

    if (!isAllowedHost(req.headers)) {
      return send(res, 403, { error: 'Host not allowed' })
    }

    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      return send(res, 404, { error: 'Not found' })
    }

    if (req.method !== 'POST') {
      // Stateless mode does not support the GET/DELETE session endpoints.
      return send(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed; POST to /mcp' },
        id: null,
      })
    }

    const creds = credsFromHeaders(req.headers)
    if (!creds) {
      return send(res, 401, {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Missing credentials. Provide X-SF-Access-Token and X-SF-Instance-Url headers.',
        },
        id: null,
      })
    }

    try {
      const body = await readBody(req)
      // Stateless: a fresh server + transport per request, no session id. No
      // persist callback either — a header token belongs to its caller, who is
      // the only party that can renew it.
      const mcp = buildServer(() => {
        if (!creds) throw new MissingCredentialsError('No credentials')
        return creds
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      res.on('close', () => {
        transport.close()
        mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) {
        const tooLarge = err instanceof BodyTooLargeError
        send(res, tooLarge ? 413 : 500, {
          jsonrpc: '2.0',
          error: {
            code: tooLarge ? -32600 : -32603,
            // Redacted: parse failures can quote request material verbatim.
            message: redactSecrets(err instanceof Error ? err.message : 'Internal error'),
          },
          id: null,
        })
      }
    }
  })

  server.listen(port, host, () => {
    console.error(
      `${PKG_NAME} v${PKG_VERSION} listening on http://${host}:${port}${MCP_PATH} (stateless, BYO token)`,
    )
  })
}
