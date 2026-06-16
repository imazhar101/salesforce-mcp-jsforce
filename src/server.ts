import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PKG_NAME, PKG_VERSION, READ_ONLY } from "./config.js";
import type { CredentialResolver } from "./auth.js";
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
 * Build a fully wired MCP server. `getCreds` is invoked lazily, once per tool
 * call — so `tools/list` works with no token present, and the HTTP host can
 * hand each request its own per-caller credentials.
 *
 * @param readOnly when true, write tools are not registered at all.
 */
export function buildServer(
  getCreds: CredentialResolver,
  readOnly: boolean = READ_ONLY
): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  const conn = () => sf.makeConnection(getCreds());

  // ── Read tools ───────────────────────────────────────────────────────────────

  server.tool(
    "salesforce_identity",
    "Return the identity (user, org, instance) of the supplied token. Use this to confirm the connection is authenticated.",
    {},
    async () => {
      try {
        return ok(await sf.identity(conn()));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "salesforce_query",
    "Run a SOQL query and return matching records.",
    { soql: z.string().describe("A SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10") },
    async ({ soql }) => {
      try {
        return ok(await sf.soqlQuery(conn(), soql));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "salesforce_search",
    "Run a SOSL full-text search across objects.",
    { sosl: z.string().describe("A SOSL search, e.g. FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)") },
    async ({ sosl }) => {
      try {
        return ok(await sf.soslSearch(conn(), sosl));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "salesforce_list_objects",
    "List all sObjects available in the org with their key metadata.",
    {},
    async () => {
      try {
        return ok(await sf.listObjects(conn()));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "salesforce_describe_object",
    "Describe an sObject: its fields, types, picklist values, and references (trimmed payload).",
    { object_name: z.string().describe("API name of the object, e.g. Account or Custom__c") },
    async ({ object_name }) => {
      try {
        return ok(await sf.describeObject(conn(), object_name));
      } catch (e) {
        return fail(e);
      }
    }
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
    },
    async ({ object_name, record_id, fields }) => {
      try {
        return ok(await sf.getRecord(conn(), object_name, record_id, fields));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Write tools (skipped entirely in read-only mode) ──────────────────────────

  if (!readOnly) {
    server.tool(
      "salesforce_create_record",
      "Create a new record on the given object.",
      {
        object_name: z.string().describe("API name of the object, e.g. Contact"),
        data: z
          .record(z.any())
          .describe("Field API name → value map for the new record"),
      },
      async ({ object_name, data }) => {
        try {
          return ok(await sf.createRecord(conn(), object_name, data));
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.tool(
      "salesforce_update_record",
      "Update fields on an existing record.",
      {
        object_name: z.string().describe("API name of the object"),
        record_id: z.string().describe("The Id of the record to update"),
        data: z.record(z.any()).describe("Field API name → new value map"),
      },
      async ({ object_name, record_id, data }) => {
        try {
          return ok(await sf.updateRecord(conn(), object_name, record_id, data));
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.tool(
      "salesforce_delete_record",
      "Delete a record by Id.",
      {
        object_name: z.string().describe("API name of the object"),
        record_id: z.string().describe("The Id of the record to delete"),
      },
      async ({ object_name, record_id }) => {
        try {
          return ok(await sf.deleteRecord(conn(), object_name, record_id));
        } catch (e) {
          return fail(e);
        }
      }
    );
  }

  return server;
}
