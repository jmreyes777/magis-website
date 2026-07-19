// Attachment resolve resilience — guest side (mirrors the admin-frontend
// AdminMessageItem.media.test.js; the branch→guest "Loading attachment…"
// forever incident, 2026-07-19).
//
// The guest widget is where the incident was VISIBLE: an admin-sent image
// stayed on "Loading attachment…" indefinitely because a failed resolve had
// no retry and no failure state.
//
// Tests inject retryDelaysMs=[0,0,0] and run REAL timers (jest-27 fake timers
// deadlock RTL's waitFor — see the admin-frontend twin test).
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MessageItem from "./Message-Item-Component";
import { resolveGuestMedia, invalidateGuestMedia } from "./mediaResolver";

jest.mock("./mediaResolver", () => ({
  resolveGuestMedia: jest.fn(),
  invalidateGuestMedia: jest.fn(),
}));

const NO_DELAYS = [0, 0, 0];

const branchImageMessage = {
  id: "msg-media-9",
  message: "",
  sender: "branch",
  status: "sent",
  timestamp: "2026-07-19T08:52:00.000Z",
  media: { type: "image", path: "media/branch-1/uuid-rates.png" },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("branch-sent image that fails once still renders after the backoff retry", async () => {
  resolveGuestMedia
    .mockRejectedValueOnce(new Error("media resolve failed (503)"))
    .mockResolvedValueOnce({ type: "image", url: "https://signed.example/rates.png" });

  render(
    <MessageItem
      message={branchImageMessage}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );
  expect(screen.getByText(/loading attachment/i)).toBeInTheDocument();

  await waitFor(() =>
    expect(screen.getByAltText("Image Attachment")).toBeInTheDocument()
  );
  expect(resolveGuestMedia).toHaveBeenCalledTimes(2);
});

test("exhausted retries surface tap-to-retry instead of an eternal loading label", async () => {
  resolveGuestMedia.mockRejectedValue(new Error("media resolve failed (500)"));

  render(
    <MessageItem
      message={branchImageMessage}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );

  const retryBtn = await screen.findByRole("button", {
    name: /attachment unavailable/i,
  });
  expect(resolveGuestMedia).toHaveBeenCalledTimes(4);
  expect(screen.queryByText(/loading attachment/i)).not.toBeInTheDocument();

  resolveGuestMedia.mockResolvedValueOnce({
    type: "image",
    url: "https://signed.example/fresh.png",
  });
  await userEvent.click(retryBtn);

  await waitFor(() =>
    expect(screen.getByAltText("Image Attachment")).toBeInTheDocument()
  );
  expect(invalidateGuestMedia).toHaveBeenCalledWith("msg-media-9");
});

test("text-only messages never call the resolver", () => {
  render(
    <MessageItem
      message={{ ...branchImageMessage, media: null, message: "hello" }}
      sender="branch"
      isLatest={false}
      retryDelaysMs={NO_DELAYS}
    />
  );
  expect(resolveGuestMedia).not.toHaveBeenCalled();
});
