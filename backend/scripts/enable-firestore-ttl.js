/**
 * OBS7 (observability megaplan): enable Firestore TTL policies on `expireAt`
 * for the observability collections, via the Firestore Admin REST API.
 *
 * Exists because TTL policies are otherwise console-only clicks; this script
 * makes the step reproducible (same auth pattern as deploy-firestore-rules.js:
 * GOOGLE_APPLICATION_CREDENTIALS or ../firebase.json, no TTY login).
 *
 *   node backend/scripts/enable-firestore-ttl.js           # dry-run: show current state
 *   node backend/scripts/enable-firestore-ttl.js --apply   # enable missing policies
 *
 * Idempotent: fields already ACTIVE/CREATING are left untouched. Enabling is a
 * long-running server-side operation — state shows CREATING first, flips to
 * ACTIVE on its own (minutes to hours on large collections; these are new/small).
 * Deletion by TTL is best-effort (typically within 24h of expireAt) — exactly
 * what these telemetry collections need. auditLogs' TTL (already configured)
 * is not managed here on purpose: this script only ever touches the three
 * observability collections.
 */
const path = require("path");
const { GoogleAuth, JWT } = require("google-auth-library");
// Same env files utils/firebase.js consults — these are the credentials the
// running backend actually authenticates with (backend/firebase.json can rot).
require("dotenv").config({ path: path.resolve(__dirname, "../backend.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const PROJECT = process.env.FIREBASE_PROJECT || process.env.FIREBASE_PROJECT_ID || "magis-website";
const COLLECTIONS = ["clientErrors", "rumDaily", "obsIncidents"];
const FIELD = "expireAt";
const APPLY = process.argv.includes("--apply");
const SCOPES = ["https://www.googleapis.com/auth/datastore"];

async function getAuthClient() {
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    return new JWT({
      email: process.env.FIREBASE_CLIENT_EMAIL,
      key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: SCOPES,
    });
  }
  const keyFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, "../firebase.json");
  const auth = new GoogleAuth({ keyFile, scopes: SCOPES });
  return auth.getClient();
}

async function main() {
  const client = await getAuthClient();
  const { token } = await client.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups`;

  for (const cg of COLLECTIONS) {
    const fieldUrl = `${base}/${cg}/fields/${FIELD}`;

    const getRes = await fetch(fieldUrl, { headers });
    const field = await getRes.json();
    if (!getRes.ok) {
      console.error(`[${cg}] GET failed: HTTP ${getRes.status} ${JSON.stringify(field.error || field).slice(0, 200)}`);
      continue;
    }
    const state = field.ttlConfig?.state || "NONE";
    console.log(`[${cg}] ${FIELD} ttl state: ${state}`);

    if (state === "ACTIVE" || state === "CREATING") continue;
    if (!APPLY) {
      console.log(`[${cg}]   → would enable TTL (re-run with --apply)`);
      continue;
    }

    const patchRes = await fetch(`${fieldUrl}?updateMask=ttlConfig`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ttlConfig: {} }),
    });
    const out = await patchRes.json();
    if (patchRes.ok) {
      console.log(`[${cg}]   → TTL enable requested (operation: ${out.name || "?"})`);
    } else {
      console.error(`[${cg}]   → PATCH failed: HTTP ${patchRes.status} ${JSON.stringify(out.error || out).slice(0, 300)}`);
    }
  }
  console.log(APPLY ? "Done. States flip CREATING → ACTIVE server-side (check with a dry-run later)." : "Dry-run complete.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
