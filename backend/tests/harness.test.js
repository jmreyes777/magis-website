// TST0 (testing megaplan): proves the node:test harness runs in CI with no
// credentials — imports a real module (backup engine) whose top-level requires
// are cred-free by design (utils/firebase is lazy inside runBackup).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { serializeValue } = require("../scripts/firestore-backup");

test("harness: serializeValue passes primitives through untouched", () => {
  assert.equal(serializeValue(42), 42);
  assert.equal(serializeValue("sangla"), "sangla");
  assert.equal(serializeValue(null), null);
  assert.equal(serializeValue(true), true);
});
