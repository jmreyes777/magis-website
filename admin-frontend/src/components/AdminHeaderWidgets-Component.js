// Shared header widget cluster: waiting-guests chip + gold ticker + branch
// identity chip, usable on EVERY admin page.
//
// Two feeding modes:
//   • Live (chat dashboard): pass `chats` + `unreadCounts` props — richest data.
//   • Self-feeding (audit/analytics/observability): omit the props. The
//     cluster hydrates from the same localStorage snapshots the dashboard
//     maintains (`branchChats-<email>`, `unreadCounts-<email>`) and stays
//     fresh through the module-level socket singleton, which remains
//     connected across SPA navigation — updateUnread events keep arriving
//     even while the dashboard is unmounted.
import React, { useContext, useEffect, useState } from "react";
import AuthContext from "../context/AuthContext";
import GoldPriceTicker from "./GoldPriceTicker-Component";
import HeaderWaitingChip from "./HeaderWaitingChip-Component";
import BranchIdentityChip from "./BranchIdentityChip-Component";
import { onUnreadUpdate } from "./Admin-Utils-socket";

const SNAPSHOT_REFRESH_MS = 30 * 1000;

export const unreadStorageKey = (branchEmail) => `unreadCounts-${branchEmail}`;

export function readUnreadSnapshot(branchEmail) {
  if (!branchEmail) return {};
  try {
    const parsed = JSON.parse(
      localStorage.getItem(unreadStorageKey(branchEmail)) || "{}"
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readChatsSnapshot(branchEmail) {
  if (!branchEmail) return [];
  try {
    const parsed = JSON.parse(
      localStorage.getItem(`branchChats-${branchEmail}`) || "{}"
    );
    return Array.isArray(parsed?.chats) ? parsed.chats : [];
  } catch {
    return [];
  }
}

export default function AdminHeaderWidgets({ chats, unreadCounts }) {
  const { branchSession } = useContext(AuthContext);
  const branchEmail = (branchSession?.email || "").toLowerCase().trim();

  // Dashboard passes live state; other pages self-feed from the snapshot.
  const live = chats !== undefined && unreadCounts !== undefined;

  const [snapUnread, setSnapUnread] = useState(() =>
    live ? {} : readUnreadSnapshot(branchEmail)
  );
  const [snapChats, setSnapChats] = useState(() =>
    live ? [] : readChatsSnapshot(branchEmail)
  );

  useEffect(() => {
    if (live || !branchEmail) return;

    // Re-hydrate when branchEmail resolves after auth hydration.
    setSnapUnread(readUnreadSnapshot(branchEmail));
    setSnapChats(readChatsSnapshot(branchEmail));

    // Server-authoritative unread pushes keep flowing while the dashboard is
    // unmounted; fold them into the snapshot so the chip stays truthful AND
    // the dashboard finds the updated counts when it remounts.
    const unsub = onUnreadUpdate(({ guestId, unreadCount }) => {
      if (!guestId) return;
      setSnapUnread((prev) => {
        const next = { ...prev, [guestId]: unreadCount };
        try {
          localStorage.setItem(
            unreadStorageKey(branchEmail),
            JSON.stringify(next)
          );
        } catch {
          /* storage may be unavailable — chip still updates in-memory */
        }
        return next;
      });
    });

    // Cheap periodic re-read keeps chat previews fresh if another tab (with
    // the dashboard open) is updating the snapshots.
    const t = setInterval(() => {
      setSnapChats(readChatsSnapshot(branchEmail));
      setSnapUnread(readUnreadSnapshot(branchEmail));
    }, SNAPSHOT_REFRESH_MS);

    return () => {
      unsub();
      clearInterval(t);
    };
  }, [live, branchEmail]);

  return (
    <>
      {branchEmail && (
        <HeaderWaitingChip
          chats={live ? chats : snapChats}
          unreadCounts={live ? unreadCounts : snapUnread}
        />
      )}
      <GoldPriceTicker />
      <BranchIdentityChip branchEmail={branchEmail} />
    </>
  );
}
