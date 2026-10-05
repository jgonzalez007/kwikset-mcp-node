// Local record of access codes THIS SERVER has created, keyed by device.
//
// Kwikset's cloud API has no "list codes" endpoint - confirmed by
// decompiling DeviceRestInterface: only CRC/checksum manifest endpoints
// exist (getOverallAccessCodeCrc and friends), and on a HALO-01 the
// per-slot ones return OPERATION_NOT_AVAILABLE. The real app relies on a
// local Room database fed by BLE/cloud sync, which this server has no
// access to. So list_access_codes can only ever show "what this server
// knows it set" - NOT a live read of the lock's actual state.
//
// Slots: new codes are created with index 0 so the lock picks the slot,
// and the lock reports the slot it chose in the sync-status reply. An
// entry's `index` is that reported slot (`slotConfirmed: true`), or null
// if no slot came back. Only confirmed slots may be deleted - a delete
// sent to a guessed slot can erase a code this server doesn't know about.
//
// LIMITATIONS:
//   - Codes added/removed some other way (the Kwikset app, the keypad,
//     another copy of this server) are invisible here, and this record
//     goes stale if one of ours is deleted elsewhere.
//   - If the lock reports a slot we already have recorded, the old entry
//     must have been deleted outside this server; it is replaced.

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

/** Returns the entry recorded at a lock-confirmed slot, or undefined. */
export function findConfirmed(deviceId, index) {
  return listCodes(deviceId).find((c) => c.slotConfirmed && c.index === index);
}

export function recordAdd(deviceId, entry) {
  const data = load();
  data[deviceId] = (data[deviceId] || []).filter(
    (c) => !(entry.slotConfirmed && c.slotConfirmed && c.index === entry.index)
  );
  data[deviceId].push(entry);
  save(data);
}

export function recordRemove(deviceId, index) {
  const data = load();
  data[deviceId] = (data[deviceId] || []).filter(
    (c) => !(c.slotConfirmed && c.index === index)
  );
  save(data);
}
