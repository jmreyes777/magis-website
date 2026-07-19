// ADM follow-up — attachment resolve resilience (the branch→guest "Loading
// attachment…" forever incident, 2026-07-19).
//
// Contract under test:
//   1. a transient resolve failure self-heals via bounded backoff retries
//   2. after the retry budget the user gets an explicit tap-to-retry state —
//      NEVER an eternal "Loading attachment…"
//   3. tapping retry invalidates the TTL cache and refetches
//
// Tests inject retryDelaysMs=[0,0,0] and run REAL timers: jest-27 fake timers
// deadlock RTL's waitFor (it polls via the same faked setInterval), and
// hand-flushing the promise/timer interleave proved flaky.
// resolveAdminMedia is a STATIC import in the component, so jest.mock works
// (unlike dynamic import() — see the web-vitals landmine in TESTING-MEGAPLAN).
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminMessageItem from "./Admin-Message-Item-Component";
import { resolveAdminMedia, invalidateAdminMedia } from "../utils/mediaResolver";

jest.mock("../utils/mediaResolver", () => ({
  resolveAdminMedia: jest.fn(),
  invalidateAdminMedia: jest.fn(),
}));

const NO_DELAYS = [0, 0, 0];

const mediaMessage = {
  id: "msg-media-1",
  content: "",
  sender: "branch",
  status: "sent",
  timestamp: "2026-07-19T08:52:00.000Z",
  media: { type: "image", path: "media/branch-1/uuid-photo.jpg" },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("transient resolve failure self-heals on the backoff retry", async () => {
  resolveAdminMedia
    .mockRejectedValueOnce(new Error("media resolve failed (503)"))
    .mockResolvedValueOnce({ type: "image", url: "https://signed.example/p.jpg" });

  render(
    <AdminMessageItem
      message={mediaMessage}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );
  expect(screen.getByText(/loading attachment/i)).toBeInTheDocument();

  await waitFor(() =>
    expect(screen.getByAltText("Image Attachment")).toBeInTheDocument()
  );
  expect(resolveAdminMedia).toHaveBeenCalledTimes(2);
});

test("exhausted retries show tap-to-retry, and tapping refetches after cache invalidation", async () => {
  resolveAdminMedia.mockRejectedValue(new Error("media resolve failed (500)"));

  render(
    <AdminMessageItem
      message={mediaMessage}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );

  // Retry budget burns at t≈0 (zero delays); the failure state must replace
  // the loading label — never both, never neither.
  const retryBtn = await screen.findByRole("button", {
    name: /attachment unavailable/i,
  });
  expect(resolveAdminMedia).toHaveBeenCalledTimes(4); // initial + 3 retries
  expect(screen.queryByText(/loading attachment/i)).not.toBeInTheDocument();

  // Manual retry: cache must be invalidated, then a fresh resolve succeeds.
  resolveAdminMedia.mockResolvedValueOnce({
    type: "image",
    url: "https://signed.example/fresh.jpg",
  });
  await userEvent.click(retryBtn);

  await waitFor(() =>
    expect(screen.getByAltText("Image Attachment")).toBeInTheDocument()
  );
  expect(invalidateAdminMedia).toHaveBeenCalledWith("msg-media-1");
});

test("messages without media never call the resolver", () => {
  render(
    <AdminMessageItem
      message={{ ...mediaMessage, media: null, content: "hi" }}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );
  expect(resolveAdminMedia).not.toHaveBeenCalled();
  expect(screen.queryByText(/loading attachment/i)).not.toBeInTheDocument();
});
