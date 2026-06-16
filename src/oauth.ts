import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";
import { DEFAULT_LOGIN_URL, DEFAULT_API_VERSION } from "./config.js";
import { saveToken, tokenPath, type SfCredentials } from "./auth.js";

interface LoginOptions {
  clientId: string;
  clientSecret?: string; // optional — public PKCE clients omit it
  loginUrl: string;
  scope: string;
  callbackPort: number;
}

function parseArgs(argv: string[]): LoginOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const clientId = get("--client-id") || process.env.SF_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "Missing client id. Pass --client-id <consumerKey> or set SF_CLIENT_ID " +
        "(the consumer key of your Salesforce External Client App)."
    );
  }
  return {
    clientId,
    clientSecret: get("--client-secret") || process.env.SF_CLIENT_SECRET,
    loginUrl: get("--login-url") || DEFAULT_LOGIN_URL,
    scope: get("--scope") || process.env.SF_SCOPE || "api refresh_token",
    callbackPort: Number(get("--port") || process.env.SF_CALLBACK_PORT || 1717),
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`, () => {
    /* if it fails, the URL is already printed for manual use */
  });
}

/**
 * Run the authorization-code + PKCE flow against a Salesforce External Client
 * App, exchange the code for a token, persist it, and print ready-to-paste
 * Claude Code config. The gateway never sees the client secret in this model.
 */
export async function runLogin(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const { verifier, challenge } = pkce();
  const redirectUri = `http://localhost:${opts.callbackPort}/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL(`${opts.loginUrl}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", opts.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", opts.scope);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, redirectUri);
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html" }).end(
          `<h2>Login failed</h2><p>${err}: ${url.searchParams.get("error_description") ?? ""}</p>`
        );
        server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html" }).end("<h2>State mismatch</h2>");
        server.close();
        reject(new Error("OAuth state mismatch — possible CSRF, aborting."));
        return;
      }
      const got = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" }).end(
        "<h2>Authenticated ✓</h2><p>You can close this tab and return to your terminal.</p>"
      );
      server.close();
      if (got) resolve(got);
      else reject(new Error("No authorization code returned."));
    });
    server.listen(opts.callbackPort, () => {
      console.error(`\nOpening Salesforce login in your browser…`);
      console.error(`If it does not open, visit:\n${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });
  });

  // Exchange the code for a token (PKCE; secret only sent if provided).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const resp = await fetch(`${opts.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await resp.json()) as Record<string, string>;
  if (!resp.ok || !json.access_token) {
    throw new Error(
      `Token exchange failed: ${json.error ?? resp.status} ${json.error_description ?? ""}`
    );
  }

  const creds: SfCredentials = {
    accessToken: json.access_token,
    instanceUrl: json.instance_url,
    apiVersion: DEFAULT_API_VERSION,
    refreshToken: json.refresh_token,
    clientId: opts.clientId,
    loginUrl: opts.loginUrl,
  };
  saveToken(creds);

  console.error(`\n✓ Logged in. Token saved to ${tokenPath()}`);
  console.error(`  Instance: ${creds.instanceUrl}\n`);
  console.error("Add to Claude Code (stdio) with:\n");
  console.error("  claude mcp add salesforce -- npx -y @imazhar101/salesforce-mcp-jsforce\n");
  console.error("…or paste into .mcp.json:\n");
  console.error(
    JSON.stringify(
      {
        mcpServers: {
          salesforce: {
            command: "npx",
            args: ["-y", "@imazhar101/salesforce-mcp-jsforce"],
            env: {
              SF_ACCESS_TOKEN: creds.accessToken,
              SF_INSTANCE_URL: creds.instanceUrl,
            },
          },
        },
      },
      null,
      2
    )
  );
  console.error(
    "\n(The token file is already read automatically, so the env block above is optional.)\n"
  );
}
