import os from "node:os";
import path from "node:path";

/** Package identity (kept in sync with package.json). */
export const PKG_NAME = "salesforce-mcp-jsforce";
export const PKG_VERSION = "0.2.0";

/** Salesforce REST API version used for all jsforce connections. */
export const DEFAULT_API_VERSION = process.env.SF_API_VERSION || "62.0";

/**
 * OAuth login host. Production: https://login.salesforce.com.
 * Sandbox: https://test.salesforce.com (or your My Domain URL).
 */
export const DEFAULT_LOGIN_URL =
  process.env.SF_LOGIN_URL || "https://login.salesforce.com";

/** Where the `login` command persists the issued token for stdio use. */
export const CONFIG_DIR =
  process.env.SF_MCP_CONFIG_DIR || path.join(os.homedir(), ".config", PKG_NAME);
export const TOKEN_FILE = path.join(CONFIG_DIR, "token.json");

/**
 * Read-only mode strips all write tools (create/update/delete). Recommended
 * for the publicly hosted server. Set SF_READONLY=1 to enable.
 */
export const READ_ONLY =
  process.env.SF_READONLY === "1" || process.env.SF_READONLY === "true";
