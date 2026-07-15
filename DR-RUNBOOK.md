# Disaster Recovery Runbook — Magis Pawnshop

BDR7 (backup & DR megaplan). Print one copy; keep it with the sealed secrets
envelope. Every command below is real and was executed at least once during
drills — nothing here is aspirational.

## What exists, where

| Asset | Primary | Backup |
| --- | --- | --- |
| Code (backend, 2 frontends, worker) | GitHub `jmreyes777/magis-website` | any dev clone; GitHub recovery codes (see Secrets) |
| Firestore data | Firebase project | `backups/firestore/YYYY-MM-DD/` in the project bucket (30 daily + 8 weekly) **and** `C:\magis-backups\firestore\` off-cloud |
| Storage media (`media/…`, 12.6 MB) | project bucket | `backups/storage-objects/` mirror **and** `C:\magis-backups\storage-objects\` |
| Backend env (secrets) | Render dashboard → magis-website → Environment | key-NAME+hash inventory inside every snapshot `manifest.json` (`envInventory`); values in password manager |
| Worker bindings | Cloudflare (magis-edge-worker-staging) | `magis-edge-worker/.env` (local) + `deploy-api.mjs` re-creates all bindings |
| MongoDB (legacy auth data) | Atlas (managed daily snapshots) | Atlas built-in retention |

Daily automated backup: edge worker cron fires `POST /api/backup/run` at
~03:00 Asia/Manila → Telegram heartbeat "✅ Backup ok · N docs" on success,
"🚨 BACKUP FAILED" on failure. **No heartbeat by 04:00 = investigate that day.**
Dashboard: admin `/observability` → Backups card (red when stale > 26 h).

## Secrets (BDR6)

Two root secrets exist. Losing BOTH of these AND Render access is the only
unrecoverable state — prevent it:

1. **Firebase service-account key** (`FIREBASE_PRIVATE_KEY` + client email):
   Render env; local `backend/backend.env`. Regenerate: Firebase console →
   Project settings → Service accounts → Generate new private key.
2. **Telegram bot token** (`ALERT_TELEGRAM_BOT_TOKEN`): Render env + worker
   binding. Regenerate via @BotFather `/revoke`.

Keep in the password manager: Render login, Cloudflare login, Firebase/Google
login, GitHub login + **printed 2FA recovery codes**, both secrets above,
`EDGE_SHARED_SECRET`. The per-snapshot `envInventory` (names + sha256:8 of
values) tells you WHICH keys a rebuilt environment still misses — compare
hashes to detect silently drifted values.

## Scenarios

### (a) Accidental collection wipe/damage (e.g. `branches` emptied)
```powershell
cd C:\Users\jmrey\magis-website-new\backend
node scripts\firestore-restore.js --list                         # pick date
node scripts\firestore-restore.js --date 2026-07-15 --collections branches   # dry-run first
node scripts\firestore-restore.js --apply --in-place --collections branches --date 2026-07-15 --yes-i-know
```
Restore is additive-overwrite (never deletes extra docs). Verify in the admin
app; check counts against the dry-run output.

### (b) Subtle corruption found late (need point-in-time data)
Restore the last-good snapshot into a parallel prefix and compare before
touching live data:
```powershell
node scripts\firestore-restore.js --apply --into-prefix inspect_ --date <last-good> --collections <col>
# examine inspect_<col> in the Firebase console, then copy what you need or
# run the in-place restore from that date; clean up inspect_* when done.
```

### (c) Firebase project lost entirely
1. Create new Firebase project + Firestore + Storage; generate a service-account key.
2. Point `backend/backend.env` at the new project (PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY, STORAGE_BUCKET).
3. Upload the off-cloud snapshot into the new bucket (the restore tool reads
   from the bucket, not from disk):
   `gsutil -m cp -r C:\magis-backups\firestore gs://<new-bucket>/backups/firestore` (or console drag-drop the dated folder).
4. `node scripts\firestore-restore.js --list` (proves the new project sees the snapshot), dry-run, then per-collection `--in-place` restores.
5. Media: upload `C:\magis-backups\storage-objects\media` back to `media/` in the new bucket.
6. Re-enable Firestore TTL policies (`node scripts\enable-firestore-ttl.js --apply`), re-create composite indexes on first query error, update Render env, redeploy.

### (d) Render service lost
Blueprint = repo. New Render web service from GitHub → set env vars from the
password manager (compare against the latest snapshot's `envInventory` list) →
deploy → update `BACKEND_URL` in `magis-edge-worker/.env` → `node deploy-api.mjs`.

### (e) Cloudflare worker lost
```powershell
cd C:\Users\jmrey\magis-website-new\magis-edge-worker
node deploy-api.mjs     # recreates worker, secrets, KV binding, cron
```

### (f) This PC lost
Everything above lives in GitHub + Render + Cloudflare + Firebase + the
password manager. Re-clone, restore `backend/backend.env` and
`magis-edge-worker/.env` from the password manager, re-run the weekly pull
(below) to rebuild `C:\magis-backups`.

## Off-cloud pull (BDR5)

```powershell
cd C:\Users\jmrey\magis-website-new\backend
node scripts\backup-pull.js          # newest 7 snapshots + media, hash-verified
```
Weekly schedule: Task Scheduler → Create Basic Task → "magis backup pull" →
Weekly, Sunday 09:00 → Start a program → Program `node`, Arguments
`scripts\backup-pull.js`, Start in `C:\Users\jmrey\magis-website-new\backend`.
Failure shows as non-zero Last Run Result; the pull also self-repairs any
locally corrupted file (verified in drill, see log).

## Drill calendar

Quarterly (Jan/Apr/Jul/Oct, first week): run
```powershell
node scripts\firestore-restore.js --drill
node scripts\backup-pull.js
```
Both must print PASS/ok. Record below. ~5 minutes total.

| Date | Drill | Result |
| --- | --- | --- |
| 2026-07-15 | restore `--drill` (full) | PASS · 3689/3689 docs · spot-check 60/60 · sha 19/19 · cleanup ok |
| 2026-07-15 | pull + tamper-repair | ok · corrupted file detected & re-downloaded · 185 media intact |
| 2026-10-xx | (next quarterly) | |

## Production-cutover stretch items

- Enable native Firestore scheduled backups (managed second layer) once billing
  allows: `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=7d`.
- Flip the post-deploy verify workflow to push-trigger.
- Move the off-cloud pull to a second machine (owner's home PC) for true 3-2-1.
