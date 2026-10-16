// Hawkes Studio as an MCP server (stdio), so Claude Code in any project folder can read the daily report and
// backlog, start playtests and builds, and prepare deploys. It talks to the running service over HTTP (the cloud,
// through ~/.hawkes/client.json, or this PC). The tools are in mcp-tools.ts; /mcp on the service serves the same ones
// over HTTP for Claude anywhere (docs/cloud.md).
//
//   .mcp.json: { "mcpServers": { "hawkesstudio": { "command": "node", "args": ["C:/Projects/hawkesstudio/bin/studio-mcp.mjs"] } } }

import { serveStdio } from './mcp-core.ts';
import { studioMcp } from './mcp-tools.ts';

serveStdio(studioMcp());
