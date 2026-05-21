#!/usr/bin/env node
import dotenv from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./auth/authTools.js";
import { registerMatterTools } from "./tools/matters.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerResources } from "./resources/index.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '../.env') });

const server = new McpServer({
    name: "clio-mcp",
    version: "1.0.0",
});

registerAuthTools(server);
registerResources(server);

registerMatterTools(server);
registerContactTools(server);
registerDocumentTools(server);
registerTaskTools(server);
registerCalendarTools(server);
registerActivityTools(server);
registerBillingTools(server);
registerNoteTools(server);

async function main() {
    const missing = (["CLIO_CLIENT_ID", "CLIO_CLIENT_SECRET"] as const)
        .filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.error(`[startup] Fatal: missing required env var(s): ${missing.join(", ")}. Check your .env file.`);
        process.exit(1);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Clio MCP server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
