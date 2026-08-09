#!/usr/bin/env node
/**
 * passkey-adoption.js — SEC26 Wave 5 adoption metric (READ-ONLY).
 *
 * Prints per-branch passkey enrollment so the nudge campaign's effect is
 * measurable: which branch admin accounts have ≥1 active passkey, which have
 * none, and the overall adoption percentage. No writes, no token material —
 * emails only (operator-facing report).
 *
 * Usage (from the repo root, same credentials the backend runs on):
 *   node backend/scripts/passkey-adoption.js
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "backend.env") });

const { db } = require("../utils/firebase");

async function main() {
  // Active (non-disabled) passkeys, grouped by account email.
  const credSnap = await db
    .collection("webauthnCredentials")
    .where("disabled", "==", false)
    .get();
  const byEmail = new Map();
  credSnap.forEach((d) => {
    const c = d.data();
    const email = String(c.email || "").toLowerCase();
    if (!email) return;
    const cur = byEmail.get(email) || { count: 0, lastUsedAt: null };
    cur.count += 1;
    if (c.lastUsedAt && (!cur.lastUsedAt || c.lastUsedAt > cur.lastUsedAt)) {
      cur.lastUsedAt = c.lastUsedAt;
    }
    byEmail.set(email, cur);
  });

  // All branch admin accounts (the population the nudge targets).
  const adminSnap = await db.collection("branchAdmins").get();
  const rows = [];
  adminSnap.forEach((d) => {
    const a = d.data();
    const email = String(a.email || d.id || "").toLowerCase();
    const entry = byEmail.get(email);
    rows.push({
      email,
      passkeys: entry ? entry.count : 0,
      lastPasskeyUse: entry?.lastUsedAt || "—",
    });
  });
  rows.sort((x, y) => y.passkeys - x.passkeys || x.email.localeCompare(y.email));

  const enrolled = rows.filter((r) => r.passkeys > 0).length;
  const pct = rows.length ? Math.round((enrolled / rows.length) * 100) : 0;

  console.log("\nPasskey adoption — branch admin accounts");
  console.log("=".repeat(60));
  for (const r of rows) {
    const mark = r.passkeys > 0 ? "✅" : "▫️";
    console.log(
      `${mark} ${r.email.padEnd(38)} ${String(r.passkeys).padStart(2)} passkey(s)  last-used: ${r.lastPasskeyUse}`
    );
  }
  console.log("=".repeat(60));
  console.log(`Adoption: ${enrolled}/${rows.length} accounts (${pct}%)`);
  if (byEmail.size > rows.length) {
    const orphans = [...byEmail.keys()].filter(
      (e) => !rows.some((r) => r.email === e)
    );
    if (orphans.length) {
      console.log(
        `\n⚠️ ${orphans.length} credential email(s) with no matching branchAdmins doc (stale accounts?):`
      );
      for (const o of orphans) console.log(`   - ${o}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("passkey-adoption failed:", e.message);
    process.exit(1);
  });
