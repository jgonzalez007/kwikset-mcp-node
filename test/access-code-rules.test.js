// Slot parsing and code rules. The sync-status messages below are the
// literal values a HALO-01 returned during hardware testing, each checked
// at the keypad by deleting the reported slot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAssignedSlot, checkCodeRules } from "../src/access-code-codec.js";

test("parseAssignedSlot reads the slot from observed create replies", () => {
  assert.equal(parseAssignedSlot("030102"), 2);
  assert.equal(parseAssignedSlot("030104"), 4);
  assert.equal(parseAssignedSlot("03010A"), 10);
  assert.equal(parseAssignedSlot("03010a"), 10);
});

test("parseAssignedSlot returns null for delete replies and junk", () => {
  assert.equal(parseAssignedSlot(""), null);
  assert.equal(parseAssignedSlot(undefined), null);
  assert.equal(parseAssignedSlot(null), null);
  assert.equal(parseAssignedSlot("0302040A"), null);
  assert.equal(parseAssignedSlot("040104"), null);
});

test("checkCodeRules allows a code with a fresh 4-digit prefix", () => {
  assert.equal(checkCodeRules("2468", ["1357", "6802"]), null);
});

test("checkCodeRules rejects an exact duplicate", () => {
  assert.match(checkCodeRules("2468", ["2468"]), /already exists/);
});

test("checkCodeRules rejects a shared first-4-digit prefix", () => {
  assert.match(checkCodeRules("246801", ["2468"]), /first 4 digits/);
  assert.match(checkCodeRules("2468", ["24689999"]), /first 4 digits/);
});

test("checkCodeRules rejects the reserved 999999 prefix", () => {
  assert.match(checkCodeRules("99999912", []), /reserved/);
  assert.equal(checkCodeRules("9999", []), null);
});
