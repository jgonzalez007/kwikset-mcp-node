# kwikset-mcp

An MCP server that lets Claude check and control Kwikset Halo-family smart
locks (Halo, Halo Keypad, Halo Touch, Halo Select / Select Plus).

This is a **Node.js rewrite** of an earlier Python version, switched to
avoid Python-specific setup friction on Windows (missing interpreter,
virtualenv activation, PATH aliasing). Node has no exact equivalent of
`aiokwikset` (the Python library the first version depended on), so this
version talks to Kwikset's cloud API directly: AWS Cognito for login, plus
a small REST API for homes/devices/lock/unlock.

**Where the API details came from:** Kwikset publishes no official API.
The Cognito pool/client IDs, API host, and REST paths this server uses
were extracted from the published, Apache-2.0-licensed source of
[`homebridge-kwikset-halo`](https://github.com/TreehouseFalcon/homebridge-kwikset-halo)
(a community Homebridge plugin for these same locks), which in turn credits
`aiokwikset` for first documenting them. See the comments in `src/const.js`
and `src/cognito.js` for specifics. **This is not officially supported by
Kwikset and could break if they change something server-side.**

**Testing status:** every piece of *logic* in this server — the Cognito
login flow (including the two-step phone-verification challenge), token
refresh and persistence, the REST field-mapping, the `unlock_door`
confirmation guard, and every MCP tool end-to-end — was exercised against
hand-written mocks standing in for AWS Cognito, Kwikset's REST API, and the
MCP SDK, and all of it passes. What could **not** be tested here is calling
the *real* Kwikset service, since that needs an actual account and a
physical lock. Treat your first `list_locks` call as the real smoke test —
if it fails outright (not just one field showing `null`), the pool/host
constants may be stale; if a tool returns nulls, run `debug_raw_devices`
to see the real field names and compare against `src/kwikset-client.js`.

If a tool call hangs and the MCP host eventually reports a generic
"timed out after 60s," that's the host's own outer timeout, not this
server's — every network call here (Cognito refresh, every REST request)
now has its own shorter internal timeout (15-20s) that fails with a
specific, readable error instead. If you see the generic 60s timeout
anyway, something below that layer is stuck (e.g. no network route to
AWS/Kwikset from this machine) — check that `node auth-setup.js` can
reach the internet at all.

## Why login is a separate step

Your Kwikset password should never pass through an LLM conversation. So
authentication happens once, in a plain terminal, via `auth-setup.js`,
which saves only the resulting session tokens locally (never the
password). The MCP server reads and silently refreshes those tokens on
every connection — it never asks Claude, or you via Claude, for your
password.

## Setup

1. **Install Node.js** (18+) if you don't have it: [nodejs.org](https://nodejs.org/)
   — get the LTS installer. Verify with:

   ```powershell
   node --version
   ```

2. **Install dependencies**, from inside this folder:

   ```bash
   npm install
   ```

3. **Log in once.** Credentials can be given three ways, checked in this
   order:

   ```bash
   # 1. CLI flags (any OS/shell)
   node auth-setup.js --email you@example.com --password "hunter2"
   ```

   ```bash
   # 2. Environment variables (preferred over the flag above - a
   #    command-line password is visible to other processes/users on the
   #    machine and lands in shell history)

   # macOS / Linux
   KWIKSET_EMAIL=you@example.com KWIKSET_PASSWORD='hunter2' node auth-setup.js
   ```

   ```powershell
   # Windows PowerShell
   $env:KWIKSET_EMAIL = "you@example.com"
   $env:KWIKSET_PASSWORD = "hunter2"
   node auth-setup.js
   ```

   ```bash
   # 3. Interactive prompt (any OS/shell; default if nothing else is given)
   node auth-setup.js
   ```

   If your account requires phone verification you'll be prompted for the
   code Kwikset texts you (or pass one up front with `--mfa-code` /
   `$KWIKSET_MFA_CODE`). This writes `~/.kwikset-mcp/tokens.json`
   (owner-read/write only) and never touches your password again after
   this step.

4. **Point Claude at the server.**

   For **Claude Code**, from this project directory:

   ```bash
   # macOS / Linux
   claude mcp add kwikset -- node "$(pwd)/src/server.js"
   ```

   ```powershell
   # Windows PowerShell
   claude mcp add kwikset -- node "$PWD\src\server.js"
   ```

   For **Claude Desktop**, add this to your `claude_desktop_config.json`
   (Settings → Developer → Edit Config), substituting the absolute path to
   this folder's `src/server.js`:

   ```json
   {
     "mcpServers": {
       "kwikset": {
         "command": "node",
         "args": ["/absolute/path/to/kwikset-mcp/src/server.js"]
       }
     }
   }
   ```

   On Windows, use double backslashes in the JSON path, e.g.
   `"C:\\Users\\you\\kwikset-mcp\\src\\server.js"`.

   Then restart the Claude client so it picks up the new server.

5. **Try it.** Ask Claude something like "list my Kwikset locks" or "is the
   front door locked?" — it should call `list_locks` / `get_lock_status`.
   Unlocking requires an explicit ask, since `unlock_door` refuses to act
   unless called with `confirm=true`, which Claude will only do when
   you've clearly asked it to unlock that door.

## Tools exposed

| Tool | Description |
|---|---|
| `list_locks` | All locks on the account, with status, battery %, home |
| `get_lock_status(device_id)` | Status/battery/model/serial for one lock |
| `lock_door(device_id)` | Lock a door |
| `unlock_door(device_id, confirm)` | Unlock a door (`confirm=true` required) |
| `debug_raw_devices` | Diagnostic: raw, unprocessed home/device JSON from Kwikset's API |
| `list_access_codes(device_id)` | Codes this server has created — see below |
| `add_access_code(device_id, name, code, schedule?, confirm)` | Add a code — see below |
| `remove_access_code(device_id, slot, confirm)` | Remove a code — see below |
| `debug_raw_access_codes(device_id)` | Diagnostic: raw CRC/checksum manifest from Kwikset's API |

### Access-code tools: real endpoints, with known v1 limitations

Unlike the guessed `usercodes` endpoint this project started with (which
returned a 403 against a real account), `add_access_code`/
`remove_access_code`/`list_access_codes` now talk to Kwikset's **real**
access-code endpoints — `POST`/`PATCH`/`DELETE prod_v1/devices/{id}/accesscode`
— using the **real wire format**, both confirmed by decompiling the actual
Kwikset Android app (`com.kwikset.blewifi`) with jadx. The request body is
`{"message": "<Base64>"}`, where the Base64 decodes to a small TLV8
(Type-Length-Value) binary record — not JSON — packing the slot index, an
enabled flag, and the code's digits as packed BCD. No encryption or device
pairing is involved anywhere in this flow. See `src/tlv8.js` and
`src/access-code-codec.js` for the byte-level implementation, and the
"DoorLock" project notes for the full reverse-engineering trace.

That said, this is a v1 with real, documented gaps versus the official
app — not guesses, but genuine capability limits of this implementation:

- **No live "list codes" read.** Kwikset's API has no endpoint to read
  codes back off a lock — only CRC/checksum manifests meant for the lock
  itself to verify sync, not for an app to read code contents. The real
  Kwikset app instead relies on a local on-device cache built from
  background Bluetooth/cloud sync, which this server doesn't have. So
  `list_access_codes` only shows codes **this server has created** — it
  won't reflect codes added via the Kwikset app or the keypad, and if you
  add/remove a code some other way, this server's record goes stale.
- **Schedules supported.** `add_access_code` accepts an optional
  `schedule` (permanent, `date_range`, or `weekly`) — the real Schedule
  TLV8 byte format, reverse-engineered from the decompiled app. All
  date/time fields are local wall-clock time, not UTC/epoch.
- **No edit.** The real edit/modify request was never reverse-engineered.
  Remove the old code and add a new one instead.
- **The lock picks the slot.** Like the real app, `add_access_code`
  sends slot 0 and the lock stores the code in its lowest free slot,
  reusing deleted slots and never overwriting an existing code. The lock
  reports the slot it chose in the sync-status reply (`message: "0301XX"`,
  slot = `XX` in hex), and that's the slot recorded locally. Verified on a
  HALO-01: deleting the reported slot removed exactly that code.
- **Deletes are limited to confirmed slots.** `remove_access_code` only
  accepts a slot the lock reported for a code this server created. A
  delete sent to any other slot erases whatever code lives there — that
  happened during testing — so codes set in the Kwikset app have to be
  removed in the app.
- **Code rules.** As in the real app: 4–8 digits, no `999999` prefix, and
  the first 4 digits must differ from every other code. This server can
  only check that against codes it created.
- **Offline locks.** Access-code changes are refused while a lock reports
  itself disconnected, and lock status carries `status_may_be_stale` /
  `last_updated` so an offline lock's last report isn't mistaken for live
  state.
- **The Kwikset app can lag.** It may keep showing a code deleted
  elsewhere, and its own delete can fail silently until the app is
  force-closed, reopened, and refreshed. The keypad is the source of truth.

Confirm every add and delete at the keypad: a delete's sync-status reply
carries no confirmation. `raw_response`/`sync_status` in each tool result
show exactly what Kwikset's API returned.

## Re-authenticating

If tokens expire and can't silently refresh (e.g. the Kwikset password was
changed, or 2FA was reset), tool calls will return an `auth_required`
error with instructions — just re-run `node auth-setup.js`.

## Files

```
kwikset-mcp/
├── auth-setup.js           # run once, by hand, to log in
├── src/
│   ├── const.js               # Cognito pool/client IDs, API host (see caveats above)
│   ├── auth.js                # local token file read/write
│   ├── cognito.js             # AWS Cognito login/refresh (amazon-cognito-identity-js)
│   ├── util.js                # shared request-timeout helper
│   ├── tlv8.js                # TLV8 record encoding + type-byte enums (reverse-engineered)
│   ├── access-code-codec.js   # builds the real create/delete access-code byte payloads
│   ├── access-code-store.js   # local record of codes this server has set (~/.kwikset-mcp/access-codes.json)
│   ├── kwikset-client.js      # REST calls: homes, devices, lock/unlock, access codes
│   └── server.js              # MCP server + tool definitions
├── package.json
└── .gitignore
```
