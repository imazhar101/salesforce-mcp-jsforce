import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PKG_NAME, PKG_VERSION, READ_ONLY } from "./config.js";
import type { CredentialResolver, SfCredentials } from "./auth.js";
import * as sf from "./client.js";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
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
      "Internal: per-request Salesforce credentials injected by an MCP gateway. " +
        "Leave unset in direct use — the server falls back to env/token-file creds.",
    ),
};

type ToolArgs = { _sfAuth?: SfCredentials } & Record<string, unknown>;

function perCallCreds(args: ToolArgs): SfCredentials | undefined {
  const a = args?._sfAuth;
  if (a && a.accessToken && a.instanceUrl) {
    return { accessToken: a.accessToken, instanceUrl: a.instanceUrl, apiVersion: a.apiVersion };
  }
  return undefined;
}

/**
 * Build a fully wired MCP server. Credentials resolve lazily, once per tool
 * call: a per-request `_sfAuth` (gateway-injected) wins; otherwise the supplied
 * resolver (env/token-file) is used. `tools/list` works with no token present.
 *
 * @param readOnly when true, write tools are not registered at all.
 */
export function buildServer(
  getCreds: CredentialResolver,
  readOnly: boolean = READ_ONLY,
): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  const conn = (args: ToolArgs = {}) => sf.makeConnection(perCallCreds(args) ?? getCreds());

  // ── Read tools ───────────────────────────────────────────────────────────────

  server.tool(
    "salesforce_identity",
    "Return the identity (user, org, instance) of the supplied token. Use this to confirm the connection is authenticated.",
    { ...BYO_AUTH },
    async (args) => {
      try {
        return ok(await sf.identity(conn(args)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "salesforce_query",
    "Run a SOQL query and return matching records.",
    {
      soql: z.string().describe("A SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10"),
      ...BYO_AUTH,
    },
    async (args) => {
      try {
        return ok(await sf.soqlQuery(conn(args), args.soql));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "salesforce_search",
    "Run a SOSL full-text search across objects.",
    {
      sosl: z
        .string()
        .describe("A SOSL search, e.g. FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)"),
      ...BYO_AUTH,
    },
    async (args) => {
      try {
        return ok(await sf.soslSearch(conn(args), args.sosl));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "salesforce_list_objects",
    "List all sObjects available in the org with their key metadata.",
    { ...BYO_AUTH },
    async (args) => {
      try {
        return ok(await sf.listObjects(conn(args)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "salesforce_describe_object",
    "Describe an sObject: its fields, types, picklist values, and references (trimmed payload).",
    {
      object_name: z.string().describe("API name of the object, e.g. Account or Custom__c"),
      ...BYO_AUTH,
    },
    async (args) => {
      try {
        return ok(await sf.describeObject(conn(args), args.object_name));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "salesforce_get_record",
    "Retrieve a single record by Id, optionally limited to specific fields.",
    {
      object_name: z.string().describe("API name of the object, e.g. Account"),
      record_id: z.string().describe("The 15- or 18-char record Id"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Optional list of field API names; omit for all fields"),
      ...BYO_AUTH,
    },
    async (args) => {
      try {
        return ok(await sf.getRecord(conn(args), args.object_name, args.record_id, args.fields));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Write tools (skipped entirely in read-only mode) ──────────────────────────

  if (!readOnly) {
    server.tool(
      "salesforce_create_record",
      "Create a new record on the given object.",
      {
        object_name: z.string().describe("API name of the object, e.g. Contact"),
        data: z.record(z.any()).describe("Field API name → value map for the new record"),
        ...BYO_AUTH,
      },
      async (args) => {
        try {
          return ok(await sf.createRecord(conn(args), args.object_name, args.data));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.tool(
      "salesforce_update_record",
      "Update fields on an existing record.",
      {
        object_name: z.string().describe("API name of the object"),
        record_id: z.string().describe("The Id of the record to update"),
        data: z.record(z.any()).describe("Field API name → new value map"),
        ...BYO_AUTH,
      },
      async (args) => {
        try {
          return ok(await sf.updateRecord(conn(args), args.object_name, args.record_id, args.data));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.tool(
      "salesforce_delete_record",
      "Delete a record by Id.",
      {
        object_name: z.string().describe("API name of the object"),
        record_id: z.string().describe("The Id of the record to delete"),
        ...BYO_AUTH,
      },
      async (args) => {
        try {
          return ok(await sf.deleteRecord(conn(args), args.object_name, args.record_id));
        } catch (e) {
          return fail(e);
        }
      },
    );
  }

  return server;
}
