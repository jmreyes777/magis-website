// CHAT-PARK: the parked nav layout (Chat Dashboard hidden, Analytics surfaced)
// is a pure function — test it without rendering.
import { getNavItems } from "./AdminNavigation-Component";

describe("getNavItems (CHAT-PARK)", () => {
  test("chat-on build keeps the original four items in order", () => {
    expect(getNavItems(true).map((i) => i.path)).toEqual([
      "/admin/chats",
      "/admin/audit",
      "/admin/observability",
      "/admin/branches",
    ]);
  });

  test("chat-off build hides chats and surfaces Analytics", () => {
    expect(getNavItems(false).map((i) => i.path)).toEqual([
      "/admin/audit",
      "/admin/analytics",
      "/admin/observability",
      "/admin/branches",
    ]);
  });
});
