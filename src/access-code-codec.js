// Encodes access-code fields into the exact byte payloads Kwikset's cloud
// API expects for the access-code REST endpoints. Every byte format here
// was confirmed by decompiling the real Android app (com.kwikset.blewifi)
// with jadx - see the "DoorLock" Claude project doc for the full trace.
//
// Two things below are NOT decompiled and are documented as best-effort
// defaults rather than confirmed values - see the comments on
// SCHEDULE_TYPE_ALL_DAY and the "v1 only supports..." note.

import { tlv8Record, DeviceAccessTlv8SubType, TxCommand } from "./tlv8.js";

/**
 * Packs an access-code digit string into bytes: packed BCD, two digits
 * per byte (high nibble first), with 0xF as a padding nibble on the last
 * byte when the digit count is odd (5 or 7 digits). Confirmed from the
 * decompiled wx.l.S(AccessCode) method:
 *   4 digits -> 2 bytes, 5 -> 3 bytes (padded), 6 -> 3 bytes,
 *   7 -> 4 bytes (padded), 8 -> 4 bytes.
 */
export function encodeAccessCodeDigits(code) {
  const str = String(code);
  if (!/^\d{4,8}$/.test(str)) {
    throw new Error(`access code must be 4-8 digits, got ${JSON.stringify(code)}`);
  }
  const d = str.split("").map((c) => c.charCodeAt(0) - 48);
  const bytes = [(d[0] << 4) | d[1], (d[2] << 4) | d[3]];
  if (d.length > 4) {
    if (d.length === 5) {
      bytes.push((d[4] << 4) | 0xf);
    } else {
      bytes.push((d[4] << 4) | d[5]);
      if (d.length === 7) {
        bytes.push((d[6] << 4) | 0xf);
      } else if (d.length === 8) {
        bytes.push((d[6] << 4) | d[7]);
      }
    }
  }
  return Buffer.from(bytes);
}

// DeviceAccessScheduleType's byte values were never decompiled - we
// stopped chasing that once "AllDay/no-schedule" turned out to make the
// whole Schedule sub-record optional (see buildCreateAccessCodePayload
// below). 0 is a best-effort default (enums in this codebase consistently
// start at 0, e.g. DeviceAccessTlv8SubType.AccessCode=0), NOT a confirmed
// value. If codes created by this server behave oddly around scheduling
// in the Kwikset app, this is the first thing to re-check by decompiling
// the real DeviceAccessScheduleType enum.
export const SCHEDULE_TYPE_ALL_DAY = 1;

/**
 * Builds the exact payload for POST devices/{id}/accesscode (create),
 * matching the decompiled g8.f.x() logic: a main AccessCode TLV8 record
 * (index + enabled/scheduleType header byte + BCD code bytes) followed by
 * a FriendlyName TLV8 record. No outer TxCommand wrapper (unlike delete).
 *
 * v1 only supports "always allowed" codes (no Schedule sub-record) - real
 * non-AllDay schedule serialization (date ranges, weekly schedules) was
 * never decompiled. Per the decompiled logic the Schedule sub-record is
 * only appended when it has nonzero length, so omitting it entirely here
 * mirrors what the real app does for an unrestricted code.
 */
export function buildCreateAccessCodePayload({ index, friendlyName, enabled, code }) {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`index must be an integer 0-255, got ${JSON.stringify(index)}`);
  }
  const header = Buffer.from([
    index & 0xff,
    (enabled ? 1 : 0) | ((SCHEDULE_TYPE_ALL_DAY & 0x0f) << 4),
  ]);
  const codeBytes = encodeAccessCodeDigits(code);
  const mainRecord = tlv8Record(
    DeviceAccessTlv8SubType.AccessCode,
    Buffer.concat([header, codeBytes])
  );
  const nameRecord = tlv8Record(
    DeviceAccessTlv8SubType.FriendlyName,
    Buffer.from(String(friendlyName), "utf8")
  );
  return Buffer.concat([mainRecord, nameRecord]);
}

/**
 * Builds the exact payload for DELETE devices/{id}/accesscode, matching
 * the decompiled yr.b0 logic: a single TLV8 record, type =
 * TxCommand.DeleteDeviceAccess (5), data = the 1-byte index.
 */
export function buildDeleteAccessCodePayload(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`index must be an integer 0-255, got ${JSON.stringify(index)}`);
  }
  return tlv8Record(TxCommand.DeleteDeviceAccess, Buffer.from([index & 0xff]));
}
