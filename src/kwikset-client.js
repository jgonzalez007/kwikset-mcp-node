// REST calls against Kwikset's (unofficial, unsupported) cloud API, plus
// the glue that keeps a Cognito session alive using the token file managed
// by auth.js. See const.js and cognito.js for where the underlying details
// came from.

import { API_HOST, API_USER_AGENT } from "./const.js";
import { refresh as cognitoRefresh } from "./cognito.js";
import { loadTokens, saveTokens } from "./auth.js";

export class KwiksetAuthError extends Error {}
export class NotFoundError extends Error {}

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
    const res = await fetch(`https://${API_HOST}/${path}`, {
      method,
      headers: {
        Host: API_HOST,
        "User-Agent": API_USER_AGENT,
        Authorization: `Bearer ${this.#idToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

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
}
