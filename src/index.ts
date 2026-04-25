import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Firestore } from "firebase-admin/firestore";
import { getDb } from "./firestore-client.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerActivityTools } from "./tools/activity.js";

// Lazy Firestore proxy: defers getDb() until first property access. Lets the
// MCP server boot without real credentials so tooling (Glama inspection, MCP
// discovery, `--list-tools`-style probes) can enumerate tools. Tool calls will
// still fail with the original "GOOGLE_APPLICATION_CREDENTIALS required"
// error if creds aren't set, but the server itself comes up clean.
const db = new Proxy({} as Firestore, {
  get(_target, prop) {
    const realDb = getDb() as unknown as Record<string | symbol, unknown>;
    const value = realDb[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(realDb) : value;
  },
});

const server = new McpServer({
  name: "agent-board",
  version: "1.0.0",
});

registerProjectTools(server, db);
registerTaskTools(server, db);
registerSessionTools(server, db);
registerActivityTools(server, db);

const transport = new StdioServerTransport();
await server.connect(transport);
