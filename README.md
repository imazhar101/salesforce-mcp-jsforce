# salesforce-mcp-jsforce

A **lite, single-org** [Model Context Protocol](https://modelcontextprotocol.io) server for Salesforce, built on [jsforce](https://github.com/jsforce/jsforce).

- **Bring your own token.** The server never stores a username or password. You authenticate once with OAuth; it holds an access token + instance URL (plus, for stdio, a refresh token).
- **Sign in once.** An expired access token is renewed from the saved refresh token and the failed call retried, so a long-running client keeps working until the grant is revoked.
- **Two ways to run.** Locally over **stdio** (for Claude Code and other MCP clients) or as a **dedicated streamable-HTTP server** where each request carries its own token.
- **Safe to host & open-source.** No org-specific config, no multi-environment credential matrix, no destructive metadata tooling. Optional read-only mode.

## Tools

| Tool                         | Mode  | Description                                           |
| ---------------------------- | ----- | ----------------------------------------------------- |
| `salesforce_identity`        | read  | Identity of the supplied token (token validity check) |
| `salesforce_query`           | read  | Run a SOQL query                                      |
| `salesforce_search`          | read  | Run a SOSL full-text search                           |
| `salesforce_list_objects`    | read  | List sObjects + key metadata                          |
| `salesforce_describe_object` | read  | Trimmed describe of an sObject                        |
| `salesforce_get_record`      | read  | Retrieve a record by Id                               |
| `salesforce_create_record`   | write | Create a record                                       |
| `salesforce_update_record`   | write | Update a record                                       |
| `salesforce_delete_record`   | write | Delete a record                                       |

Set `SF_READONLY=1` to register the read tools only.

## Quick start

```bash
npm install -g @imazhar101/salesforce-mcp-jsforce

# 1. Log in (PKCE against your External Client App)
salesforce-mcp-jsforce login --client-id <ECA_CONSUMER_KEY>
#   sandbox: add --login-url https://test.salesforce.com

# 2. Use it from Claude Code
claude mcp add salesforce -- npx -y @imazhar101/salesforce-mcp-jsforce
```

`login` opens a browser, completes the OAuth handshake, saves the token to
`~/.config/salesforce-mcp-jsforce/token.json`, and prints ready-to-paste config.
Sign out (and revoke the grant at Salesforce) with `salesforce-mcp-jsforce logout`.

## Credentials

**stdio** — one of:

- the token file written by `login` (read automatically, **renewed automatically**), or
- `SF_ACCESS_TOKEN` + `SF_INSTANCE_URL` environment variables.

Env credentials win when both are present. They carry no refresh token, so they
cannot be renewed — prefer the token file unless something else is minting
short-lived tokens for you.

### Token renewal

Salesforce access tokens expire on the org's session policy, typically hours.
When a call fails with `INVALID_SESSION_ID`, the server runs the `refresh_token`
grant, writes the new token back to the token file (atomically, `0600`) and
retries the call once. Concurrent calls share a single refresh. Nothing is
retried a second time — if a freshly issued token is also rejected, the problem
is not token age.

Renewal needs `refreshToken`, `clientId` and `loginUrl` in the token file, which
`login` saves when the `refresh_token` scope is granted. HTTP callers and
gateway `_sfAuth` callers are passed through untouched: those tokens belong to
whoever minted them.

**HTTP** — per request, via headers:

- `X-SF-Access-Token`
- `X-SF-Instance-Url`
- `X-SF-Api-Version` (optional)

## Run as a dedicated HTTP server

```bash
PORT=3000 salesforce-mcp-jsforce http
```

Stateless streamable-HTTP at `POST /mcp`; health probe at `GET /health`. Each
request is handled by a throwaway server instance keyed to its own token — no
caller state is shared. Put it behind TLS; the access token is a live credential.

It binds **`127.0.0.1`** by default and rejects requests whose `Host`/`Origin`
is not loopback, which is what stops a page in your browser from reaching it by
DNS rebinding. To expose it, set `SF_MCP_HOST=0.0.0.0` **and**
`SF_MCP_ALLOWED_HOSTS=your.host` — deliberately, and behind a proxy that
authenticates, because this server authenticates nobody: it forwards whatever
token the request carries.

```bash
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "X-SF-Access-Token: $SF_ACCESS_TOKEN" \
  -H "X-SF-Instance-Url: $SF_INSTANCE_URL" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Environment variables

### Credentials and tools

| Var               | Default | Purpose                                                   |
| ----------------- | ------- | --------------------------------------------------------- |
| `SF_ACCESS_TOKEN` | —       | stdio access token — wins over the token file, no renewal |
| `SF_INSTANCE_URL` | —       | stdio instance URL                                        |
| `SF_API_VERSION`  | `62.0`  | REST API version                                          |
| `SF_READONLY`     | off     | `1` strips write tools                                    |

### `login`

| Var / flag                             | Default                            | Purpose                                                    |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `SF_CLIENT_ID` / `--client-id`         | —                                  | ECA consumer key (required)                                |
| `SF_LOGIN_URL` / `--login-url`         | `https://login.salesforce.com`     | OAuth host; must be https (sandbox: `test.salesforce.com`) |
| `SF_SCOPE` / `--scope`                 | `api refresh_token`                | OAuth scopes — drop `refresh_token` and renewal stops      |
| `SF_CALLBACK_PORT` / `--port`          | `1717`                             | Loopback callback port                                     |
| `SF_REDIRECT_URI` / `--redirect-uri`   | `http://localhost:<port>/callback` | Full callback URL; loopback hosts only                     |
| `SF_CLIENT_SECRET` / `--client-secret` | —                                  | Confidential clients only; public PKCE apps omit it        |
| `SF_LOGIN_TIMEOUT_MS`                  | `300000`                           | How long to wait for the browser round trip                |

The callback port and redirect URI must match what the Connected App registers.
Salesforce compares `redirect_uri` byte-for-byte, so a different port — or
`127.0.0.1` where the app registered `localhost` — fails the flow with
`redirect_uri_mismatch` before the sign-in screen appears.

### Server

| Var                     | Default                            | Purpose                                              |
| ----------------------- | ---------------------------------- | ---------------------------------------------------- |
| `SF_MCP_CONFIG_DIR`     | `~/.config/salesforce-mcp-jsforce` | Token storage location                               |
| `SF_MCP_HOST`           | `127.0.0.1`                        | HTTP bind address                                    |
| `SF_MCP_ALLOWED_HOSTS`  | —                                  | Extra `Host`/`Origin` values the HTTP server accepts |
| `SF_MCP_MAX_BODY_BYTES` | `1048576`                          | Request body ceiling                                 |
| `PORT`                  | `3000`                             | HTTP listen port                                     |

## Security model

- The token grants exactly the permissions of the user who authorized it — the server adds no privilege.
- In HTTP mode no credentials are persisted; the token lives only for the duration of one request.
- The stdio token file is written `0600` inside a `0700` directory, replaced atomically via a temp file + rename.
- Tokens are never logged and never printed by `login`. Errors returned to the model are redacted (session ids, bearer/refresh tokens, OAuth form fields).
- OAuth login is PKCE with a `state` check, requires an **https** login URL, and times out rather than waiting forever. The callback listens on the loopback interface only — both `127.0.0.1` and `::1`, since `localhost` resolves to either depending on the machine — and a busy port is a hard error, never a silent fallback that would let another process receive the authorization code. `--redirect-uri` is restricted to loopback hosts.
- The browser is launched via `spawn` with argv — never a shell string, so nothing in the URL reaches a shell.
- The HTTP listener is loopback-only by default, validates `Host`/`Origin`, and caps request bodies.
- `logout` revokes the grant at Salesforce, not just locally.

**Known limitation:** the refresh token is stored as plaintext JSON (`0600` in a
`0700` directory). That stops other local users, but not code running as you —
any process in your account can read it. An OS-keychain backend is tracked in
[#13](https://github.com/imazhar101/salesforce-mcp-jsforce/issues/13). Treat the
token file as a live credential, and run `logout` on a machine you are handing
off.

## Build from source

```bash
npm install
npm run build
node dist/index.js --help
```

## License

MIT
