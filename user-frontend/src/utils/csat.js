// user-frontend/src/utils/csat.js
//
// CHATUX2: post-chat CSAT prompt — eligibility gate + dispatcher.
//
// Design rule: the rating must NEVER feel like part of the chat flow. The
// chat closes instantly and completely on its own; if (and only if) the
// conversation qualifies, a small self-dismissing toast appears afterwards
// (see components/Guest-Csat-Toast.js). Qualification:
//
//   1. Staff actually replied in this conversation — a chat nobody answered
//      is not a service interaction worth rating (and prompting on it would
//      add insult to injury).
//   2. A long per-device cooldown (default 14 days) since the LAST TIME THE
//      PROMPT WAS SHOWN — rated, dismissed, or ignored all count, so a
//      regular who chats daily sees the prompt at most ~2x/month.
//
// The stamp is written when the prompt is dispatched (shown), not when the
// guest interacts — "shown" is the annoyance being budgeted.

export const CSAT_EVENT = "magis:csat";
export const CSAT_LS_KEY = "magisCsatLastPromptAt";
export const CSAT_COOLDOWN_DAYS = 14;

/** True if the cooldown window has elapsed (or never prompted / storage off). */
export function csatCooldownElapsed(now = Date.now()) {
  try {
    const last = Number(localStorage.getItem(CSAT_LS_KEY));
    if (!Number.isFinite(last) || last <= 0) return true;
    return now - last >= CSAT_COOLDOWN_DAYS * 86400_000;
  } catch {
    // Storage unavailable → cannot budget the annoyance → don't prompt.
    return false;
  }
}

/**
 * Offer the CSAT toast for a just-closed conversation, if it qualifies.
 * Fire-and-forget; never throws; returns whether the prompt was dispatched.
 *
 * @param {Object}  p
 * @param {Array}   p.messages     conversation messages ({ sender } is read)
 * @param {string}  p.guestId
 * @param {string}  p.branchEmail
 * @param {string}  [p.branchName]
 */
export function maybePromptCsat({ messages, guestId, branchEmail, branchName } = {}) {
  try {
    if (!guestId || !branchEmail) return false;
    const staffReplied =
      Array.isArray(messages) && messages.some((m) => m && m.sender === "branch");
    if (!staffReplied) return false;
    if (!csatCooldownElapsed()) return false;

    localStorage.setItem(CSAT_LS_KEY, String(Date.now()));
    window.dispatchEvent(
      new CustomEvent(CSAT_EVENT, {
        detail: { guestId, branchEmail, branchName: branchName || "" },
      })
    );
    return true;
  } catch {
    return false; // feedback plumbing must never break the close flow
  }
}

export default maybePromptCsat;
