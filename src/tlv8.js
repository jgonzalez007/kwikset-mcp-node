// Minimal TLV8 (Type-Length-Value, 8-bit) encoder - the binary framing
// Kwikset's access-code/fingerprint REST payloads use under the hood
// (the same lightweight format HomeKit-style BLE accessories use).
// Confirmed by decompiling the real Android app's Tlv8Record class:
//
//   toByteArray() = [type: 1 byte] + [length: 1 byte, = data.length] + [data: N bytes]
//
// No multi-byte length, no padding, no CRC in the record itself. Full
// trace is recorded in the "DoorLock" Claude project doc.

/** DeviceAccessTlv8SubType byte values, confirmed from the decompiled enum. */
export const DeviceAccessTlv8SubType = Object.freeze({
  AccessCode: 0,
  Schedule: 1,
  FriendlyName: 2,
  ProxyAuthorization: 8,
  BiometricProfile: 16,
});

/** TxCommand byte values relevant to access codes, confirmed from the
 * decompiled enum. SetAccessCode/EditAccessCode appear to be BLE-layer
 * command bytes (the REST create payload has no outer command wrapper at
 * all - see access-code-codec.js) - DeleteDeviceAccess IS used as the
 * REST delete payload's record type. Kept together here for reference. */
export const TxCommand = Object.freeze({
  SetAccessCode: 4,
  DeleteDeviceAccess: 5,
  DeleteAllAccessCodes: 10,
  AccessCodeReadSettings: 32,
  EditAccessCode: 113,
});

/** Builds one TLV8 record's raw bytes: [type][length][...data]. */
export function tlv8Record(type, data) {
  if (data.length > 255) {
    throw new Error(`TLV8 record data too long (${data.length} bytes, max 255)`);
  }
  return Buffer.concat([Buffer.from([type & 0xff, data.length & 0xff]), data]);
}
