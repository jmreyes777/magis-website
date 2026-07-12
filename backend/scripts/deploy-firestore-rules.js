/**
 * Deploy ../../firestore.rules to production via the Firebase Rules REST API.
 *
 * Exists because `firebase deploy` requires an interactive login session,
 * while this script authenticates with the service-account key directly
 * (GOOGLE_APPLICATION_CREDENTIALS or ../firebase.json) — usable from any
 * shell/CI without TTY prompts.
 *
 *   node backend/scripts/deploy-firestore-rules.js           # dry-run (test only)
 *   node backend/scripts/deploy-firestore-rules.js --apply   # create ruleset + release
 *
 * Safety: --apply first runs the API-side syntax test; a release is only
 * repointed when the ruleset compiles clean. Previous rulesets are retained
 * by Firebase (instant rollback via console → Rules → History).
 */
const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const PROJECT = process.env.FIREBASE_PROJECT || "magis-website";
const RULES_PATH = path.resolve(__dirname, "../../firestore.rules");
const APPLY = process.argv.includes("--apply");

async function main() {
  const keyFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, "../firebase.json");
  const auth = new GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/firebase"],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const BASE = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;

  const content = fs.readFileSync(RULES_PATH, "utf8");
  const source = { files: [{ name: "firestore.rules", content }] };

  // 1) Server-side syntax/compile test
  const test = await fetch(`${BASE}:test`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ source }),
  }).then((r) => r.json());
  const issues = (test.issues || []).filter((i) => i.severity !== "WARNING");
  if (issues.length) {
    console.error("❌ rules failed server-side compile:", JSON.stringify(issues, null, 2));
    process.exit(1);
  }
  console.log("✅ server-side compile clean" + (test.issues?.length ? ` (${test.issues.length} warnings)` : ""));

  if (!APPLY) {
    console.log("dry-run complete — rerun with --apply to release");
    return;
  }

  // 2) Create the ruleset
  const ruleset = await fetch(`${BASE}/rulesets`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ source }),
  }).then((r) => r.json());
  if (!ruleset.name) {
    console.error("❌ ruleset create failed:", JSON.stringify(ruleset));
    process.exit(1);
  }
  console.log("📦 ruleset created:", ruleset.name);

  // 3) Point the cloud.firestore release at it (PATCH updates, POST creates)
  const releaseName = `projects/${PROJECT}/releases/cloud.firestore`;
  let release = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ release: { name: releaseName, rulesetName: ruleset.name } }),
  }).then((r) => r.json());
  if (release.error && release.error.code === 404) {
    release = await fetch(`${BASE}/releases`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: releaseName, rulesetName: ruleset.name }),
    }).then((r) => r.json());
  }
  if (release.error) {
    console.error("❌ release failed:", JSON.stringify(release.error));
    process.exit(1);
  }
  console.log("🚀 LIVE — cloud.firestore now serves", ruleset.name);
}

main().catch((e) => {
  console.error("deploy failed:", e.message || e);
  process.exit(1);
});
