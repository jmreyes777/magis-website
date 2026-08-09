#!/usr/bin/env node
/**
 * incident-scope.js — SEC26 Wave 6: incident impact scoping (READ-ONLY).
 *
 * Supports the NPC notification duty (RA 10173 §20, NPC Circular 16-03):
 * within the 72-hour clock the operator must determine who is affected and
 * which data classes were involved. This tool answers that from the
 * append-only auditLogs collection for a given time window (optionally
 * narrowed to one account or branch): which conversations were viewed or
 * exported, which guests are in the affected population, plus the auth
 * timeline and source IPs for the incident narrative.
 *
 * Usage (repo root, backend credentials):
 *   node backend/scripts/incident-scope.js --from 2026-08-01T00:00:00Z --to 2026-08-08T00:00:00Z
 *   node backend/scripts/incident-scope.js --from ... --to ... --actor admin@branch.com
 *   node backend/scripts/incident-scope.js --from ... --to ... --branch branch@x.com --json report.json
 *
 * READ-ONLY by construction: only .get() queries, no writes. The optional
 * --json report contains guest IDs and emails — treat it as SPI: store it in
 * the incident folder, delete after the filing.
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", "backend.env") });

const { db } = require("../utils/firebase");

const COLLECTION = process.env.AUDIT_COLLECTION || "auditLogs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const fromISO = arg("from");
const toISO = arg("to");
const actorFilter = (arg("actor") || "").toLowerCase() || null;
const branchFilter = (arg("branch") || "").toLowerCase() || null;
const jsonOut = arg("json");

if (!fromISO || !toISO || isNaN(Date.parse(fromISO)) || isNaN(Date.parse(toISO))) {
  console.error(
    "Usage: node backend/scripts/incident-scope.js --from <ISO> --to <ISO> [--actor <email>] [--branch <email>] [--json <file>]"
  );
  process.exit(1);
}
const fromMs = Date.parse(fromISO);
const toMs = Date.parse(toISO);

// Data-access actions define the affected population; auth/security actions
// provide the timeline of how access happened.
const EXPOSURE_ACTIONS = new Set([
  "access.conversation.viewed",
  "access.transcript.exported",
  "access.analytics.viewed",
  "access.audit.viewed",
  "access.audit.exported",
  "chat.transcript.requested",
  "chat.transcript.emailed",
]);
const TIMELINE_CATEGORIES = new Set(["auth", "security", "admin"]);

async function main() {
  console.log(`# incident-scope: ${fromISO} → ${toISO}`);
  if (actorFilter) console.log(`# actor filter: ${actorFilter}`);
  if (branchFilter) console.log(`# branch filter: ${branchFilter}`);

  let q = db
    .collection(COLLECTION)
    .where("tsMs", ">=", fromMs)
    .where("tsMs", "<=", toMs)
    .orderBy("tsMs", "asc");
  if (branchFilter) q = q.where("branchEmail", "==", branchFilter);

  const snap = await q.get();
  console.log(`# events in window: ${snap.size}\n`);

  const affectedGuests = new Map(); // guestId → { firstMs, lastMs, actions:Set, actors:Set }
  const actionCounts = {};
  const actorIPs = new Map(); // actorEmail → Set(ip)
  const timeline = [];

  snap.forEach((d) => {
    const e = d.data();
    const actorEmail = (e.actor?.email || e.actor?.id || e.actor?.type || "?").toLowerCase();
    if (actorFilter && actorEmail !== actorFilter) return;

    actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
    if (e.context?.ip) {
      if (!actorIPs.has(actorEmail)) actorIPs.set(actorEmail, new Set());
      actorIPs.get(actorEmail).add(e.context.ip);
    }

    if (EXPOSURE_ACTIONS.has(e.action)) {
      const gid = e.target?.guestId || e.target?.id || null;
      if (gid) {
        const cur =
          affectedGuests.get(gid) ||
          { firstMs: e.tsMs, lastMs: e.tsMs, actions: new Set(), actors: new Set() };
        cur.firstMs = Math.min(cur.firstMs, e.tsMs);
        cur.lastMs = Math.max(cur.lastMs, e.tsMs);
        cur.actions.add(e.action);
        cur.actors.add(actorEmail);
        affectedGuests.set(gid, cur);
      }
    }

    if (TIMELINE_CATEGORIES.has(e.category)) {
      timeline.push({
        ts: e.ts,
        action: e.action,
        outcome: e.outcome,
        actor: actorEmail,
        ip: e.context?.ip || null,
        branch: e.branchEmail || null,
      });
    }
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log("## Affected data subjects (exposure actions)");
  if (affectedGuests.size === 0) {
    console.log("(none in window — if the incident involved direct DB access,");
    console.log(" audit logs of app-layer reads will not capture it; scope from");
    console.log(" provider access logs instead.)");
  } else {
    for (const [gid, v] of affectedGuests) {
      console.log(
        `- ${gid}  first=${new Date(v.firstMs).toISOString()}  last=${new Date(v.lastMs).toISOString()}`
      );
      console.log(`    actions: ${[...v.actions].join(", ")}`);
      console.log(`    actors:  ${[...v.actors].join(", ")}`);
    }
  }
  console.log(`\nTOTAL affected guests: ${affectedGuests.size}`);

  console.log("\n## Action histogram (window)");
  for (const [a, n] of Object.entries(actionCounts).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(5)}  ${a}`);
  }

  console.log("\n## Actor source IPs");
  for (const [a, ips] of actorIPs) {
    console.log(`  ${a}: ${[...ips].join(", ")}`);
  }

  console.log("\n## Auth/security/admin timeline");
  for (const t of timeline) {
    console.log(
      `  ${t.ts}  ${t.action} [${t.outcome}] actor=${t.actor} ip=${t.ip || "-"} branch=${t.branch || "-"}`
    );
  }

  console.log("\n## Data classes per affected conversation (PII inventory)");
  console.log("  See SECURITY-INCIDENT-RUNBOOK.md → 'PII inventory': chat may");
  console.log("  contain name, contact details, item/loan descriptions (E2EE at");
  console.log("  rest — exposure depends on whether conversation keys were in scope).");

  if (jsonOut) {
    const report = {
      window: { from: fromISO, to: toISO },
      filters: { actor: actorFilter, branch: branchFilter },
      affectedGuests: [...affectedGuests].map(([gid, v]) => ({
        guestId: gid,
        first: new Date(v.firstMs).toISOString(),
        last: new Date(v.lastMs).toISOString(),
        actions: [...v.actions],
        actors: [...v.actors],
      })),
      actionCounts,
      actorIPs: [...actorIPs].map(([a, ips]) => ({ actor: a, ips: [...ips] })),
      timeline,
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`\nJSON report → ${jsonOut} (contains SPI — delete after filing)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("incident-scope failed:", e.message);
    process.exit(1);
  });
