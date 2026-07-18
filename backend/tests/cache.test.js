// TST2 (testing megaplan): pins the cache's FAIL-OPEN contract — with no
// Redis configured, cached() must transparently call the producer, never
// throw, and never stall. If this contract broke, branch lists and Facebook
// endpoints would break with it.
delete process.env.REDIS_URL;

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

const { cached, invalidate, key } = require("../utils/cache");

// Without REDIS_URL the util points at a localhost default and ioredis keeps
// reconnect timers alive forever — fail-open for callers, but it would hold
// this test process open. disconnect() (not quit()) drops it immediately.
after(() => {
  try {
    const { getRedis } = require("../utils/redis");
    const c = getRedis();
    if (c) c.disconnect();
  } catch {
    /* nothing to tear down */
  }
});

describe("key()", () => {
  test("joins scope parts deterministically", () => {
    assert.equal(key("a", "b", 1), key("a", "b", 1));
    assert.notEqual(key("a", "b"), key("a", "c"));
  });
});

describe("fail-open without Redis", () => {
  test("cached() returns the producer's value", async () => {
    const v = await cached(key("tst2", "value"), 60, async () => ({ ok: true, n: 7 }));
    assert.deepEqual(v, { ok: true, n: 7 });
  });
  test("a throwing producer still throws (no swallowing)", async () => {
    await assert.rejects(
      cached(key("tst2", "boom"), 60, async () => {
        throw new Error("producer failed");
      }),
      /producer failed/
    );
  });
  test("undefined results pass through (caller's 'do not cache' signal)", async () => {
    const v = await cached(key("tst2", "undef"), 60, async () => undefined);
    assert.equal(v, undefined);
  });
  test("invalidate() never throws", async () => {
    await invalidate(key("tst2", "value"), key("tst2", "other"));
  });
});
