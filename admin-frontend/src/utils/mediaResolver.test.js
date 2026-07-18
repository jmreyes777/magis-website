// ADM1 — mediaResolver: private chat media -> short-lived signed URLs.
//
// The module keeps a TTL cache so scrolling a chat thread doesn't re-sign
// every image on every render. Cache is module-level state — each test uses
// unique messageIds to stay independent.

import { resolveAdminMedia, invalidateAdminMedia } from "./mediaResolver";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  global.fetch = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

function okResponse(data) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

test("null/undefined messageId short-circuits without fetching", async () => {
  await expect(resolveAdminMedia(null)).resolves.toBeNull();
  await expect(resolveAdminMedia(undefined)).resolves.toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("fetches with Bearer token from sessionStorage and returns the payload", async () => {
  sessionStorage.setItem("branchAdminToken", "sess-tok");
  global.fetch.mockReturnValue(okResponse({ url: "https://signed/1" }));

  const data = await resolveAdminMedia("msg-auth-1");
  expect(data).toEqual({ url: "https://signed/1" });

  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/messages\/admin-media\/msg-auth-1$/);
  expect(opts.credentials).toBe("include");
  expect(opts.headers.Authorization).toBe("Bearer sess-tok");
});

test("falls back to localStorage token; omits header when no token anywhere", async () => {
  localStorage.setItem("branchAdminToken", "local-tok");
  global.fetch.mockReturnValue(okResponse({ url: "u" }));
  await resolveAdminMedia("msg-auth-2");
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer local-tok");

  localStorage.clear();
  global.fetch.mockReturnValue(okResponse({ url: "u2" }));
  await resolveAdminMedia("msg-auth-3");
  expect(global.fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
});

test("messageId is URL-encoded (no path injection)", async () => {
  global.fetch.mockReturnValue(okResponse({ url: "u" }));
  await resolveAdminMedia("msg/../../etc");
  expect(global.fetch.mock.calls[0][0]).toContain(
    `/api/messages/admin-media/${encodeURIComponent("msg/../../etc")}`
  );
});

test("second resolve within TTL serves from cache — one fetch total", async () => {
  global.fetch.mockReturnValue(okResponse({ url: "https://signed/cached" }));
  const a = await resolveAdminMedia("msg-cache-1");
  const b = await resolveAdminMedia("msg-cache-1");
  expect(a).toEqual(b);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("invalidateAdminMedia forces a refetch (used after upload replace)", async () => {
  global.fetch
    .mockReturnValueOnce(okResponse({ url: "v1" }))
    .mockReturnValueOnce(okResponse({ url: "v2" }));

  await resolveAdminMedia("msg-inval-1");
  invalidateAdminMedia("msg-inval-1");
  const after = await resolveAdminMedia("msg-inval-1");

  expect(after).toEqual({ url: "v2" });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("non-OK response throws with status and is NOT cached", async () => {
  global.fetch
    .mockResolvedValueOnce({ ok: false, status: 403 })
    .mockReturnValueOnce(okResponse({ url: "recovered" }));

  await expect(resolveAdminMedia("msg-err-1")).rejects.toThrow(/403/);
  // The failure must not poison the cache:
  await expect(resolveAdminMedia("msg-err-1")).resolves.toEqual({ url: "recovered" });
});
