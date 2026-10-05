// Encodes access-code fields into the exact byte payloads Kwikset's cloud
// API expects for the access-code REST endpoints. Every byte format here
// was confirmed by decompiling the real Android app (com.kwikset.blewifi)
// with jadx - see the "DoorLock" Claude project doc for the full trace.

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

/** DeviceAccessScheduleType byte values, confirmed from the decompiled
 * Kotlin sealed class (com.spectrum.commonsdk.service.lock.model.
 * deviceaccess.DeviceAccessScheduleType) - each subtype's constructor
 * argument is its wire value. */
export const DeviceAccessScheduleType = Object.freeze({
  AllDay: 1,
  DateRange: 3,
  Weekly: 4,
  OneTimeUnlimited: 5,
  OneTime24Hour: 6,
  ProxyAuthorization: 8,
});

export const SCHEDULE_TYPE_ALL_DAY = DeviceAccessScheduleType.AllDay;

/**
 * Packs a start/end time-of-day pair into 3 bytes. Confirmed from the
 * decompiled com.spectrum.commonsdk.module.common.serialization.f.g()
 * method (used by both DateRange and Weekly schedules):
 *   byte0 = startMinute << 2
 *   byte1 = endMinute | ((startHour & 0x3) << 6)
 *   byte2 = (startHour >> 2) | ((endHour & 0x1f) << 3)
 */
function packScheduleTimeRange(startHour, startMinute, endHour, endMinute) {
  const sh = startHour & 0x1f;
  const sm = startMinute & 0x3f;
  const eh = endHour & 0x1f;
  const em = endMinute & 0x3f;
  return Buffer.from([
    (sm << 2) & 0xff,
    (em | (sh << 6)) & 0xff,
    ((sh >> 2) | (eh << 3)) & 0xff,
  ]);
}

/**
 * Builds the 7-byte DateRange Schedule sub-record payload: the 3
 * time-of-day bytes above, followed by a 4-byte little-endian bitfield
 * (month/day/year for start and end). Confirmed from the decompiled
 * com.spectrum.commonsdk.module.common.serialization.f.e()/.a() methods
 * (encode and decode sides cross-checked against each other) and
 * s3.d.y0()/.H() for the little-endian 32-bit packing:
 *   bits[3:0]   start.month (1-12)      bits[7:4]   end.month (1-12)
 *   bits[12:8]  start.day (1-31)        bits[17:13] end.day (1-31)
 *   bits[24:18] start.year - 2000       bits[31:25] end.year - 2000
 * All fields are local wall-clock date/time components, not epoch time.
 */
export function buildDateRangeScheduleBytes({ start, end }) {
  const timeBytes = packScheduleTimeRange(start.hour, start.minute, end.hour, end.minute);
  const dateBits =
    (start.month & 0xf) |
    ((end.month & 0xf) << 4) |
    ((start.day & 0x1f) << 8) |
    ((end.day & 0x1f) << 13) |
    (((start.year - 2000) & 0x7f) << 18) |
    (((end.year - 2000) & 0x7f) << 25);
  const dateBytes = Buffer.from([
    dateBits & 0xff,
    (dateBits >>> 8) & 0xff,
    (dateBits >>> 16) & 0xff,
    (dateBits >>> 24) & 0xff,
  ]);
  return Buffer.concat([timeBytes, dateBytes]);
}

/**
 * Builds the 4-byte Weekly Schedule sub-record payload: the 3 time-of-day
 * bytes, followed by a day-of-week bitmask byte (Sun=0x01 ... Sat=0x40).
 * Confirmed from the decompiled
 * com.spectrum.commonsdk.module.common.serialization.f.f()/.d() methods.
 */
export function buildWeeklyScheduleBytes({ start, end, days }) {
  const timeBytes = packScheduleTimeRange(start.hour, start.minute, end.hour, end.minute);
  const dayByte =
    (days.sunday ? 0x01 : 0) |
    (days.monday ? 0x02 : 0) |
    (days.tuesday ? 0x04 : 0) |
    (days.wednesday ? 0x08 : 0) |
    (days.thursday ? 0x10 : 0) |
    (days.friday ? 0x20 : 0) |
    (days.saturday ? 0x40 : 0);
  return Buffer.concat([timeBytes, Buffer.from([dayByte])]);
}

