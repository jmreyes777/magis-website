// Shared UAT fixtures: a fake-but-well-formed JWT factory and a full network
// mock for the admin SPA. The app never reaches a real backend — every /api/*
// call is answered here (host-agnostic, so it works whether the build baked
// localhost:5000 or the staging edge-worker URL), and third-party surfaces
// (Firebase, reCAPTCHA, socket.io) are blocked so pages must degrade the way
// they would during a real outage. Handlers mirror the REAL response shapes
// from backend/routes/branchAuth.js + routes/mfa.js.

const BRANCH = {
  id: "branch-1",
  email: "branch1@magis.test",
  name: "Test Branch",
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

// jwt-decode only parses the payload; no real signature needed.
const makeJwt = (payload = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      uid: "ba_e2e",
      branchId: BRANCH.id,
      email: BRANCH.email,
      branchName: BRANCH.name,
      role: "branchadmin",
      fallback: true,
      authVia: "branch_email_otp",
      jti: "jti-e2e",
      iat: now,
      exp: now + 240 * 60,
      ...payload,
    }),
    "e2e-fake-signature",
  ].join(".");
};

const OTP_GOOD = "123456";
const OTP_BAD = "000000";

/**
 * Install the network mock. Returns a `state` object the test can inspect
 * (recorded calls) and mutate (e.g. flip mfaVerified) mid-test.
 */
