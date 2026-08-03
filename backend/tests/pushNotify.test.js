// CHATUX3 guardrails for the staff web-push helper (utils/pushNotify.js).
// Run without VAPID env on purpose: the entire feature must degrade to a
// clean no-op when unconfigured — a missing env var can never break chat.
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isPushConfigured,
  publicKey,
  endpointDocId,
  shouldNotify,
  notifyGuestWaiting,
  sendBranchPush,
  __testResetCooldowns,
} = require("../utils/pushNotify");

const COOLDOWN_MS = Math.max(parseInt(process.env.PUSH_COOLDOWN_MIN, 10) || 5, 1) * 60_000;

describe("pushNotify — unconfigured degradation", () => {
  test("without VAPID env: reports unconfigured, no public key", () => {
    assert.equal(isPushConfigured(), false);
    assert.equal(publicKey(), null);
  });

  test("notifyGuestWaiting / sendBranchPush are safe no-ops", async () => {
    assert.doesNotThrow(() => notifyGuestWaiting("b@x.com", "guest-1"));
    const out = await sendBranchPush("b@x.com", { title: "t" });
    assert.deepEqual(out, { sent: 0, pruned: 0 });
  });
});

describe("pushNotify — per-conversation cooldown", () => {
  test("first message notifies, burst within cooldown stays silent", () => {
    __testResetCooldowns();
    const t0 = 1_000_000;
    assert.equal(shouldNotify("b@x.com", "guest-1", t0), true);
    assert.equal(shouldNotify("b@x.com", "guest-1", t0 + 1_000), false);
    assert.equal(shouldNotify("b@x.com", "guest-1", t0 + COOLDOWN_MS - 1), false);
  });

  test("cooldown elapses → notifies again; other conversations independent", () => {
    __testResetCooldowns();
    const t0 = 2_000_000;
    assert.equal(shouldNotify("b@x.com", "guest-1", t0), true);
    // A different guest or a different branch is its own conversation.
    assert.equal(shouldNotify("b@x.com", "guest-2", t0), true);
    assert.equal(shouldNotify("other@x.com", "guest-1", t0), true);
    // Same conversation, past the cooldown boundary.
    assert.equal(shouldNotify("b@x.com", "guest-1", t0 + COOLDOWN_MS), true);
  });
});

describe("pushNotify — endpoint doc ids", () => {
  test("stable hash of the endpoint (idempotent re-subscribe)", () => {
    const a = endpointDocId("https://push.example/abc");
    assert.equal(a, endpointDocId("https://push.example/abc"));
    assert.notEqual(a, endpointDocId("https://push.example/xyz"));
    assert.match(a, /^[a-f0-9]{64}$/);
  });
});
