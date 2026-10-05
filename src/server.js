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
import {
  KwiksetClient,
  KwiksetAuthError,
  NotFoundError,
  ValidationError,
} from "./kwikset-client.js";

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
    if (err instanceof ValidationError) {
      return { error: "validation_error", message: err.message };
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
    "find a lock's device_id before locking/unlocking/checking it. When " +
    "status_may_be_stale is true the lock is offline and status/battery " +
    "are its last report (see last_updated) - say so rather than " +
    "presenting them as live.",
  {},
  async () => toResult(await withClient((c) => c.listLocks()))
);

server.tool(
  "get_lock_status",
  "Get the current status (locked/unlocked/jammed), battery level, and " +
    "model/serial for one lock. Get device_id from list_locks first. " +
    "status_may_be_stale=true means the lock is offline and these values " +
    "are its last report (see last_updated).",
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

// ---------------------------------------------------------------------
// Access code tools - built against REAL Kwikset endpoints and wire
// format (confirmed by decompiling the real Android app; see the
// "Known limitations" comment above the access-code section of
// kwikset-client.js and the comments in access-code-codec.js for the
// Schedule byte format). The lock assigns slots and reports them back;
// deletes are limited to those reported slots. Known gaps vs. the real
// app, all documented there: no live "list codes" read (local tracking
// only), and no edit (remove + re-add instead).
// ---------------------------------------------------------------------

server.tool(
  "list_access_codes",
  "List the keypad access codes THIS SERVER has created on a lock. " +
    "Kwikset's API has no endpoint to read codes back from the lock " +
    "itself, so this only shows codes added/removed through this server " +
    "- it will NOT show codes added via the Kwikset app or the keypad. " +
    "slot_confirmed=true means the lock reported that slot, and only those " +
    "codes can be removed with remove_access_code. " +
    "Get device_id from list_locks first.",
  { device_id: z.string().describe("A lock's device_id, from list_locks") },
  async ({ device_id }) =>
    toResult(await withClient((c) => c.listAccessCodes(device_id)))
);

const timeOfDayShape = {
  hour: z.number().int().min(0).max(23).describe("24-hour local hour, 0-23"),
  minute: z.number().int().min(0).max(59).describe("Local minute, 0-59"),
};

const scheduleSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("date_range"),
      start: z
        .object({
          year: z.number().int().min(2000).max(2127),
          month: z.number().int().min(1).max(12),
          day: z.number().int().min(1).max(31),
          ...timeOfDayShape,
        })
        .describe("Local date/time the code starts working."),
      end: z
        .object({
          year: z.number().int().min(2000).max(2127),
          month: z.number().int().min(1).max(12),
          day: z.number().int().min(1).max(31),
          ...timeOfDayShape,
        })
        .describe("Local date/time the code stops working."),
    }),
    z.object({
      type: z.literal("weekly"),
      start: z.object(timeOfDayShape).describe("Local time-of-day the code starts working."),
      end: z.object(timeOfDayShape).describe("Local time-of-day the code stops working."),
      days: z
        .object({
          sunday: z.boolean().optional(),
          monday: z.boolean().optional(),
          tuesday: z.boolean().optional(),
          wednesday: z.boolean().optional(),
          thursday: z.boolean().optional(),
          friday: z.boolean().optional(),
          saturday: z.boolean().optional(),
        })
        .describe("Which days of the week the schedule applies to."),
    }),
  ])
  .describe(
    "Optional. Omit for a permanent, always-allowed code. All date/time " +
      "fields are local wall-clock time (the lock's own timezone), not UTC " +
      "or epoch time."
  );

server.tool(
  "add_access_code",
  "Add a keypad access code to a lock, either permanent or restricted to " +
    "a date range or weekly schedule. This creates a real, working entry " +
    "credential on a physical door - only call this after the user has " +
    "explicitly asked for a code to be added, and pass confirm=true. " +
    "Calling with confirm=false (the default) is a no-op. The lock picks " +
    "a free slot itself (it never overwrites an existing code) and the " +
    "result reports which slot it chose. Codes must be 4-8 digits, must " +
    "not start with 999999, and their first 4 digits must differ from " +
    "every other code on the lock - this server can only check that " +
    "against codes it created, so the lock may still reject a clash with " +
    "a code set in the Kwikset app. Refused if the lock is offline.",
  {
    device_id: z.string().describe("A lock's device_id, from list_locks"),
    name: z.string().describe("A label for this code, e.g. 'Dog walker'"),
    code: z
      .string()
      .describe("The numeric PIN to add, as a string, 4-8 digits (e.g. '482913')"),
    schedule: scheduleSchema.optional(),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually add the code."),
  },
  async ({ device_id, name, code, schedule, confirm }) => {
    if (!confirm) {
      return toResult({
        error: "confirmation_required",
        message:
          "Pass confirm=true to actually add this code. This guard exists " +
          "so a new entry credential is only created on an explicit, " +
          "unambiguous user request.",
      });
    }
    return toResult(
      await withClient((c) => c.addAccessCode(device_id, { name, code, schedule }))
    );
  }
);

server.tool(
  "remove_access_code",
  "Remove a keypad access code from a lock. Only codes this server " +
    "created whose slot the lock confirmed (slot_confirmed=true in " +
    "list_access_codes) can be removed; anything else is refused, because " +
    "a delete sent to the wrong slot erases whatever code lives there. " +
    "Codes set in the Kwikset app must be removed in the app. This revokes " +
    "a real entry credential - only call this after an explicit user " +
    "request, and pass confirm=true. Refused if the lock is offline.",
  {
    device_id: z.string().describe("A lock's device_id, from list_locks"),
    slot: z
      .number()
      .int()
      .min(0)
      .max(255)
      .describe("A confirmed slot from list_access_codes"),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually remove the code."),
  },
  async ({ device_id, slot, confirm }) => {
    if (!confirm) {
      return toResult({
        error: "confirmation_required",
        message:
          "Pass confirm=true to actually remove this code. This guard " +
          "exists so an entry credential is only revoked on an explicit, " +
          "unambiguous user request.",
      });
    }
    return toResult(await withClient((c) => c.removeAccessCode(device_id, slot)));
  }
);

server.tool(
  "debug_raw_access_codes",
  "Diagnostic tool: dumps the raw response from Kwikset's real " +
    "CRC/checksum manifest endpoint (getOverallAccessCodeCrc). This is " +
    "NOT a way to see code contents - Kwikset's API genuinely has no such " +
    "endpoint - it's a sync-verification manifest only. Use " +
    "list_access_codes for the codes this server has actually set.",
  { device_id: z.string().describe("A lock's device_id, from list_locks") },
  async ({ device_id }) =>
    toResult(await withClient((c) => c.debugRawAccessCodes(device_id)))
);

const transport = new StdioServerTransport();
await server.connect(transport);
