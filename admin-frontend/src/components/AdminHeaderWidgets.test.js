// AdminHeaderWidgets — self-feeding mode used by non-chat admin pages.
// Regression for: navigating to Audit/Analytics hid the header widgets, and
// returning to the chat dashboard reset the waiting/unread state.
import { act, render, screen } from "@testing-library/react";
import AuthContext from "../context/AuthContext";
import AdminHeaderWidgets, {
  readChatsSnapshot,
  readUnreadSnapshot,
  unreadStorageKey,
} from "./AdminHeaderWidgets-Component";

jest.mock("./Admin-Utils-socket", () => ({
  getSocketInstance: jest.fn(),
  isHeartbeatActive: jest.fn(),
  onUnreadUpdate: jest.fn(),
}));
import { onUnreadUpdate, getSocketInstance } from "./Admin-Utils-socket";

const EMAIL = "branch@magisgold.com";
const NOW = Date.now();

function seedSnapshots() {
  localStorage.setItem(
    `branchChats-${EMAIL}`,
    JSON.stringify({
      version: 1,
      chats: [
        { guestId: "g1", timestamp: NOW - 3 * 60 * 1000 },
        { guestId: "g2", timestamp: NOW - 60 * 1000 },
      ],
      activeGuestIds: [],
    })
  );
  localStorage.setItem(
    unreadStorageKey(EMAIL),
    JSON.stringify({ g1: 2, g2: 0 })
  );
}

function renderWidgets() {
  return render(
    <AuthContext.Provider value={{ branchSession: { email: EMAIL } }}>
      <AdminHeaderWidgets />
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  localStorage.clear();
  // Gold ticker fetches inside; unreachable APIs must degrade gracefully.
  global.fetch = jest.fn(() => Promise.reject(new Error("offline")));
  getSocketInstance.mockReturnValue({ connected: true });
  onUnreadUpdate.mockReturnValue(() => {});
});

test("self-feeds the waiting chip from the persisted snapshots", async () => {
  seedSnapshots();
  await act(async () => {
    renderWidgets();
  });
  // g1 has 2 unread, waiting ~3m; g2 is read.
  expect(screen.getByText(/1 waiting · 3m/)).toBeInTheDocument();
  expect(screen.getByText("branch")).toBeInTheDocument(); // identity chip
});

test("live updateUnread events refresh the chip and persist for the dashboard's return", async () => {
  seedSnapshots();
  let pushUnread;
  onUnreadUpdate.mockImplementation((cb) => {
    pushUnread = cb;
    return () => {};
  });

  await act(async () => {
    renderWidgets();
  });

  await act(async () => {
    pushUnread({ guestId: "g2", unreadCount: 4 });
  });

  expect(screen.getByText(/2 waiting/)).toBeInTheDocument();
  // The snapshot the chat dashboard will hydrate from on remount:
  expect(readUnreadSnapshot(EMAIL)).toEqual({ g1: 2, g2: 4 });
});

test("counts a BRAND-NEW guest who messages while the dashboard is unmounted", async () => {
  // Snapshot knows nothing about g9 — only the live event announces them.
  localStorage.setItem(
    `branchChats-${EMAIL}`,
    JSON.stringify({ version: 1, chats: [], activeGuestIds: [] })
  );
  let pushUnread;
  onUnreadUpdate.mockImplementation((cb) => {
    pushUnread = cb;
    return () => {};
  });

  await act(async () => {
    renderWidgets();
  });
  expect(screen.getByText(/All caught up/i)).toBeInTheDocument();

  await act(async () => {
    pushUnread({ guestId: "g9", unreadCount: 1 });
  });
  expect(screen.getByText(/1 waiting/)).toBeInTheDocument();
});

test("snapshot readers tolerate corrupt storage", () => {
  localStorage.setItem(unreadStorageKey(EMAIL), "{not json");
  localStorage.setItem(`branchChats-${EMAIL}`, "also not json");
  expect(readUnreadSnapshot(EMAIL)).toEqual({});
  expect(readChatsSnapshot(EMAIL)).toEqual([]);
  expect(readUnreadSnapshot("")).toEqual({});
});

test("without a branch email the waiting chip is omitted (superadmin)", async () => {
  await act(async () => {
    render(
      <AuthContext.Provider value={{ branchSession: { email: "" } }}>
        <AdminHeaderWidgets />
      </AuthContext.Provider>
    );
  });
  expect(screen.queryByText(/waiting|caught up/i)).not.toBeInTheDocument();
  expect(screen.getByText("GOLD")).toBeInTheDocument(); // ticker still there
});