/**
 * Builds the exact payload for POST devices/{id}/accesscode (create),
 * matching the decompiled g8.f.x() logic: a main AccessCode TLV8 record
 * (index + enabled/scheduleType header byte + BCD code bytes), an
 * optional Schedule TLV8 record (only appended when scheduleBytes is
 * non-empty, mirroring the real app), then a FriendlyName TLV8 record.
 * No outer TxCommand wrapper (unlike delete).
 */
export function buildCreateAccessCodePayload({
  index,
  friendlyName,
  enabled,
  code,
  scheduleType = SCHEDULE_TYPE_ALL_DAY,
  scheduleBytes = Buffer.alloc(0),
}) {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`index must be an integer 0-255, got ${JSON.stringify(index)}`);
  }
  const header = Buffer.from([
    index & 0xff,
    (enabled ? 1 : 0) | ((scheduleType & 0x0f) << 4),
  ]);
  const codeBytes = encodeAccessCodeDigits(code);
  const mainRecord = tlv8Record(
    DeviceAccessTlv8SubType.AccessCode,
    Buffer.concat([header, codeBytes])
  );
  const scheduleRecord =
    scheduleBytes.length > 0
      ? tlv8Record(DeviceAccessTlv8SubType.Schedule, scheduleBytes)
      : Buffer.alloc(0);
  const nameRecord = tlv8Record(
    DeviceAccessTlv8SubType.FriendlyName,
    Buffer.from(String(friendlyName), "utf8")
  );
  return Buffer.concat([mainRecord, scheduleRecord, nameRecord]);
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

/**
 * Index to send on create when the lock should pick the slot itself. The
 * real app always sends 0 on the cloud path (C6047na.m7788d forces it) and
 * lets the lock allocate. Confirmed on a HALO-01: the lock takes the lowest
 * free slot, reuses deleted slots, and never overwrites an existing code.
 */
export const LOCK_ASSIGNS_SLOT = 0;

/**
 * Extracts the slot the lock assigned from the sync-status `message` that
 * follows a create, e.g. "030104" -> 4. The message is a hex TLV8 record:
 * type 0x03, length 0x01, value = the assigned slot. That reading was
 * verified on a HALO-01 by deleting the reported slot and confirming at the
 * keypad that exactly that code stopped working. Returns null for anything
 * else (deletes reply with "" or TOKEN_NOT_FOUND).
 */
export function parseAssignedSlot(message) {
  const match = /^0301([0-9a-f]{2})$/i.exec(String(message ?? "").trim());
  return match ? parseInt(match[1], 16) : null;
}

export const RESERVED_CODE_PREFIX = "999999";
export const UNIQUE_PREFIX_LENGTH = 4;

/**
 * The real app's validation (AccessCodeLockExtKt.isAccessCodeAllowed):
 * reject a code equal to an existing one, sharing its first 4 digits with
 * one, or starting with the reserved prefix 999999. `existingCodes` can
 * only be the codes this server knows about. Returns an error string, or
 * null if the code is allowed.
 */
export function checkCodeRules(code, existingCodes = []) {
  const value = String(code);
  if (value.startsWith(RESERVED_CODE_PREFIX)) {
    return `Codes starting with ${RESERVED_CODE_PREFIX} are reserved by the lock.`;
  }
  const prefix = value.slice(0, UNIQUE_PREFIX_LENGTH);
  for (const existing of existingCodes.map(String)) {
    if (existing === value) {
      return "That code already exists on this lock.";
    }
    if (existing.slice(0, UNIQUE_PREFIX_LENGTH) === prefix) {
      return (
        `The first ${UNIQUE_PREFIX_LENGTH} digits (${prefix}) match an existing ` +
        "code; Kwikset requires them to be unique."
      );
    }
  }
  return null;
}
