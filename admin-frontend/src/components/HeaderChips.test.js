// Header chips — waiting-guests SLA states + identity/connection health.
import { render, screen } from "@testing-library/react";
import HeaderWaitingChip, {
  computeWaiting,
  formatWait,
  SLA_RED_MS,
} from "./HeaderWaitingChip-Component";
import BranchIdentityChip, {
  healthOf,
} from "./BranchIdentityChip-Component";

// CRA sets jest `resetMocks: true`, which strips factory implementations
// before every test — implementations must be (re)applied inside the tests.
jest.mock("./Admin-Utils-socket", () => ({
  getSocketInstance: jest.fn(),
  isHeartbeatActive: jest.fn(),
}));
import {
  getSocketInstance,
  isHeartbeatActive,
} from "./Admin-Utils-socket";

const NOW = Date.now();
const mins = (n) => NOW - n * 60 * 1000;

describe("HeaderWaitingChip", () => {
  test("all caught up when nothing is unread", () => {
    render(
      <HeaderWaitingChip
        chats={[{ guestId: "g1", timestamp: mins(2) }]}
        unreadCounts={{ g1: 0 }}
      />
    );
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
  });

  test("counts waiting chats and reports the LONGEST wait", () => {
    render(
      <HeaderWaitingChip
        chats={[
          { guestId: "g1", timestamp: mins(2) },
          { guestId: "g2", timestamp: mins(9) },
          { guestId: "g3", timestamp: mins(1) }, // read → excluded
        ]}
        unreadCounts={{ g1: 1, g2: 3, g3: 0 }}
      />
    );
    expect(screen.getByText(/2 waiting · 9m/)).toBeInTheDocument();
  });

  test("computeWaiting ignores rows without guestId and tolerates bad timestamps", () => {
    const { count, longestMs } = computeWaiting(
      [
        { guestId: null, timestamp: mins(90) },
        { guestId: "g1", timestamp: "not-a-date" },
      ],
      { g1: 2, null: 5 },
      NOW
    );
    expect(count).toBe(1);
    expect(longestMs).toBe(0); // bad timestamp → no phantom 90m wait
  });

  test("SLA threshold marks the chip late", () => {
    const { container } = render(
      <HeaderWaitingChip
        chats={[{ guestId: "g1", timestamp: NOW - SLA_RED_MS - 1000 }]}
        unreadCounts={{ g1: 1 }}
      />
    );
    expect(container.querySelector(".waiting-chip--late")).toBeInTheDocument();
  });

  test("formatWait buckets", () => {
    expect(formatWait(30 * 1000)).toBe("<1m");
    expect(formatWait(7 * 60 * 1000)).toBe("7m");
    expect(formatWait(90 * 60 * 1000)).toBe("1h 30m");
  });
});

describe("BranchIdentityChip", () => {
  test("shows the account local-part with a healthy dot", () => {
    getSocketInstance.mockReturnValue({ connected: true });
    isHeartbeatActive.mockReturnValue(true);
    const { container } = render(
      <BranchIdentityChip branchEmail="jm.reyes@magisgold.com" />
    );
    expect(screen.getByText("jm.reyes")).toBeInTheDocument();
    expect(container.querySelector(".identity-chip--ok")).toBeInTheDocument();
  });

  test("renders nothing without a branch email", () => {
    const { container } = render(<BranchIdentityChip branchEmail="" />);
    expect(container).toBeEmptyDOMElement();
  });

  test("healthOf maps connection states", () => {
    expect(healthOf(true, true)).toBe("ok");
    expect(healthOf(true, false)).toBe("degraded");
    expect(healthOf(false, true)).toBe("down");
  });
});
