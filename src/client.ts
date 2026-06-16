import jsforce from "jsforce";
import type { SfCredentials } from "./auth.js";
import { DEFAULT_API_VERSION } from "./config.js";

/**
 * Build a jsforce connection from BYO credentials. jsforce's constructor takes
 * `{ accessToken, instanceUrl }` directly, which is exactly the per-request
 * model — so a fresh connection per call is cheap and carries no shared state.
 */
export function makeConnection(creds: SfCredentials): jsforce.Connection {
  return new jsforce.Connection({
    instanceUrl: creds.instanceUrl,
    accessToken: creds.accessToken,
    version: creds.apiVersion || DEFAULT_API_VERSION,
  });
}

export type Conn = jsforce.Connection;

// ── Read operations ───────────────────────────────────────────────────────────

/** Who does this token belong to? Cheapest possible token-validity check. */
export async function identity(conn: Conn) {
  const id = await conn.identity();
  return {
    user_id: id.user_id,
    organization_id: id.organization_id,
    username: id.username,
    display_name: id.display_name,
    email: id.email,
    instance_url: conn.instanceUrl,
    api_version: conn.version,
  };
}

export async function soqlQuery(conn: Conn, soql: string) {
  const result = await conn.query(soql);
  return {
    totalSize: result.totalSize,
    done: result.done,
    nextRecordsUrl: result.nextRecordsUrl ?? null,
    records: stripAttributes(result.records),
  };
}

/** SOSL full-text search across objects. */
export async function soslSearch(conn: Conn, sosl: string) {
  const result = await conn.search(sosl);
  return { searchRecords: stripAttributes(result.searchRecords as any[]) };
}

export async function listObjects(conn: Conn) {
  const g = await conn.describeGlobal();
  return {
    count: g.sobjects.length,
    sobjects: g.sobjects.map((s) => ({
      name: s.name,
      label: s.label,
      custom: s.custom,
      keyPrefix: s.keyPrefix,
      queryable: s.queryable,
      createable: s.createable,
      updateable: s.updateable,
      deletable: s.deletable,
    })),
  };
}

/** Lean describe — the full payload is enormous, so we trim to the essentials. */
export async function describeObject(conn: Conn, objectName: string) {
  const d = await conn.sobject(objectName).describe();
  return {
    name: d.name,
    label: d.label,
    keyPrefix: d.keyPrefix,
    custom: d.custom,
    createable: d.createable,
    updateable: d.updateable,
    deletable: d.deletable,
    queryable: d.queryable,
    fields: d.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      custom: f.custom,
      nillable: f.nillable,
      updateable: f.updateable,
      length: f.length || undefined,
      referenceTo: f.referenceTo?.length ? f.referenceTo : undefined,
      picklistValues: f.picklistValues?.length
        ? f.picklistValues.filter((p) => p.active).map((p) => p.value)
        : undefined,
    })),
  };
}

export async function getRecord(
  conn: Conn,
  objectName: string,
  recordId: string,
  fields?: string[]
) {
  if (fields && fields.length) {
    const rows = await conn
      .sobject(objectName)
      .find({ Id: recordId }, fields)
      .limit(1)
      .execute();
    return stripAttributes(rows)[0] ?? null;
  }
  const rec = await conn.sobject(objectName).retrieve(recordId);
  return stripAttributes([rec as any])[0] ?? null;
}

// ── Write operations (omitted in read-only mode) ───────────────────────────────

export async function createRecord(
  conn: Conn,
  objectName: string,
  data: Record<string, unknown>
) {
  return conn.sobject(objectName).create(data as any);
}

export async function updateRecord(
  conn: Conn,
  objectName: string,
  recordId: string,
  data: Record<string, unknown>
) {
  return conn.sobject(objectName).update({ Id: recordId, ...data } as any);
}

export async function deleteRecord(
  conn: Conn,
  objectName: string,
  recordId: string
) {
  return conn.sobject(objectName).destroy(recordId);
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** jsforce decorates every record with a noisy `attributes` block — drop it. */
function stripAttributes<T>(records: T[]): T[] {
  return records.map((r) => {
    if (r && typeof r === "object" && "attributes" in (r as any)) {
      const { attributes, ...rest } = r as any;
      return rest;
    }
    return r;
  });
}