async function mockNetwork(page, opts = {}) {
  const state = {
    calls: [], // { method, path, postData } in arrival order
    mfaVerified: opts.mfaVerified ?? false,
    mfaEnrolled: opts.mfaEnrolled ?? true,
    mfaExpired: opts.mfaExpired ?? false,
    mustChangePassword: opts.mustChangePassword ?? false,
    rotationFails: opts.rotationFails ?? false,
    stepupRequestFails: opts.stepupRequestFails ?? false,
    loginRateLimited: opts.loginRateLimited ?? false,
  };

  // Third-party surfaces: fail FAST (fulfill errors, don't abort) so SDK retry
  // loops can't stall the page. Covers Firebase Auth/Firestore, reCAPTCHA,
  // fonts, analytics.
  await page.route(
    /(googleapis\.com|gstatic\.com|google\.com|firebaseio\.com|googletagmanager)/,
    (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "blocked by UAT fixture" })
  );
  await page.route("**/socket.io/**", (route) => route.abort());

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    let body = {};
    try {
      body = req.postDataJSON() || {};
    } catch {
      /* not JSON */
    }
    state.calls.push({ method, path, postData: body });

    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    // ── Login (password → emailed OTP) ────────────────────────────────────
    if (path === "/api/branch/login" && method === "POST") {
      if (state.loginRateLimited) {
        return json(429, { error: "Too many attempts. Please try again later." });
      }
      if (body.password === "wrong-password") {
        return json(401, { error: "Invalid email or password." });
      }
      if (body.password === "disabled-account") {
        return json(403, { error: "This account has been disabled. Contact your administrator." });
      }
      return json(200, {
        otpRequired: true,
        loginTicket: "ticket-e2e",
        email: body.email,
        emailSent: true,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    if (path === "/api/branch/login/verify-otp" && method === "POST") {
      if (body.code === OTP_BAD) {
        return json(401, { error: "Incorrect code.", attemptsLeft: 4 });
      }
      return json(200, {
        token: makeJwt(),
        branchName: BRANCH.name,
        mustChangePassword: state.mustChangePassword,
      });
    }
    if (path === "/api/branch/login/resend-otp" && method === "POST") {
      return json(200, { sent: true, emailSent: true });
    }
    if (path === "/api/branch/change-password" && method === "POST") {
      if ((body.newPassword || "").length < 10) {
        return json(400, { error: "New password must be at least 10 characters." });
      }
      state.mustChangePassword = false;
      return json(200, { success: true });
    }

    // ── MFA session gate (dashboard + modal poll this) ────────────────────
    if (path === "/api/mfa/session-status") {
      return json(200, {
        enrolled: state.mfaEnrolled,
        verified: state.mfaVerified,
        expired: state.mfaExpired && !state.mfaVerified,
        geoAnomaly: false,
        timeRemainingMinutes: state.mfaVerified ? 480 : 0,
      });
    }
    if (path === "/api/mfa/extend-session" && method === "POST") {
      return json(200, { success: true, timeRemainingMinutes: 480 });
    }
    if (path === "/api/mfa/status") {
      return json(200, { enrolled: state.mfaEnrolled, required: true });
    }

    // ── Branch email-OTP step-up (the flow under test) ────────────────────
    if (path === "/api/branch/stepup/request" && method === "POST") {
      if (state.stepupRequestFails) {
        return json(429, { error: "Please wait before requesting another code.", retryAfterSec: 60 });
      }
      return json(200, { sent: true, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    }
    if (path === "/api/branch/stepup/verify" && method === "POST") {
      if (body.code === OTP_GOOD) {
        state.mfaVerified = true;
        return json(200, { success: true, verified: true });
      }
      return json(401, { error: "Incorrect code.", attemptsLeft: 4 });
    }

    // Regression trap: a branch email-OTP account must NEVER hit the staff
    // step-up (staff !== branch account collections). 403 mirrors the backend.
    if (path.startsWith("/api/staff/stepup")) {
      return json(403, { error: "Not a staff account." });
    }

    // ── Session plumbing ──────────────────────────────────────────────────
    if (path === "/api/issue-fallback-token" && method === "POST") {
      if (state.rotationFails) return json(401, { error: "Authentication required." });
      return json(200, { token: makeJwt() });
    }
    if (path === "/api/branch/firebase-token" && method === "POST") {
      // Soft-fail path: dashboard must work without client-side Firestore.
      return json(503, { error: "unavailable in UAT" });
    }

    // Everything else the dashboard fires on mount (presence, chats REST,
    // logout, audit pings...) — benign empty success.
    return json(200, {});
  });

  return state;
}

/** Seed a logged-in branch email-OTP session directly into storage. */
async function seedBranchSession(page, { token } = {}) {
  const jwt = token || makeJwt();
  await page.addInitScript(
    ({ jwt, branch }) => {
      // Init scripts re-run on EVERY navigation; seed only once per context so
      // logout flows stay logged out (localStorage survives handleLogout's
      // selective clears, so this marker persists).
      if (localStorage.getItem("__uat_seeded__")) return;
      localStorage.setItem("__uat_seeded__", "1");
      const tabId = "tab-e2e-1";
      sessionStorage.setItem("branchAdminToken", jwt);
      sessionStorage.setItem("branchAdminRole", "branchadmin");
      sessionStorage.setItem("branchId", branch.id);
      sessionStorage.setItem("branchEmail", branch.email);
      sessionStorage.setItem("branchName", branch.name);
      sessionStorage.setItem("sessionTabId", "session-e2e-1");
      sessionStorage.setItem("mfaSessionId", "sess_e2e_1");
      localStorage.setItem("tabId", tabId);
      localStorage.setItem("activeSocketTabId", tabId);
      localStorage.setItem("branchAdminToken", jwt);
      localStorage.setItem("fallbackBranchEmail", branch.email);
      localStorage.setItem("fallbackBranchId", branch.id);
      localStorage.setItem("fallbackBranchRole", "branchadmin");
      localStorage.setItem("fallbackBranchName", branch.name);
    },
    { jwt, branch: BRANCH }
  );
  return jwt;
}

const callsTo = (state, pathPrefix) => state.calls.filter((c) => c.path.startsWith(pathPrefix));

module.exports = { BRANCH, OTP_GOOD, OTP_BAD, makeJwt, mockNetwork, seedBranchSession, callsTo };
