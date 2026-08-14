import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'
import { CONFIG_DIR, TOKEN_FILE, DEFAULT_API_VERSION } from './config.js'

/**
 * The only credentials this server ever handles: an already-issued access
 * token plus the org's instance URL. We never see a username or password —
 * that is the whole point of the BYO-token model.
 */
export interface SfCredentials {
  accessToken: string
  instanceUrl: string
  apiVersion?: string
  /**
   * Only present for credentials issued by `login`. Together these let the
   * server renew an expired access token without a new browser sign-in; env
   * and per-request BYO credentials have none of them by design.
   */
  refreshToken?: string
  clientId?: string
  /** Confidential clients only — public PKCE clients (the default) have none. */
  clientSecret?: string
  loginUrl?: string
}

/** A function the server calls (lazily, per request) to obtain credentials. */
export type CredentialResolver = () => SfCredentials

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingCredentialsError'
  }
}

/** stdio: read SF_ACCESS_TOKEN + SF_INSTANCE_URL from the environment. */
export function credsFromEnv(): SfCredentials | null {
  const accessToken = process.env.SF_ACCESS_TOKEN
  const instanceUrl = process.env.SF_INSTANCE_URL
  if (!accessToken || !instanceUrl) return null
  return {
    accessToken,
    instanceUrl,
    apiVersion: process.env.SF_API_VERSION || DEFAULT_API_VERSION,
  }
}

/** stdio: read a token previously saved by the `login` command. */
export function credsFromFile(): SfCredentials | null {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8')
    const data = JSON.parse(raw) as Partial<SfCredentials>
    if (!data.accessToken || !data.instanceUrl) return null
    return {
      accessToken: data.accessToken,
      instanceUrl: data.instanceUrl,
      apiVersion: data.apiVersion || DEFAULT_API_VERSION,
      refreshToken: data.refreshToken,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      loginUrl: data.loginUrl,
    }
  } catch {
    return null
  }
}

/**
 * HTTP: pull the per-request token off the headers. This is what makes the
 * hosted server stateless — each caller brings their own token and gets data
 * scoped to their own Salesforce permissions.
 */
export function credsFromHeaders(headers: IncomingHttpHeaders): SfCredentials | null {
  const accessToken = header(headers, 'x-sf-access-token')
  const instanceUrl = header(headers, 'x-sf-instance-url')
  if (!accessToken || !instanceUrl) return null
  return {
    accessToken,
    instanceUrl,
    apiVersion: header(headers, 'x-sf-api-version') || DEFAULT_API_VERSION,
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * stdio resolver: env wins, then the saved token file.
 *
 * Env credentials are a bare access token with no refresh material, so they
 * cannot be renewed — an explicit SF_ACCESS_TOKEN opts out of silent renewal
 * and takes the token file's refreshable credentials out of play with it.
 */
export function resolveStdioCredentials(): SfCredentials {
  const creds = credsFromEnv() || credsFromFile()
  if (!creds) {
    throw new MissingCredentialsError(
      'No Salesforce credentials found. Set SF_ACCESS_TOKEN + SF_INSTANCE_URL, ' +
        'or run `salesforce-mcp-jsforce login` first.',
    )
  }
  return creds
}

/** Persist credentials for stdio use. */
export function saveToken(creds: SfCredentials): void {
  writeSecretFile(TOKEN_FILE, JSON.stringify(creds, null, 2))
}

/**
 * Write a secret to disk 0600 inside a 0700 config directory, atomically.
 *
 * Shared by the Salesforce token and the gateway token, both of which hold
 * long-lived refresh material. The write goes to a temp file and is renamed
 * into place: a crash (or two processes renewing at once) can then never leave
 * a truncated or interleaved credential behind, which previously meant a forced
 * re-login.
 */
export function writeSecretFile(target: string, contents: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask, and the directory may predate this version.
  chmodQuietly(CONFIG_DIR, 0o700)

  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 })
    chmodQuietly(tmp, 0o600)
    fs.renameSync(tmp, target)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing to clean up */
    }
    throw e
  }
}

/** Remove the stored token. Returns false when there was nothing to remove. */
export function deleteToken(): boolean {
  try {
    fs.unlinkSync(TOKEN_FILE)
    return true
  } catch {
    return false
  }
}

function chmodQuietly(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode)
  } catch {
    /* best effort — Windows and some mounts do not support POSIX modes */
  }
}

export function tokenPath(): string {
  return path.normalize(TOKEN_FILE)
}

/**
 * Strip credentials out of text that is about to be logged or returned to the
 * model. Salesforce echoes request material back in `error_description`, and
 * session ids ride in error bodies, so anything user-facing goes through here.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // Salesforce session ids / access tokens: orgId!signature.
      .replace(/\b00[A-Za-z0-9]{13,16}![^\s"'&]+/g, '[redacted]')
      // Refresh tokens (5Aep… prefix) and any bearer credential.
      .replace(/\b5Aep[A-Za-z0-9._-]+/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      // OAuth form/JSON fields, whatever the token shape.
      .replace(
        /\b(access_token|refresh_token|client_secret|code_verifier|assertion)\b(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi,
        '$1$2[redacted]',
      )
  )
}
