// admin-frontend/src/utils/errorReporter.js
//
// OBS1 (observability megaplan): client-side error telemetry for the ADMIN
// dashboard. Port of user-frontend/src/utils/errorReporter.js with one
// difference: payloads carry app:"admin" so the Observability dashboard and
// the R6 spike alert can tell staff-tool crashes apart from guest-site ones.
//
// Same guarantees as the guest reporter:
//   - Production-only; fire-and-forget sendBeacon (text/plain, no preflight);
//     fails silently and NEVER interferes with the page.
//   - Session-deduped (same message+stack sent once) and hard-capped
//     (MAX_PER_SESSION beacons) so an error loop can't flood the intake.
//   - Clamped payloads: message ≤ 500 chars, top stack frames ≤ 1500 chars,
//     path only (query strings stripped — they can carry tokens).
//   - Browser-extension noise (chrome-extension:// frames) is dropped.

const MAX_PER_SESSION = 10;
const MAX_MESSAGE = 500;
const MAX_STACK = 1500;
const STACK_FRAMES = 4;

const sent = new Map(); // dedupe key -> count (suppressed repeats)
let sends = 0;
let release = null;

const isEnabled = () =>
  process.env.NODE_ENV === "production" &&
  process.env.REACT_APP_CERR_DISABLED !== "true" &&
  typeof window !== "undefined";

// Build/release id = the content hash CRA stamps into the main bundle name.
function getRelease() {
  if (release !== null) return release;
  release = "";
  try {
    for (const s of document.scripts) {
      const m = /\/main\.([a-f0-9]{6,})\./.exec(s.src || "");
      if (m) {
        release = m[1].slice(0, 20);
        break;
      }
    }
  } catch {
    /* release stays "" */
  }
  return release;
}

function clampStack(stack) {
  if (!stack || typeof stack !== "string") return "";
  const frames = stack
    .split("\n")
    .filter((l) => !/(chrome|moz|safari)-extension:\/\//.test(l))
    .slice(0, STACK_FRAMES + 1); // message line + top frames
  return frames.join("\n").slice(0, MAX_STACK);
}

function toMessage(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err).slice(0, MAX_MESSAGE);
  } catch {
    return String(err);
  }
}

/**
 * Report an admin-dashboard error. Fire-and-forget; never throws.
 * @param {"error"|"rejection"|"boundary"|"recoverable"} type
 * @param {*} err            Error object (or reason/message)
 * @param {string} [detail]  Extra context (e.g. React componentStack)
 */
export function reportClientError(type, err, detail) {
  try {
    if (!isEnabled()) return;

    const message = toMessage(err).slice(0, MAX_MESSAGE);
    // Extension-injected errors are noise we can't fix — drop them entirely.
    if (/(chrome|moz|safari)-extension:\/\//.test(message)) return;

    const stack = clampStack(
      (err && err.stack) || (typeof detail === "string" ? detail : "")
    );
    const key = `${type}|${message.slice(0, 120)}|${stack.slice(0, 120)}`;

    const seen = sent.get(key) || 0;
    sent.set(key, seen + 1);
    if (seen > 0) return; // deduped: this exact error already reported
    if (sends >= MAX_PER_SESSION) return; // session cap
    sends += 1;

    const payload = JSON.stringify({
      app: "admin",
      type,
      message,
      stack,
      detail:
        typeof detail === "string" && detail !== stack
          ? clampStack(detail)
          : undefined,
      path: window.location.pathname.slice(0, 100),
      release: getRelease(),
      ts: Date.now(),
    });

    const url = `${process.env.REACT_APP_API_URL || ""}/api/client-errors`;
    if (navigator.sendBeacon) navigator.sendBeacon(url, payload);
    else
      fetch(url, { method: "POST", body: payload, keepalive: true }).catch(
        () => {}
      );
  } catch {
    /* telemetry must never break the page */
  }
}

export default reportClientError;
