import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PKG_NAME, PKG_VERSION, READ_ONLY } from './config.js'
import { redactSecrets, type CredentialResolver, type SfCredentials } from './auth.js'
import * as sf from './client.js'
import { createSessionRunner } from './session.js'

type TextResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function ok(data: unknown): TextResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/**
 * Errors go back to the model, so they are redacted first: Salesforce echoes
 * request material into `error_description`, and session ids turn up in error
 * bodies. A leaked token here would land in the transcript.
 */
function fail(error: unknown): TextResult {
  const raw = error instanceof Error ? error.message : String(error)
  // Carry Salesforce's errorCode through as well. When this server runs as a
  // gateway child the caller sees only this payload — an exception, and the
  // `errorCode` field a relay needs to recognise an expired session, never
  // reach it. Emitting the code lets that check be exact instead of matching
  // on message wording (#18). Additive: `error` keeps its existing shape.
  const code = (error as { errorCode?: unknown })?.errorCode
  const body: { error: string; errorCode?: string } = { error: redactSecrets(raw) }
  if (typeof code === 'string' && code) body.errorCode = code
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError: true,
  }
}

/**
 * Optional per-request credentials. An MCP gateway running this server as a
 * pooled stdio child injects each caller's BYO token into `_sfAuth` per
 * `tools/call`, so one process can serve many users at their own permission
 * level without the gateway storing any Salesforce credentials. In direct
 * (single-user) use this is omitted and the env/token-file resolver is used.
 */
const BYO_AUTH = {
  _sfAuth: z
    .object({
      accessToken: z.string(),
      instanceUrl: z.string(),
      apiVersion: z.string().optional(),
    })
    .optional()
    .describe(
      'Internal: per-request Salesforce credentials injected by an MCP gateway. ' +
        'Leave unset in direct use — the server falls back to env/token-file creds.',
    ),
}

type ToolArgs = { _sfAuth?: SfCredentials } & Record<string, unknown>

function perCallCreds(args: ToolArgs): SfCredentials | undefined {
  const a = args?._sfAuth
  if (a && a.accessToken && a.instanceUrl) {
    return { accessToken: a.accessToken, instanceUrl: a.instanceUrl, apiVersion: a.apiVersion }
  }
  return undefined
}

/**
 * Build a fully wired MCP server. Credentials resolve lazily, once per tool
 * call: a per-request `_sfAuth` (gateway-injected) wins; otherwise the supplied
 * resolver (env/token-file) is used. `tools/list` works with no token present.
 *
 * @param readOnly when true, write tools are not registered at all.
 * @param persist  called with renewed credentials after a silent token refresh;
 *                 stdio passes `saveToken`, hosted BYO callers pass nothing
 *                 because they own their own token lifecycle.
 */
export function buildServer(
  getCreds: CredentialResolver,
  readOnly: boolean = READ_ONLY,
  persist: (creds: SfCredentials) => void = () => {},
): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  )

  const session = createSessionRunner(getCreds, persist)

  /**
   * Run one Salesforce call. Resolver-backed credentials go through the session
   * runner, which renews an expired access token and retries once. Per-request
   * `_sfAuth` credentials are passed straight through: they arrive without
   * refresh material, so the caller that minted them owns renewing them.
   */
  const call = async <T>(
    args: ToolArgs,
    fn: (conn: sf.Conn) => Promise<T>,
  ): Promise<TextResult> => {
    try {
      const byo = perCallCreds(args)
      if (byo) return ok(await fn(sf.makeConnection(byo)))
      return ok(await session.run((creds) => fn(sf.makeConnection(creds))))
    } catch (e) {
      return fail(e)
    }
  }

  // ── Read tools ───────────────────────────────────────────────────────────────

  server.tool(
    'salesforce_identity',
    'Return the identity (user, org, instance) of the supplied token. Use this to confirm the connection is authenticated.',
    { ...BYO_AUTH },
    async (args) => call(args, (c) => sf.identity(c)),
  )

  server.tool(
    'salesforce_query',
    'Run a SOQL query and return matching records.',
    {
      soql: z.string().describe('A SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10'),
      ...BYO_AUTH,
    },
    async (args) => call(args, (c) => sf.soqlQuery(c, args.soql)),
  )

  server.tool(
    'salesforce_search',
    'Run a SOSL full-text search across objects.',
    {
      sosl: z
        .string()
        .describe('A SOSL search, e.g. FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)'),
      ...BYO_AUTH,
    },
    async (args) => call(args, (c) => sf.soslSearch(c, args.sosl)),
  )

  server.tool(
    'salesforce_list_objects',
    'List all sObjects available in the org with their key metadata.',
    { ...BYO_AUTH },
    async (args) => call(args, (c) => sf.listObjects(c)),
  )

  server.tool(
    'salesforce_describe_object',
    'Describe an sObject: its fields, types, picklist values, and references (trimmed payload).',
    {
      object_name: z.string().describe('API name of the object, e.g. Account or Custom__c'),
      ...BYO_AUTH,
    },
    async (args) => call(args, (c) => sf.describeObject(c, args.object_name)),
  )

  server.tool(
    'salesforce_get_record',
    'Retrieve a single record by Id, optionally limited to specific fields.',
    {
      object_name: z.string().describe('API name of the object, e.g. Account'),
      record_id: z.string().describe('The 15- or 18-char record Id'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Optional list of field API names; omit for all fields'),
      ...BYO_AUTH,
    },
    async (args) =>
      call(args, (c) => sf.getRecord(c, args.object_name, args.record_id, args.fields)),
  )

  // ── Write tools (skipped entirely in read-only mode) ──────────────────────────

  if (!readOnly) {
    server.tool(
      'salesforce_create_record',
      'Create a new record on the given object.',
      {
        object_name: z.string().describe('API name of the object, e.g. Contact'),
        data: z.record(z.any()).describe('Field API name → value map for the new record'),
        ...BYO_AUTH,
      },
      async (args) => call(args, (c) => sf.createRecord(c, args.object_name, args.data)),
    )

    server.tool(
      'salesforce_update_record',
      'Update fields on an existing record.',
      {
        object_name: z.string().describe('API name of the object'),
        record_id: z.string().describe('The Id of the record to update'),
        data: z.record(z.any()).describe('Field API name → new value map'),
        ...BYO_AUTH,
      },
      async (args) =>
        call(args, (c) => sf.updateRecord(c, args.object_name, args.record_id, args.data)),
    )

    server.tool(
      'salesforce_delete_record',
      'Delete a record by Id.',
      {
        object_name: z.string().describe('API name of the object'),
        record_id: z.string().describe('The Id of the record to delete'),
        ...BYO_AUTH,
      },
      async (args) => call(args, (c) => sf.deleteRecord(c, args.object_name, args.record_id)),
    )
  }

  return server
}
