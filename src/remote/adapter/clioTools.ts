/**
 * Registration adapter for the upstream Clio tools (M4). It does two things without editing the
 * upstream tool files:
 *   1. Prefixes every tool name with `clio_` (the connector's namespace).
 *   2. Merges in MCP annotations (PRD §M4) — read tools are read-only, writes are flagged
 *      destructive/non-destructive — so clients can surface the right warning before a call.
 *
 * Per-user token injection is orthogonal: the tool handlers resolve the caller's Clio token through
 * clioClient.ts's AsyncLocalStorage seam, which the /mcp handler populates per request (see
 * src/remote/mcp/api.ts). So the adapter only rewrites the registration surface.
 *
 * `authenticate`/`logout`/`auth_status` are intentionally NOT ported (auth is connector-level now,
 * replaced by clio_whoami); neither is `export_audit_log` (D1 export is out-of-band, PRD §M5).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { registerMatterTools } from "../../tools/matters.js";
import { registerContactTools } from "../../tools/contacts.js";
import { registerDocumentTools } from "../../tools/documents.js";
import { registerTaskTools } from "../../tools/tasks.js";
import { registerCalendarTools } from "../../tools/calendar.js";
import { registerActivityTools } from "../../tools/activities.js";
import { registerBillingTools } from "../../tools/billing.js";
import { registerNoteTools } from "../../tools/notes.js";
import { registerUserTools } from "../../tools/users.js";

const TOOL_PREFIX = "clio_";

// Tools that can't work on the remote connector and so are not registered. `upload_document` reads
// a local file by absolute path (fs.stat/fs.open) — that path lives on the user's machine, which a
// Cloudflare Worker can't reach, so it would only ever error. Dropping it avoids advertising a
// tool that always fails. (Its document read tools, list_documents/get_document, are network-only
// and work fine.)
const REMOTE_INCOMPATIBLE_TOOLS = new Set(["upload_document"]);

// Read tools: never mutate, and reach an external system (Clio) so results aren't a closed world.
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
// Additive create tools: write, not idempotent, but don't destroy/overwrite existing data.
const CREATE: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: false };
// State-mutating writes (update/complete an existing task): may overwrite prior state.
const MUTATE: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: true };

export const CLIO_TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Reads.
  list_matters: READ, get_matter: READ,
  search_contacts: READ, get_contact: READ,
  list_documents: READ, get_document: READ,
  list_tasks: READ,
  list_calendar_entries: READ, list_calendars: READ,
  list_time_entries: READ,
  get_billing_summary: READ,
  list_users: READ, get_user: READ,
  // Additive creates.
  create_matter: CREATE, create_task: CREATE,
  create_calendar_entry: CREATE, log_time_entry: CREATE, create_activity: CREATE, create_note: CREATE,
  // State-mutating writes.
  update_task: MUTATE, complete_task: MUTATE,
};

/**
 * Wrap an McpServer so each `registerTool(name, config, cb)` lands as `clio_<name>` with the
 * tool's annotations merged in. A Proxy keeps every other McpServer member intact, so the
 * unmodified upstream register functions can drive it directly.
 */
export function withClioToolPrefix(server: McpServer): McpServer {
  const registerTool = (name: string, config: { annotations?: ToolAnnotations } & Record<string, unknown>, cb: unknown) => {
    if (REMOTE_INCOMPATIBLE_TOOLS.has(name)) return; // never registered on the Worker
    const annotations = CLIO_TOOL_ANNOTATIONS[name];
    const merged = annotations ? { ...config, annotations: { ...config.annotations, ...annotations } } : config;
    return (server.registerTool as (...args: unknown[]) => unknown)(`${TOOL_PREFIX}${name}`, merged, cb);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return registerTool;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Register the 21 portable upstream Clio data tools onto `server`, clio_-prefixed and annotated. */
export function registerClioDataTools(server: McpServer): void {
  const s = withClioToolPrefix(server);
  registerMatterTools(s);
  registerContactTools(s);
  registerDocumentTools(s);
  registerTaskTools(s);
  registerCalendarTools(s);
  registerActivityTools(s);
  registerBillingTools(s);
  registerNoteTools(s);
  registerUserTools(s);
}
