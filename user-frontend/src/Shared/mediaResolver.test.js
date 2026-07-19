// Guest media resolver — auth-expiry contract (2026-07-19, 06:17 PM incident).
//
// Guest JWTs live 1 hour; chats regularly outlive them. The resolver must
// never let a stale token turn into a permanent "Attachment unavailable":
//   1. a known-expired stored token triggers a refresh BEFORE the media call
//   2. a surprise 401 triggers one refresh-and-retry
//   3. concurrent resolves share a single refresh (single-flight)
import { resolveGuestMedia, invalidateGuestMedia } from "./mediaResolver";

const b64 = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, "");
const jwtWithExp = (expMsFromNow) =>
  `header.${b64({ exp: Math.floor((Date.now() + expMsFromNow) / 1000) })}.sig`;

const SIGNED = { type: "image", url: "https://signed.example/p.jpg" };

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let fetchMock;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  delete window.__CSRF_TOKEN__;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  // The module caches resolves per messageId across tests.
  invalidateGuestMedia("m-1");
  invalidateGuestMedia("m-2");
});

const callsTo = (fragment) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));

test("fresh token: exactly one media call, no refresh traffic", async () => {
  sessionStorage.setItem("guestToken", jwtWithExp(50 * 60 * 1000));
  fetchMock.mockResolvedValueOnce(jsonRes(200, SIGNED));

  const out = await resolveGuestMedia("m-1");
  expect(out).toEqual(SIGNED);
  expect(callsTo("/api/messages/media/")).toHaveLength(1);
  expect(callsTo("refresh-token")).toHaveLength(0);
});

test("known-expired token refreshes BEFORE the media call and uses the new token", async () => {
  sessionStorage.setItem("guestToken", jwtWithExp(-5 * 60 * 1000)); // 5 min stale
  window.__CSRF_TOKEN__ = "csrf-1";
  fetchMock
    .mockResolvedValueOnce(jsonRes(200, { token: "fresh-token" })) // refresh
    .mockResolvedValueOnce(jsonRes(200, SIGNED)); // media

  const out = await resolveGuestMedia("m-1");
  expect(out).toEqual(SIGNED);

  const [refreshUrl] = fetchMock.mock.calls[0];
  expect(String(refreshUrl)).toMatch(/refresh-token/);
  const [mediaUrl, mediaOpts] = fetchMock.mock.calls[1];
  expect(String(mediaUrl)).toMatch(/\/api\/messages\/media\/m-1/);
  expect(mediaOpts.headers.Authorization).toBe("Bearer fresh-token");
  expect(sessionStorage.getItem("guestToken")).toBe("fresh-token");
});

test("surprise 401 (server-side invalidation) → one refresh → retried with new token", async () => {
  sessionStorage.setItem("guestToken", jwtWithExp(50 * 60 * 1000)); // looks fresh
  window.__CSRF_TOKEN__ = "csrf-1";
  fetchMock
    .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // media #1
    .mockResolvedValueOnce(jsonRes(200, { token: "fresh-token" })) // refresh
    .mockResolvedValueOnce(jsonRes(200, SIGNED)); // media #2

  const out = await resolveGuestMedia("m-1");
  expect(out).toEqual(SIGNED);
  expect(callsTo("/api/messages/media/")).toHaveLength(2);
  const [, retryOpts] = fetchMock.mock.calls[2];
  expect(retryOpts.headers.Authorization).toBe("Bearer fresh-token");
});

test("failed refresh surfaces the original 401 as a throw (retry ladder takes over)", async () => {
  sessionStorage.setItem("guestToken", jwtWithExp(50 * 60 * 1000));
  window.__CSRF_TOKEN__ = "csrf-1";
  fetchMock
    .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // media
    .mockResolvedValueOnce(jsonRes(403, { error: "nope" })); // refresh fails

  await expect(resolveGuestMedia("m-1")).rejects.toThrow(/401/);
});

test("concurrent expired-token resolves share ONE refresh (single-flight)", async () => {
  sessionStorage.setItem("guestToken", jwtWithExp(-60 * 1000));
  window.__CSRF_TOKEN__ = "csrf-1";
  fetchMock.mockImplementation((url) => {
    const u = String(url);
    if (u.includes("refresh-token")) {
      return Promise.resolve(jsonRes(200, { token: "fresh-token" }));
    }
    return Promise.resolve(jsonRes(200, SIGNED));
  });

  const [a, b] = await Promise.all([
    resolveGuestMedia("m-1"),
    resolveGuestMedia("m-2"),
  ]);
  expect(a).toEqual(SIGNED);
  expect(b).toEqual(SIGNED);
  expect(callsTo("refresh-token")).toHaveLength(1);
});
