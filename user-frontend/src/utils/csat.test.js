// CHATUX2 guardrails: the CSAT prompt must stay OPTIONAL and RARE. These pin
// the two product rules (user spec, 2026-08-02):
//   1. never prompt unless staff actually replied in the conversation
//   2. a 14-day per-device cooldown from the moment a prompt is SHOWN —
//      rated, dismissed, or ignored, a regular guest is not re-nagged
import {
  maybePromptCsat,
  csatCooldownElapsed,
  CSAT_EVENT,
  CSAT_LS_KEY,
  CSAT_COOLDOWN_DAYS,
} from "./csat";

const DAY_MS = 86400_000;
const base = { guestId: "guest-1", branchEmail: "mabalacat@x.com", branchName: "Mabalacat" };
const staffed = [{ sender: "guest" }, { sender: "branch" }];

let events;
const onEvent = (e) => events.push(e.detail);

beforeEach(() => {
  localStorage.clear();
  events = [];
  window.addEventListener(CSAT_EVENT, onEvent);
});

afterEach(() => {
  window.removeEventListener(CSAT_EVENT, onEvent);
});

test("prompts after a staffed conversation and stamps the cooldown", () => {
  expect(maybePromptCsat({ ...base, messages: staffed })).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject(base);
  expect(Number(localStorage.getItem(CSAT_LS_KEY))).toBeGreaterThan(0);
});

test("never prompts when staff did not reply (unanswered chats are not rated)", () => {
  expect(maybePromptCsat({ ...base, messages: [{ sender: "guest" }] })).toBe(false);
  expect(maybePromptCsat({ ...base, messages: [] })).toBe(false);
  expect(events).toHaveLength(0);
  expect(localStorage.getItem(CSAT_LS_KEY)).toBeNull();
});

test("regulars are not re-nagged: second qualifying close inside the cooldown is silent", () => {
  expect(maybePromptCsat({ ...base, messages: staffed })).toBe(true);
  expect(maybePromptCsat({ ...base, messages: staffed })).toBe(false);
  expect(events).toHaveLength(1);
});

test("prompts again only after the cooldown fully elapses", () => {
  const now = Date.now();
  localStorage.setItem(CSAT_LS_KEY, String(now - (CSAT_COOLDOWN_DAYS * DAY_MS - 60_000)));
  expect(csatCooldownElapsed(now)).toBe(false);
  expect(maybePromptCsat({ ...base, messages: staffed })).toBe(false);

  localStorage.setItem(CSAT_LS_KEY, String(now - (CSAT_COOLDOWN_DAYS * DAY_MS + 60_000)));
  expect(csatCooldownElapsed(now)).toBe(true);
  expect(maybePromptCsat({ ...base, messages: staffed })).toBe(true);
});

test("missing identifiers never prompt (close flow stays unbreakable)", () => {
  expect(maybePromptCsat({ messages: staffed })).toBe(false);
  expect(maybePromptCsat(undefined)).toBe(false);
  expect(events).toHaveLength(0);
});
