import fs from "node:fs";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { CONFIG_DIR, TOKEN_FILE, DEFAULT_API_VERSION } from "./config.js";

/**
 * The only credentials this server ever handles: an already-issued access
 * token plus the org's instance URL. We never see a client secret, username,
 * or password — that is the whole point of the BYO-token model.
 */
export interface SfCredentials {
  accessToken: string;
  instanceUrl: string;
  apiVersion?: string;
  /** Optional, only persisted by `login` so the token can be silently renewed. */
  refreshToken?: string;
  clientId?: string;
  loginUrl?: string;
}

/** A function the server calls (lazily, per request) to obtain credentials. */
export type CredentialResolver = () => SfCredentials;

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/** stdio: read SF_ACCESS_TOKEN + SF_INSTANCE_URL from the environment. */
export function credsFromEnv(): SfCredentials | null {
  const accessToken = process.env.SF_ACCESS_TOKEN;
  const instanceUrl = process.env.SF_INSTANCE_URL;
  if (!accessToken || !instanceUrl) return null;
  return {
    accessToken,
    instanceUrl,
    apiVersion: process.env.SF_API_VERSION || DEFAULT_API_VERSION,
  };
}

/** stdio: read a token previously saved by the `login` command. */
export function credsFromFile(): SfCredentials | null {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<SfCredentials>;
    if (!data.accessToken || !data.instanceUrl) return null;
    return {
      accessToken: data.accessToken,
      instanceUrl: data.instanceUrl,
      apiVersion: data.apiVersion || DEFAULT_API_VERSION,
      refreshToken: data.refreshToken,
      clientId: data.clientId,
      loginUrl: data.loginUrl,
    };
  } catch {
    return null;
  }
}

/**
 * HTTP: pull the per-request token off the headers. This is what makes the
 * hosted server stateless — each caller brings their own token and gets data
 * scoped to their own Salesforce permissions.
 */
export function credsFromHeaders(
  headers: IncomingHttpHeaders
): SfCredentials | null {
  const accessToken = header(headers, "x-sf-access-token");
  const instanceUrl = header(headers, "x-sf-instance-url");
  if (!accessToken || !instanceUrl) return null;
  return {
    accessToken,
    instanceUrl,
    apiVersion: header(headers, "x-sf-api-version") || DEFAULT_API_VERSION,
  };
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** stdio resolver: env wins, then the saved token file. */
export function resolveStdioCredentials(): SfCredentials {
  const creds = credsFromEnv() || credsFromFile();
  if (!creds) {
    throw new MissingCredentialsError(
      "No Salesforce credentials found. Set SF_ACCESS_TOKEN + SF_INSTANCE_URL, " +
        "or run `salesforce-mcp-jsforce login` first."
    );
  }
  return creds;
}

/** Persist the token issued by `login` (chmod 600 — it is a live credential). */
export function saveToken(creds: SfCredentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

export function tokenPath(): string {
  return path.normalize(TOKEN_FILE);
}
