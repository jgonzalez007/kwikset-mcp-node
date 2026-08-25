#!/usr/bin/env node
// MCP server exposing your Kwikset Halo / Halo Touch / Halo Select locks as
// tools Claude can call. Run once, locally, after `node auth-setup.js` has
// saved a session:
//
//     node src/server.js
//
// or point a Claude Desktop / Claude Code MCP config at this file (see
// README.md). Communicates over stdio, as MCP local servers normally do.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KwiksetClient, KwiksetAuthError, NotFoundError } from "./kwikset-client.js";

const server = new McpServer({
  name: "kwikset",
  version: "0.1.0",
});

async function withClient(fn) {
  const client = new KwiksetClient();
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    if (err instanceof KwiksetAuthError) {
      return { error: "auth_required", message: err.message };
    }
    if (err instanceof NotFoundError) {
      return { error: "not_found", message: err.message };
    }
    return { error: "kwikset_api_error", message: String(err.message || err) };
  }
}

function toResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

server.tool(
  "list_locks",
  "List every Kwikset lock on the account, with its current status, " +
    "battery percentage, and the home it belongs to. Call this first to " +
    "find a lock's device_id before locking/unlocking/checking it.",
  {},
  async () => toResult(await withClient((c) => c.listLocks()))
);

server.tool(
  "get_lock_status",
  "Get the current status (locked/unlocked/jammed), battery level, and " +
    "model/serial for one lock. Get device_id from list_locks first.",
  { device_id: z.string().describe("A lock's device_id, from list_locks") },
  async ({ device_id }) =>
    toResult(await withClient((c) => c.getLockStatus(device_id)))
);

server.tool(
  "lock_door",
  "Lock a Kwikset door. Get device_id from list_locks first.",
  { device_id: z.string().describe("A lock's device_id, from list_locks") },
  async ({ device_id }) => toResult(await withClient((c) => c.lock(device_id)))
);

server.tool(
  "unlock_door",
  "Unlock a Kwikset door. This is a physical-security-sensitive action - " +
    "only call this after the user has explicitly asked to unlock this " +
    "specific door, and pass confirm=true. Calling with confirm=false " +
    "(the default) is a no-op that returns a reminder instead of unlocking.",
  {
    device_id: z.string().describe("A lock's device_id, from list_locks"),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually unlock the door."),
  },
  async ({ device_id, confirm }) => {
    if (!confirm) {
      return toResult({
        error: "confirmation_required",
        message:
          "Pass confirm=true to actually unlock the door. This guard " +
          "exists so the lock only opens on an explicit, unambiguous " +
          "user request.",
      });
    }
    return toResult(await withClient((c) => c.unlock(device_id)));
  }
);

server.tool(
  "debug_raw_devices",
  "Diagnostic tool: dumps the raw, unprocessed home/device JSON straight " +
    "from Kwikset's API. Use this only when another tool returns null " +
    "fields (name/status/battery, etc) - that means Kwikset renamed a " +
    "field this server looks for, and this shows the real field names.",
  {},
  async () => toResult(await withClient((c) => c.debugRawDevices()))
);

const transport = new StdioServerTransport();
await server.connect(transport);
