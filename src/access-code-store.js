// Local record of access codes THIS SERVER has created, keyed by device.
//
// Kwikset's cloud API has no "list codes" endpoint - confirmed by
// decompiling DeviceRestInterface: only CRC/checksum manifest endpoints
// exist (getOverallAccessCodeCrc and friends), meant for the lock to
// verify sync integrity, not for reading code contents back. The real
// app instead relies on a local Room-cached database fed by background
// BLE/cloud sync, which this server has no access to. So list_access_codes
// can only ever show "what this server knows it set" - NOT a live read of
// the lock's actual state.
//
// IMPORTANT LIMITATIONS:
//   - If a code is added/removed some other way (the Kwikset app, the
//     keypad itself, another copy of this server), this record goes
//     stale and won't reflect it.
//   - There's no way to discover which index/slot numbers are already in
//     use by codes set outside this server, so a new code added here
//     could collide with (and silently overwrite) one you didn't know
//     about. Check the Kwikset app for existing codes before relying on
//     automatic slot allocation, or pass an explicit slot.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STORE_PATH = path.join(os.homedir(), ".kwikset-mcp", "access-codes.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function listCodes(deviceId) {
  return load()[deviceId] || [];
}

/** Picks the lowest unused index in [min, max] among codes THIS SERVER
 * has tracked for this device. See the limitations note above - this
 * cannot see slots used by codes set outside this server. */
export function nextIndex(deviceId, { min = 1, max = 30 } = {}) {
  const used = new Set(listCodes(deviceId).map((c) => c.index));
  for (let i = min; i <= max; i++) {
    if (!used.has(i)) return i;
  }
  throw new Error(
    `No free access-code slot found in the locally-tracked range ${min}-${max}. ` +
      "This server only tracks codes it created itself - if the lock's real " +
      "slot range differs, or codes exist that weren't created here, pass an " +
      "explicit slot to override."
  );
}

export function recordAdd(deviceId, entry) {
  const data = load();
  data[deviceId] = (data[deviceId] || []).filter((c) => c.index !== entry.index);
  data[deviceId].push(entry);
  save(data);
}

export function recordRemove(deviceId, index) {
  const data = load();
  data[deviceId] = (data[deviceId] || []).filter((c) => c.index !== index);
  save(data);
}
