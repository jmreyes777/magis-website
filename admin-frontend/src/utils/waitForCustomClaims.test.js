// ADM1 — waitForCustomClaims quota-safety contract.
//
// This util exists because a previous version force-refreshed Firebase ID
// tokens in a 30s loop from socket handlers and tripped auth/quota-exceeded
// in production. These tests pin the three defenses: cached-token-first,
// bounded forced refreshes with abort-on-quota, and cross-call result caching
// with in-flight dedup. firebase/auth is mocked — no network.

import {
  waitForCustomClaims,
  clearCustomClaimsCache,
} from "./waitForCustomClaims";
import { getAuth } from "firebase/auth";

jest.mock("firebase/auth", () => ({ getAuth: jest.fn() }));

function fakeUser(uid, getIdTokenResult) {
  return { uid, getIdTokenResult };
}

beforeEach(() => {
  clearCustomClaimsCache();
  jest.clearAllMocks();
});

const FAST = { maxForcedRefreshes: 2, interval: 0 };

test("no signed-in user resolves false without touching tokens", async () => {
  getAuth.mockReturnValue({ currentUser: null });
  await expect(waitForCustomClaims("branchadmin", FAST)).resolves.toBe(false);
});

test("role already in CACHED token: true with zero forced refreshes", async () => {
  const getIdTokenResult = jest.fn().mockResolvedValue({
    claims: { role: "branchadmin" },
  });
  getAuth.mockReturnValue({ currentUser: fakeUser("u1", getIdTokenResult) });

  await expect(waitForCustomClaims("branchadmin", FAST)).resolves.toBe(true);
  expect(getIdTokenResult).toHaveBeenCalledTimes(1);
  expect(getIdTokenResult).toHaveBeenCalledWith(false); // cached, not forced
});

test("claims set moments ago: found on a forced refresh", async () => {
  const getIdTokenResult = jest
    .fn()
    .mockResolvedValueOnce({ claims: {} }) // cached token — stale
    .mockResolvedValueOnce({ claims: { role: "superadmin" } }); // forced
  getAuth.mockReturnValue({ currentUser: fakeUser("u2", getIdTokenResult) });

  await expect(waitForCustomClaims("superadmin", FAST)).resolves.toBe(true);
  expect(getIdTokenResult).toHaveBeenNthCalledWith(1, false);
  expect(getIdTokenResult).toHaveBeenNthCalledWith(2, true);
});

test("quota-exceeded during cached check aborts immediately (the prod incident)", async () => {
  const getIdTokenResult = jest
    .fn()
    .mockRejectedValue({ code: "auth/quota-exceeded" });
  getAuth.mockReturnValue({ currentUser: fakeUser("u3", getIdTokenResult) });

  await expect(waitForCustomClaims("branchadmin", FAST)).resolves.toBe(false);
  // One cached attempt, NO forced refreshes piled onto a blown quota.
  expect(getIdTokenResult).toHaveBeenCalledTimes(1);
});

test("quota-exceeded mid-forced-refresh stops the loop", async () => {
  const getIdTokenResult = jest
    .fn()
    .mockResolvedValueOnce({ claims: {} }) // cached
    .mockRejectedValueOnce({ code: "auth/quota-exceeded" }); // forced #1
  getAuth.mockReturnValue({ currentUser: fakeUser("u4", getIdTokenResult) });

  await expect(waitForCustomClaims("branchadmin", FAST)).resolves.toBe(false);
  expect(getIdTokenResult).toHaveBeenCalledTimes(2); // no forced #2
});

test("non-abort errors don't kill the loop; refreshes stay bounded", async () => {
  const getIdTokenResult = jest
    .fn()
    .mockResolvedValueOnce({ claims: {} }) // cached
    .mockRejectedValueOnce(new Error("flaky network")) // forced #1
    .mockResolvedValueOnce({ claims: {} }); // forced #2 — still no role
  getAuth.mockReturnValue({ currentUser: fakeUser("u5", getIdTokenResult) });

  await expect(waitForCustomClaims("branchadmin", FAST)).resolves.toBe(false);
  expect(getIdTokenResult).toHaveBeenCalledTimes(3); // 1 cached + exactly 2 forced
});

test("confirmed result is cached: repeat calls are free", async () => {
  const getIdTokenResult = jest.fn().mockResolvedValue({
    claims: { role: "branchadmin" },
  });
  getAuth.mockReturnValue({ currentUser: fakeUser("u6", getIdTokenResult) });

  await waitForCustomClaims("branchadmin", FAST);
  await waitForCustomClaims("branchadmin", FAST);
  await waitForCustomClaims("branchadmin", FAST);
  expect(getIdTokenResult).toHaveBeenCalledTimes(1);

  clearCustomClaimsCache(); // logout
  await waitForCustomClaims("branchadmin", FAST);
  expect(getIdTokenResult).toHaveBeenCalledTimes(2);
});

test("concurrent burst (socket events) collapses into one token check", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const getIdTokenResult = jest.fn(async () => {
    await gate;
    return { claims: { role: "branchadmin" } };
  });
  getAuth.mockReturnValue({ currentUser: fakeUser("u7", getIdTokenResult) });

  const burst = Promise.all([
    waitForCustomClaims("branchadmin", FAST),
    waitForCustomClaims("branchadmin", FAST),
    waitForCustomClaims("branchadmin", FAST),
  ]);
  release();
  await expect(burst).resolves.toEqual([true, true, true]);
  expect(getIdTokenResult).toHaveBeenCalledTimes(1);
});
