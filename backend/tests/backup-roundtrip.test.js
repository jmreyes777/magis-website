// TST2 (testing megaplan): the backup engine's serializeValue and the restore
// tool's deserializer must be exact inverses — this is what makes a snapshot
// restorable AT ALL. Uses the real firebase-admin Timestamp/GeoPoint classes
// (no app initialization, no credentials).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { serializeValue } = require("../scripts/firestore-backup");
const { makeDeserializer, stableStringify, prefixPath } = require("../scripts/firestore-restore");

const { Timestamp, GeoPoint } = admin.firestore;

// Fake db: only .doc() is needed by the ref branch; echoes the path back.
const fakeDb = { doc: (p) => ({ path: p, constructor: { name: "DocumentReference" } }) };
const deserialize = makeDeserializer(admin, fakeDb);

// Simulate the actual pipeline: serialize → JSONL line on disk → parse → restore.
const throughDisk = (v) => JSON.parse(JSON.stringify(serializeValue(v)));

describe("serialize → disk → deserialize → serialize is identity", () => {
  test("Timestamp with sub-millisecond nanos survives exactly", () => {
    const ts = new Timestamp(1752561000, 123456789); // .456789 ms beyond toMillis
    const back = deserialize(throughDisk(ts));
    assert.ok(back instanceof Timestamp);
    assert.equal(back.seconds, ts.seconds);
    assert.equal(back.nanoseconds, ts.nanoseconds);
  });
  test("GeoPoint survives", () => {
    const geo = new GeoPoint(14.5995, 120.9842); // Manila
    const back = deserialize(throughDisk(geo));
    assert.ok(back instanceof GeoPoint);
    assert.equal(back.latitude, geo.latitude);
    assert.equal(back.longitude, geo.longitude);
  });
  test("Buffer survives byte-for-byte", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252]);
    const back = deserialize(throughDisk(buf));
    assert.ok(Buffer.isBuffer(back));
    assert.equal(Buffer.compare(back, buf), 0);
  });
  test("a realistic nested document round-trips to an identical re-serialization", () => {
    const doc = {
      name: "Magis Branch 1",
      loanCount: 3689,
      rate: 1.5,
      active: true,
      nothing: null,
      openedAt: new Timestamp(1600000000, 987654321),
      location: new GeoPoint(14.6, 121.0),
      tags: ["gold", "sangla", { nested: new Timestamp(1700000000, 1) }],
      deep: { a: { b: { c: [new GeoPoint(0, 0), "x", 9] } } },
    };
    const once = serializeValue(doc);
    const twice = serializeValue(deserialize(JSON.parse(JSON.stringify(once))));
    assert.equal(stableStringify(twice), stableStringify(once));
  });
  test("DocumentReference deserializes to db.doc(original path) — never re-prefixed", () => {
    const back = deserialize({ __t: "ref", path: "branches/b1" });
    assert.equal(back.path, "branches/b1");
  });
});

describe("stableStringify", () => {
  test("is key-order independent (why spot-checks don't false-alarm)", () => {
    assert.equal(stableStringify({ a: 1, b: [2, { d: 3, c: 4 }] }), stableStringify({ b: [2, { c: 4, d: 3 }], a: 1 }));
  });
  test("distinguishes genuinely different values", () => {
    assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: "1" }));
  });
});

describe("prefixPath (drill/inspect restore targeting)", () => {
  test("prefixes only the TOP collection segment", () => {
    assert.equal(prefixPath("players/p1", "drill_"), "drill_players/p1");
    assert.equal(prefixPath("chats/c1/messages/m1", "drill_"), "drill_chats/c1/messages/m1");
  });
  test("empty prefix is identity (in-place restores)", () => {
    assert.equal(prefixPath("players/p1", ""), "players/p1");
  });
});
