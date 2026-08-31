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
    return {
      device_id: first(device, "deviceid", "deviceId", "id"),
      name: first(device, "devicename", "deviceName", "name"),
      home: home ? first(home, "homename", "homeName", "name") : null,
      status: first(device, "doorstatus", "status", "state"),
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
  // Known limitations of this implementation (v1):
  //   - There is genuinely no "list codes" endpoint on Kwikset's server -
  //     only CRC/checksum manifests, meant for the lock to verify sync,
  //     not to read code contents. list_access_codes can therefore only
  //     show codes THIS SERVER has created (see access-code-store.js) -
  //     it cannot see codes added via the Kwikset app or the keypad.
  //   - Only "always allowed" (no-schedule) codes are supported. Real
  //     schedule serialization (date ranges, weekly schedules) was never
  //     decompiled - see SCHEDULE_TYPE_ALL_DAY in access-code-codec.js.
  //   - Editing an existing code (PATCH) is not implemented - the real
  //     edit lambda (yr.h0) was never decompiled, so its exact payload
  //     shape is unconfirmed. Remove + re-add covers the same result.
  //   - Slot/index allocation is tracked locally starting from 1; it can
  //     collide with a slot already used by a code set outside this
  //     server (the app, the keypad). Check the Kwikset app for existing
  //     codes before relying on automatic slot allocation.
  //   - The response's sync-status field meanings (SyncStatusResponse)
  //     were never decompiled, so #pollAccessCodeSync returns the raw
  //     response rather than pretending to interpret a "done" flag.
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

  /** Polls the async sync-status endpoint a few times after a
   * create/delete. See the "Known limitations" comment above this
   * section - the response is returned raw rather than interpreted. */
  async #pollAccessCodeSync(deviceId, token, { attempts = 4, intervalMs = 1500 } = {}) {
    if (!token) return null;
    const { device } = await this.#findDevice(deviceId);
    const id = first(device, "deviceid", "deviceId", "id");
    let last = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        last = await this.#apiRequest(`prod_v1/devices/${id}/accesscode/${token}`);
      } catch (err) {
        last = { error: String(err.message || err) };
      }
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
      slot: entry.index,
      name: entry.name,
      code: entry.code,
      enabled: entry.enabled,
      created_at: entry.createdAt,
    }));
  }

  /** Add a keypad access code. v1: always-allowed only (no schedule) -
   * see the "Known limitations" comment above this section. Pass `slot`
   * to target a specific index instead of automatic allocation. */
  async addAccessCode(deviceId, { name, code, slot } = {}) {
    if (!name || !String(name).trim()) {
      throw new ValidationError("name is required.");
    }
    KwiksetClient.#validateCodeValue(code);

    const index =
      slot !== undefined && slot !== null ? Number(slot) : codeStore.nextIndex(deviceId);
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new ValidationError(`slot must be an integer 0-255, got ${JSON.stringify(slot)}`);
    }

    const payload = buildCreateAccessCodePayload({
      index,
      friendlyName: name,
      enabled: true,
      code,
    });
    const { raw, token } = await this.#accessCodeRequest(deviceId, "POST", payload);
    const syncStatus = await this.#pollAccessCodeSync(deviceId, token);

    codeStore.recordAdd(deviceId, {
      index,
      name,
      code: String(code),
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    return {
      added: { slot: index, name, code: String(code) },
      raw_response: raw,
      sync_status: syncStatus,
      note:
        "Verify this code works at the keypad or shows up in the Kwikset " +
        "app - the sync-status response's field meanings aren't fully " +
        "confirmed yet (see raw_response/sync_status above).",
    };
  }

  /** Remove a keypad access code by its slot (from list_access_codes). */
  async removeAccessCode(deviceId, slot) {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new ValidationError(`slot must be an integer 0-255, got ${JSON.stringify(slot)}`);
    }
    const payload = buildDeleteAccessCodePayload(index);
    const { raw, token } = await this.#accessCodeRequest(deviceId, "DELETE", payload);
    const syncStatus = await this.#pollAccessCodeSync(deviceId, token);

    codeStore.recordRemove(deviceId, index);

    return {
      removed: { slot: index },
      raw_response: raw,
      sync_status: syncStatus,
    };
  }
}
