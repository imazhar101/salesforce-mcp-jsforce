# salesforce-mcp-jsforce

A **lite, single-org** [Model Context Protocol](https://modelcontextprotocol.io) server for Salesforce, built on [jsforce](https://github.com/jsforce/jsforce).

- **Bring your own token.** The server never stores a client secret, username, or password. You authenticate once with OAuth; it holds only an access token + instance URL.
- **Two ways to run.** Locally over **stdio** (for Claude Code and other MCP clients) or as a **dedicated streamable-HTTP server** where each request carries its own token.
- **Safe to host & open-source.** No org-specific config, no multi-environment credential matrix, no destructive metadata tooling. Optional read-only mode.

## Tools

| Tool | Mode | Description |
| --- | --- | --- |
| `salesforce_identity` | read | Identity of the supplied token (token validity check) |
| `salesforce_query` | read | Run a SOQL query |
| `salesforce_search` | read | Run a SOSL full-text search |
| `salesforce_list_objects` | read | List sObjects + key metadata |
| `salesforce_describe_object` | read | Trimmed describe of an sObject |
| `salesforce_get_record` | read | Retrieve a record by Id |
| `salesforce_create_record` | write | Create a record |
| `salesforce_update_record` | write | Update a record |
| `salesforce_delete_record` | write | Delete a record |

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

## Credentials

**stdio** — one of:

- `SF_ACCESS_TOKEN` + `SF_INSTANCE_URL` environment variables, or
- the token file written by `login` (read automatically).

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

```bash
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "X-SF-Access-Token: $SF_ACCESS_TOKEN" \
  -H "X-SF-Instance-Url: $SF_INSTANCE_URL" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `SF_ACCESS_TOKEN` | — | stdio access token |
| `SF_INSTANCE_URL` | — | stdio instance URL |
| `SF_API_VERSION` | `62.0` | REST API version |
| `SF_READONLY` | off | `1` strips write tools |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | OAuth host (sandbox: `test.salesforce.com`) |
| `SF_CLIENT_ID` | — | ECA consumer key for `login` |
| `SF_CLIENT_SECRET` | — | only for confidential apps |
| `SF_SCOPE` | `api refresh_token` | OAuth scopes |
| `PORT` | `3000` | HTTP host port |

## Security model

- The token grants exactly the permissions of the user who authorized it — the server adds no privilege.
- In HTTP mode no credentials are persisted; the token lives only for the duration of one request.
- In stdio mode the saved token file is written `chmod 600`.
- Tokens are never logged.

## Build from source

```bash
npm install
npm run build
node dist/index.js --help
```

## License

MIT
