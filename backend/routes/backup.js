// backend/routes/backup.js
//
// BDR2 (backup & DR megaplan): backup trigger endpoint.
//
//   POST /api/backup/run — starts a full backup (scripts/firestore-backup.js)
//        in-process. Two callers, two auths (mirrors routes/obs.js):
//          - the edge worker's daily cron  → X-Obs-Auth: <OBS_SHARED_SECRET>
//          - a super-admin (pre-deploy safety snapshot) → superadmin JWT
//        Responds 202 immediately (a run takes ~2 min); the outcome lands in
//        the backups/status doc, the log stream, and Telegram:
//          success → "backup-heartbeat" one-liner (throttle-keyed per day)
//          failure → "backup-failed" alert (hourly throttle)
//        409 if a run is already in flight (the cron's KV guard makes doubles
//        unlikely; this is the in-process backstop).

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { runBackup } = require("../scripts/firestore-backup");
const { sendSecurityAlert } = require("../utils/securityAlerts");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");

const OBS_SECRET = process.env.OBS_SHARED_SECRET || process.env.EDGE_SHARED_SECRET || "";

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

let running = false;

function startRun(trigger) {
  running = true;
  const t0 = Date.now();
  runBackup()
    .then((s) => {
      console.log(JSON.stringify({ t: "backup", ok: true, trigger, ...s }));
      // Heartbeat key includes the date: one per day rides under the hourly
      // throttle; a manual re-run the same day is silently absorbed by it.
      sendSecurityAlert(
        `backup-heartbeat-${s.date}`,
        `✅ Backup ok · ${s.docs} docs · ${(s.gzBytes / 1024).toFixed(0)} KB gz`,
        [
          `snapshot: backups/firestore/${s.date}/`,
          `mirror: ${s.mirrorCopied}/${s.mirrorTotal} objects copied`,
          `retention: ${s.snapshotsKept} kept, ${s.snapshotsPruned} pruned`,
          `duration: ${(s.durationMs / 1000).toFixed(1)}s · trigger: ${trigger}`,
        ]
      );
    })
    .catch((e) => {
      console.error(JSON.stringify({ t: "backup", ok: false, trigger, error: e.message, durationMs: Date.now() - t0 }));
      sendSecurityAlert("backup-failed", "BACKUP FAILED", [
        `error: ${String(e.message).slice(0, 200)}`,
        `trigger: ${trigger}`,
        "action: run `node scripts/firestore-backup.js` on the backend locally and inspect",
      ]);
    })
    .finally(() => {
      running = false;
    });
}

router.post("/run", async (req, res) => {
  const viaWorker = OBS_SECRET && safeEqual(req.headers["x-obs-auth"] || "", OBS_SECRET);

  const begin = () => {
    if (running) return res.status(409).json({ error: "Backup already running" });
    startRun(viaWorker ? "cron" : "superadmin");
    return res.status(202).json({ started: true });
  };

  if (viaWorker) return begin();
  // Not the worker: require a super-admin JWT (manual pre-deploy snapshot).
  return authenticateSuperAdmin(req, res, begin);
});

module.exports = router;
