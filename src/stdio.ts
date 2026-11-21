#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { INSTRUCTIONS, SITE, VERSION, runTool, toolList, type Ctx } from "./core.js";

const ctx: Ctx = { base: (process.env.SHIELDZ_SWAP_BASE_URL || SITE).replace(/\/+$/, "") };

const server = new Server(
  { name: "shieldz-swap", version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => runTool(ctx, req.params.name, req.params.arguments));

await server.connect(new StdioServerTransport());
console.error(`shieldz-swap-mcp ${VERSION} ready (${ctx.base})`);
