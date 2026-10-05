// REST calls against Kwikset's (unofficial, unsupported) cloud API, plus
// the glue that keeps a Cognito session alive using the token file managed
// by auth.js. See const.js and cognito.js for where the underlying details
// came from.

import { API_HOST, API_USER_AGENT } from "./const.js";
import { refresh as cognitoRefresh } from "./cognito.js";
import { loadTokens, saveTokens } from "./auth.js";
import {
  buildCreateAccessCodePayload,
  buildDeleteAccessCodePayload,
  buildDateRangeScheduleBytes,
  buildWeeklyScheduleBytes,
  DeviceAccessScheduleType,
  LOCK_ASSIGNS_SLOT,
  parseAssignedSlot,
  checkCodeRules,
} from "./access-code-codec.js";
import * as codeStore from "./access-code-store.js";

// Every REST call is a network round-trip on the hot path of every tool
// call (list_locks, lock_door, etc). A stuck connection should fail fast
// with a clear message instead of hanging until the MCP host's own
// timeout (60s) gives up with a generic, unhelpful error.
const REQUEST_TIMEOUT_MS = 15_000;

export class KwiksetAuthError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

function first(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

export class KwiksetClient {
  #idToken = null;

  /** Loads saved tokens and refreshes them against Cognito. Throws
   * KwiksetAuthError if there's no usable saved session. */
  async connect() {
    const saved = loadTokens();
    if (!saved || !saved.email || !saved.refreshToken) {
      throw new KwiksetAuthError(
        "No saved Kwikset session found. From a terminal (not through " +
          "Claude), run `npm run login` (or `node auth-setup.js`) once to " +
          "log in, then try again."
      );
    }

    let fresh;
    try {
      fresh = await cognitoRefresh(saved.email, saved.refreshToken);
    } catch (err) {
      throw new KwiksetAuthError(
        "Saved Kwikset session could not be refreshed (it may have " +
          "expired or been revoked). Run `node auth-setup.js` again to " +
          `re-login. Underlying error: ${err.message || err}`
      );
    }

    saveTokens(fresh);
    this.#idToken = fresh.idToken;
  }

  async #apiRequest(path, { method = "GET", body } = {}) {
    if (!this.#idToken) {
      throw new Error("KwiksetClient.connect() must be called first.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(`https://${API_HOST}/${path}`, {
        method,
        headers: {
          Host: API_HOST,
          "User-Agent": API_USER_AGENT,
          Authorization: `Bearer ${this.#idToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(
          `Kwikset API request timed out after ${REQUEST_TIMEOUT_MS}ms for ` +
            `${method} ${path}`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Kwikset API returned ${res.status} ${res.statusText} for ${method} ` +
          `${path}${text ? `: ${text.slice(0, 500)}` : ""}`
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async #homes() {
    const data = await this.#apiRequest("prod_v1/users/me/homes?top=200");
    return first(data, "data") || [];
  }

  async #devicesForHome(homeId) {
    const data = await this.#apiRequest(`prod_v1/homes/${homeId}/devices`);
    return first(data, "data") || [];
  }

  static #summarize(device, home) {
    const connectivity = first(device, "deviceconnectivitystatus");
    const updated = Number(first(device, "lastupdatedtimestamp", "lastupdatestatus"));
    return {
      // A disconnected lock keeps reporting its last known state and
      // battery, which can be days old - surface that instead of letting
      // stale values pass as live.
      connectivity,
      status_may_be_stale: connectivity !== null && connectivity !== "connected",
      last_updated:
        Number.isFinite(updated) && updated > 0 ? new Date(updated * 1000).toISOString() : null,
      device_id: first(device, "deviceid", "deviceId", "id"),
      name: first(device, "devicename", "deviceName", "name"),
      home: home ? first(home, "homename", "homeName", "name") : null,
      status: first(device, "lockstatus", "doorstatus", "status", "state"),
      battery_percent: first(device, "batterypercentage", "battery", "batteryPercentage"),
      model: first(device, "modelnumber", "modelNumber", "model"),
      serial_number: first(device, "serialnumber", "serialNumber"),
    };
  }

  /** Raw, unprocessed home/device JSON straight from the API - useful if
   * list_locks/get_lock_status ever show null fields, which would mean
   * Kwikset renamed a field this wrapper looks for. */
  async debugRawDevices() {
    const out = [];
    for (const home of await this.#homes()) {
      const homeId = first(home, "homeid", "homeId", "id");
      const devices = await this.#devicesForHome(homeId);
      out.push({ home, devices });
    }
    return out;
  }

  /** All locks across every home on the account. */
  async listLocks() {
    const locks = [];
    for (const home of await this.#homes()) {
      const homeId = first(home, "homeid", "homeId", "id");
      const devices = await this.#devicesForHome(homeId);
      for (const device of devices) {
        locks.push(KwiksetClient.#summarize(device, home));
      }
    }
    return locks;
  }

  async #findDevice(deviceId) {
    for (const home of await this.#homes()) {
      const homeId = first(home, "homeid", "homeId", "id");
      const devices = await this.#devicesForHome(homeId);
      for (const device of devices) {
        const id = first(device, "deviceid", "deviceId", "id");
        if (String(id) === String(deviceId)) return { device, home };
      }
    }
    throw new NotFoundError(
      `No lock found with device_id=${JSON.stringify(deviceId)}. Call ` +
        "list_locks to see valid IDs - they can change if a lock is " +
        "removed and re-added in the Kwikset app."
    );
  }

  async getLockStatus(deviceId) {
    const { device, home } = await this.#findDevice(deviceId);
    return KwiksetClient.#summarize(device, home);
  }

  async #setLockState(deviceId, action) {
    const { device } = await this.#findDevice(deviceId);
    const id = first(device, "deviceid", "deviceId", "id");
    await this.#apiRequest(`prod_v1/devices/${id}/status`, {
      method: "PATCH",
      body: {
        action,
        source: JSON.stringify({ name: "Claude", device: "kwikset-mcp" }),
      },
    });
    return this.getLockStatus(deviceId);
  }

  lock(deviceId) {
    return this.#setLockState(deviceId, "lock");
  }

  unlock(deviceId) {
    return this.#setLockState(deviceId, "unlock");
  }

  // ---------------------------------------------------------------------
  // Access code management.
  //
  // Built against the REAL endpoints and wire format, confirmed by
  // decompiling the real Android app (com.kwikset.blewifi) with jadx -
  // this is no longer a guess at a plausible-looking REST resource. Full
  // trace is recorded in the "DoorLock" Claude project doc (items 5-15).
  // Summary: POST/PATCH/DELETE prod_v1/devices/{id}/accesscode, body =
  // {"message": "<Base64(payload)>"}, where payload is TLV8
  // (Type-Length-Value, 8-bit) binary, NOT JSON. No encryption, no device
  // pairing, no secret material involved anywhere in this flow - see
  // access-code-codec.js for the exact byte-level construction.
  //
  // Slot allocation (verified on a HALO-01, app v2.11.0 decompiled):
  //   - Creates send index 0 (LOCK_ASSIGNS_SLOT), exactly like the real
  //     app. The lock takes the lowest free slot, reuses deleted slots,
  //     and never overwrites an existing code.
  //   - The sync-status reply after a create carries the assigned slot as
  //     a hex TLV8 record, "0301XX" (see parseAssignedSlot). A delete for
  //     slot XX removes exactly that code. The real app ignores this
  //     reply and learns the slot from its AppSync subscription instead.
  //
  // Known limitations:
  //   - There is genuinely no "list codes" endpoint on Kwikset's server -
  //     only CRC/checksum manifests, and their per-slot variants return
  //     OPERATION_NOT_AVAILABLE on a HALO-01. list_access_codes can only
  //     show codes THIS SERVER has created (see access-code-store.js).
  //   - Deletes are refused unless the slot was reported by the lock, so a
  //     delete can't land on a code this server doesn't know about.
  //   - Code-uniqueness rules can only be checked against codes this
  //     server knows; the lock or app may still reject a clash with a code
  //     set elsewhere.
  //   - Editing an existing code (PATCH) is not implemented. Remove +
  //     re-add covers the same result.
  //   - A delete's sync-status reply carries no confirmation (it is "" or
  //     TOKEN_NOT_FOUND), so removals are returned unverified.
  // ---------------------------------------------------------------------

  static #validateCodeValue(code) {
    if (!/^\d{4,8}$/.test(String(code))) {
      throw new ValidationError(
        `code must be 4-8 digits (got ${JSON.stringify(code)}).`
      );
    }
  }

  async #accessCodeRequest(deviceId, method, payloadBuffer) {
    const { device } = await this.#findDevice(deviceId);
    const id = first(device, "deviceid", "deviceId", "id");
    const connectivity = first(device, "deviceconnectivitystatus");
    if (connectivity !== null && connectivity !== "connected") {
      throw new ValidationError(
        `Lock ${id} reports connectivity "${connectivity}", so the cloud ` +
          "can't deliver access-code changes to it. Bring it back online " +
          "(check its Wi-Fi in the Kwikset app) and try again."
      );
    }
    const message = payloadBuffer.toString("base64");
    const raw = await this.#apiRequest(`prod_v1/devices/${id}/accesscode`, {
      method,
      body: { message },
    });
    const entries = first(raw, "data") || (Array.isArray(raw) ? raw : []);
    const entry = entries[0] || {};
    const token = first(entry, "token", "synctoken", "accesscodetoken");
    return { id, raw, token };
  }

  /** Polls the async sync-status endpoint after a create/delete, stopping
   * early once `done(response)` is true. Returns the last raw response. */
  async #pollAccessCodeSync(
    id,
    token,
    { attempts = 4, intervalMs = 1500, done = () => false } = {}
  ) {
    if (!token) return null;
    let last = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        last = await this.#apiRequest(`prod_v1/devices/${id}/accesscode/${token}`);
      } catch (err) {
        last = { error: String(err.message || err) };
      }
      if (done(last)) break;
    }
    return last;
  }

  /** Raw, unprocessed response from the real CRC/checksum manifest
   * endpoint (getOverallAccessCodeCrc). This is NOT a way to read code
   * contents - Kwikset's API has no such endpoint - it's the same
   * sync-verification manifest the lock itself uses. Kept for
   * diagnostics; use list_access_codes for the codes this server has
   * actually set. */
  async debugRawAccessCodes(deviceId) {
    const { device } = await this.#findDevice(deviceId);
    const id = first(device, "deviceid", "deviceId", "id");
    return this.#apiRequest(`prod_v1/devices/${id}/remoteaccesscode`);
  }

  /** Access codes THIS SERVER has created on a lock - see the "Known
   * limitations" comment above this section for why this can't be a
   * live read of the lock's actual state. */
  listAccessCodes(deviceId) {
    return codeStore.listCodes(deviceId).map((entry) => ({
      slot: entry.index ?? null,
      slot_confirmed: Boolean(entry.slotConfirmed),
      name: entry.name,
      code: entry.code,
      enabled: entry.enabled,
      schedule: entry.schedule || null,
      created_at: entry.createdAt,
    }));
  }

  static #validateTimeOfDay({ hour, minute } = {}, label) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new ValidationError(`${label}.hour must be an integer 0-23, got ${JSON.stringify(hour)}`);
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new ValidationError(`${label}.minute must be an integer 0-59, got ${JSON.stringify(minute)}`);
    }
  }

  static #validateScheduleDate({ year, month, day } = {}, label) {
    if (!Number.isInteger(year) || year < 2000 || year > 2127) {
      throw new ValidationError(`${label}.year must be an integer 2000-2127, got ${JSON.stringify(year)}`);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ValidationError(`${label}.month must be an integer 1-12, got ${JSON.stringify(month)}`);
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new ValidationError(`${label}.day must be an integer 1-31, got ${JSON.stringify(day)}`);
    }
  }

  /** Validates and byte-packs an optional schedule into a
   * {scheduleType, scheduleBytes} pair for buildCreateAccessCodePayload.
   * Omit `schedule` for a permanent, always-allowed code. */
  static #resolveSchedule(schedule) {
    if (!schedule) {
      return { scheduleType: DeviceAccessScheduleType.AllDay, scheduleBytes: Buffer.alloc(0) };
    }
    if (schedule.type === "date_range") {
      KwiksetClient.#validateScheduleDate(schedule.start, "schedule.start");
      KwiksetClient.#validateTimeOfDay(schedule.start, "schedule.start");
      KwiksetClient.#validateScheduleDate(schedule.end, "schedule.end");
      KwiksetClient.#validateTimeOfDay(schedule.end, "schedule.end");
      const startMs = Date.UTC(
        schedule.start.year, schedule.start.month - 1, schedule.start.day,
        schedule.start.hour, schedule.start.minute
      );
      const endMs = Date.UTC(
        schedule.end.year, schedule.end.month - 1, schedule.end.day,
        schedule.end.hour, schedule.end.minute
      );
      if (!(startMs < endMs)) {
        throw new ValidationError("schedule.start must be before schedule.end.");
      }
      return {
        scheduleType: DeviceAccessScheduleType.DateRange,
        scheduleBytes: buildDateRangeScheduleBytes({ start: schedule.start, end: schedule.end }),
      };
    }
    if (schedule.type === "weekly") {
      KwiksetClient.#validateTimeOfDay(schedule.start, "schedule.start");
      KwiksetClient.#validateTimeOfDay(schedule.end, "schedule.end");
      if (!schedule.days || !Object.values(schedule.days).some(Boolean)) {
        throw new ValidationError("schedule.days must have at least one day enabled.");
      }
      return {
        scheduleType: DeviceAccessScheduleType.Weekly,
        scheduleBytes: buildWeeklyScheduleBytes({
          start: schedule.start,
          end: schedule.end,
          days: schedule.days,
        }),
      };
    }
    throw new ValidationError(
      `schedule.type must be "date_range" or "weekly", got ${JSON.stringify(schedule.type)}`
    );
  }

  /** Add a keypad access code. Omit `schedule` for a permanent,
   * always-allowed code, or pass a date_range/weekly schedule (see
   * #resolveSchedule) - both confirmed from decompiling the real app's
   * Schedule TLV8 byte format. The lock picks the slot and reports it
   * back; see the slot-allocation comment above this section. */
  async addAccessCode(deviceId, { name, code, schedule } = {}) {
    if (!name || !String(name).trim()) {
      throw new ValidationError("name is required.");
    }
    KwiksetClient.#validateCodeValue(code);
    const ruleError = checkCodeRules(
      code,
      codeStore.listCodes(deviceId).map((c) => c.code)
    );
    if (ruleError) throw new ValidationError(ruleError);

    const { scheduleType, scheduleBytes } = KwiksetClient.#resolveSchedule(schedule);

    const payload = buildCreateAccessCodePayload({
      index: LOCK_ASSIGNS_SLOT,
      friendlyName: name,
      enabled: true,
      code,
      scheduleType,
      scheduleBytes,
    });
    const { id, raw, token } = await this.#accessCodeRequest(deviceId, "POST", payload);
    const syncStatus = await this.#pollAccessCodeSync(id, token, {
      attempts: 8,
      done: (res) => parseAssignedSlot(res?.message) !== null,
    });
    const assigned = parseAssignedSlot(syncStatus?.message);

    codeStore.recordAdd(deviceId, {
      index: assigned,
      slotConfirmed: assigned !== null,
      name,
      code: String(code),
      enabled: true,
      schedule: schedule || null,
      createdAt: new Date().toISOString(),
    });

    return {
      added: { slot: assigned, name, code: String(code), schedule: schedule || null },
      raw_response: raw,
      sync_status: syncStatus,
      note:
        assigned !== null
          ? `The lock stored this code in slot ${assigned}. Confirm at the keypad.`
          : "The lock didn't report a slot yet, so this server can't delete " +
            "this code later - remove it in the Kwikset app if needed. Confirm " +
            "at the keypad that it works.",
    };
  }

  /** Remove a keypad access code by its slot. Only slots the lock reported
   * for a code this server created are accepted. */
  async removeAccessCode(deviceId, slot) {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new ValidationError(`slot must be an integer 0-255, got ${JSON.stringify(slot)}`);
    }
    const entry = codeStore.findConfirmed(deviceId, index);
    if (!entry) {
      throw new ValidationError(
        `Slot ${index} isn't a lock-confirmed slot for a code this server ` +
          "created, so deleting it could erase a code set in the Kwikset app " +
          "or at the keypad. Check list_access_codes, or delete the code in " +
          "the Kwikset app."
      );
    }
    const payload = buildDeleteAccessCodePayload(index);
    const { id, raw, token } = await this.#accessCodeRequest(deviceId, "DELETE", payload);
    const syncStatus = await this.#pollAccessCodeSync(id, token);

    codeStore.recordRemove(deviceId, index);

    return {
      removed: { slot: index, name: entry.name },
      raw_response: raw,
      sync_status: syncStatus,
      note:
        "Kwikset's reply to a delete carries no confirmation. Check at the " +
        "keypad that the code no longer works.",
    };
  }
}
