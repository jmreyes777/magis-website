# SEC26 Wave 6 — Incident Response & NPC Notification Runbook

Single-operator playbook for a suspected personal-data breach. Written to be
executed under stress: every step is a concrete command or console click.

## Legal clock (Philippines)

- **RA 10173 §20 + NPC Circular 16-03**: notify the **NPC and affected data
  subjects within 72 hours** of *knowledge of / reasonable belief in* a breach
  involving sensitive personal information that is likely to cause real harm.
- The NPC accepts an **initial report with incomplete details** — file early
  with what you have, supplement later. Missing the clock is itself a finding.
- NPC portal: <https://privacy.gov.ph> → Data Breach Notification Management
  System (DBNMS). Keep the DPO registration credentials in the password
  manager under `NPC-DBNMS`.
- **NPC Advisory 2026-02 tightened the procedure** (three rules that changed
  older practice):
  1. **No mutually exclusive DBNMS requests.** An *exemption* from notifying
     data subjects asserts there is no duty to notify; a *postponement* or
     *alternative means of notification* concedes the duty exists. Filing both
     at once risks the NPC **denying all of them** — pick ONE posture before
     filing (decision point in step 9).
  2. **The full-report window is unconditional.** It keeps running regardless
     of any pending request or appeal in the system — never wait on a ruling
     to file.
  3. **Silence is not approval.** Any relief (exemption/postponement) is only
     effective when the NPC issues it **expressly, in writing**. Until that
     document exists, operate as if the request was denied.

## Hour 0–2: Contain

1. **Freeze the suspected account(s)** (branch admin compromise is the likely
   case):
   - Render env: rotate `JWT_SECRET`/pool secrets → every issued token dies.
     (Users re-login; acceptable during an incident.)
   - Or per-account: Super-admin dashboard → Branch Passwords → reset the
     account password + reset its MFA (`/api/branch/admin/reset-mfa` flow).
2. **Revoke sessions**: logout is revocation-backed (Redis JTI) — rotating the
   secret (step 1) is the stronger, cluster-wide kill.
3. **Preserve evidence — do NOT delete anything**:
   - `auditLogs` is append-only with a tamper-evident chain for
     auth/security/admin. Verify integrity now so the filing can assert it:
     `node backend/scripts/verify-audit-chain.js`
   - Snapshot: run a backup now (`POST /api/backup/run` with the obs key, or
     the BDR runbook path) so the incident-time state is frozen.
4. **If the vector is unknown**, set `EDGE_AUTH_MODE=enforce` (if not already)
   and consider Cloudflare "Under Attack" mode — both are reversible.

## Hour 2–24: Scope

5. **Quantify from the audit log** (read-only):
   ```bash
   node backend/scripts/incident-scope.js \
     --from <incident-start-ISO> --to <containment-ISO> \
     [--actor <suspected-account>] [--branch <branch-email>] \
     --json incident-$(date +%Y%m%d).json
   ```
   Output = affected guest population, exposure actions, actor IPs, auth
   timeline. This is the factual core of the DBNMS filing.
6. **Determine data classes** via the PII inventory below — what a guest
   conversation *can* contain decides whether the SPI threshold is met.
7. **Check the E2EE boundary**: chat content is encrypted at rest; content
   exposure requires conversation-key access. `incident-scope.js` timeline +
   `security.conv_key.*` audit events show whether keys were touched. If keys
   were NOT in scope, the filing can argue content confidentiality held
   (metadata still counts — assess honestly).
8. **Cross-check provider logs** (app-layer audit can't see direct DB access):
   - Firebase console → Firestore usage/access patterns
   - Render logs (the `"t":"berr"` and `[AUTH]` lines around the window)
   - Cloudflare security events for the edge view

## Hour 24–72: Notify

9. **File the DBNMS initial report.** Sections map directly:
   - *Nature of the breach* → incident-scope timeline + vector
   - *Personal data involved* → PII inventory rows for affected classes
   - *Number of affected data subjects* → `TOTAL affected guests`
   - *Measures taken* → containment steps 1–4 with timestamps
   - **Incompatible-filings rule**: the DBNMS rejects amendments that
     contradict the initial filing's category selections — keep category
     choices broad on the initial report; narrow in the full report.
   - **Advisory 2026-02 decision point — choose ONE, before filing:**
     (a) notify data subjects normally (default; steps 10–11), or
     (b) request exemption (only if NO real risk of harm — rare here given
     the PII inventory), or (c) request postponement/alternative means (e.g.
     no reachable contact details). Requesting (b) and (c) together risks
     denial of both. Document the choice + rationale in the incident folder.
10. **Notify affected data subjects** (email where the guest provided one;
    the contact-relay records carry it). Template: what happened, what data,
    when, what we did, what they should do, DPO contact. Plain language.
11. **Log everything you did** in the incident folder (`incident-<date>/`):
    scope JSON, filing PDF, notice copies, timestamps. File the **full report
    within 5 days** — per Advisory 2026-02 this window is unconditional and
    keeps running even while an exemption/postponement request is pending;
    only an express written NPC approval changes anything.

## Post-incident (week 1–2)

- Root-cause entry in `SECURITY-FAILMODES.md` if a fail-mode contributed.
- Add a regression test pinning the fixed behavior (Wave 1 suite style).
- Rotate any secret that *could* have been visible, not just proven ones.
- Review whether `CSRF_ENFORCE` / `MFA_FAIL_OPEN` / `REQUIRE_REDIS` staged
  flips should be accelerated.

## PII inventory (what this system holds, where)

| Data class | Where | SPI? | Notes |
|---|---|---|---|
| Guest name / alias | `guests`, chat messages | Possible | guest-supplied free text |
| Contact email / phone | contact relay, `guests` | Yes (identifiable) | used for transcript + notices |
| Chat content | `messages` (E2EE at rest) | **Potentially sensitive** — loan/valuables context | exposure requires conv-key access |
| Item / valuation details | chat content, gold inquiries | Financial-adjacent | part of pawn negotiation |
| IP + geo hints | `auditLogs.context`, edge logs | Quasi-identifier | retention per audit TTL |
| Admin identities | `branchAdmins`, `staff` | Employee data | hashes purged per P-item |
| Passkey credential metadata | `webauthnCredentials` | No secrets (public keys only) | device names may identify |
| Audit trail | `auditLogs` | Meta-PII | append-only, chained, TTL'd |

## Contacts

- **DPO / operator**: (fill in — name, phone, email)
- **NPC**: complaints@privacy.gov.ph / DBNMS portal
- **Render support**: dashboard ticket (infra-side evidence)
- **Cloudflare**: dashboard → support (edge logs beyond retention)
