# SEC26 — Fail-Mode Inventory & Operator Checklist

Every degradable security control, what it does when its dependency is gone,
whether that direction is deliberate, and the lever that changes it.
Rule (A10, Mishandling of Exceptional Conditions): **a control may fail open
only if the degradation is loud** (alert + log) — silent inertness is the bug
class this doc exists to prevent.

_Last updated: SEC26 Wave 2._

## Inventory

| Control | Degrades when | Direction | Deliberate? | Loud? | Lever |
|---|---|---|---|---|---|
| Guest message quota (REST+socket shared bucket) | Redis down | **Open** | Yes — chat availability > strictness | ✅ `redis-degraded` alert + 60s-throttled log | `REQUIRE_REDIS=true` (boot-fail instead) |
| Login brute-force limiter | Redis down | **Open-ish** — falls to per-instance in-memory store | Yes — still slows single-instance attacks | ✅ same alert | `REQUIRE_REDIS=true` |
| JWT revocation (logout/force-close) | Redis down | **Open-ish** — worker-local revocation only | Yes — logout still works per-instance | ✅ same alert | `REQUIRE_REDIS=true` |
| Hot-read limits (media/history/conv-key, SEC26 W0) | Redis down | **Open-ish** — in-memory per-instance store | Yes — same family as login limiter | ✅ same alert | `HOT_READ_RL_MAX/WINDOW_MS` tune; `REQUIRE_REDIS` |
| `requireMFA` (SPI screens) | Transient Firestore error in the check | **Open by default** (only inside `catch`) | Interim — flip pending | ✅ warn log | **`MFA_FAIL_OPEN=false`** ← operator flip below |
| Edge lock (`requireEdgeAuth`) | `EDGE_SHARED_SECRET` unset | **Monitor** (logs, allows) | Yes — staged enforcement | ✅ logs | Set secret + `EDGE_AUTH_MODE=enforce` |
| CSRF double-submit (SEC26 W0) | `CSRF_ENFORCE` unset | **Monitor** (logs would-blocks) | Yes — staged enforcement | ✅ `[CSRF] monitor:` logs | **`CSRF_ENFORCE=true`** ← flip after 1-week clean monitor |
| Staff web push | VAPID env unset | **Closed** (503 + hidden UI) | Yes — feature simply off | ✅ boot log | Set `VAPID_*` |
| JSON body ceiling (SEC26 W2) | n/a (always on) | **Closed** (413) | Yes | n/a | `JSON_BODY_LIMIT` (default 200kb) |
| Superadmin allowlist (SEC26 W0) | `SUPERADMIN_EMAILS` unset in prod/staging | **Closed** — boot refuses | Yes — no default principals (CISA SbD) | ✅ boot error | Set the env var |
| Redis presence itself | `REDIS_URL` unset in prod | **Open + banner** | Yes — availability default | ✅ boot banner + alert | `REQUIRE_REDIS=true` |
| 5xx spike / backend exception paging | alert channel down | Best-effort, never blocks requests | Yes | self-throttled | n/a |

## Operator checklist (SEC26 Wave 0 — dashboard/console actions)

Code can't flip these; they are environment/console operations. Tick in order.

1. **`SUPERADMIN_EMAILS`** — set on Render (comma-separated) **before** deploying
   SEC26 Wave 0: the hardcoded legacy default is gone and prod boot now fails
   without it.
2. **`MFA_FAIL_OPEN=false`** — flip on Render after confirming in staging that a
   forced Firestore hiccup produces the warn log + a clean 503 (not a lockout).
3. **`branchAdmins` password-hash purge** — run the script from
   `SECURITY-REMEDIATION-PLAN.md` (P-item) against prod **after** a
   `BACKUP-DR-MEGAPLAN.md` backup; verify with the read-only count query it
   prints.
4. **`CSRF_ENFORCE=true`** — after ≥1 week with zero legitimate
   `[CSRF] monitor:` lines in Render logs (the admin/guest SPAs send the header
   already; monitor exists to catch stragglers).
5. **GitHub secret scanning + push protection** — repo Settings → Code security:
   confirm both toggles are ON (they are org/repo settings, not code).
6. **`REQUIRE_REDIS=true`** — optional hardening once Redis has been stable ≥30
   days; converts silent limiter degradation into a loud boot failure.

## Post-quantum (PQC) posture — verified statement

- **Client→edge TLS** terminates at **Cloudflare**, which negotiates hybrid
  **X25519 + ML-KEM-768** key agreement by default for TLS 1.3 — guest and
  admin browsers already get quantum-resistant key exchange with zero app-layer
  work. Verify anytime: `curl -sv https://<site> 2>&1 | grep -i "kex\|group"`
  or the Cloudflare dashboard (SSL/TLS → Edge Certificates).
- **Edge→origin (Render)** uses classical TLS today; harvest-now-decrypt-later
  exposure is limited to intra-provider transit of already-E2EE-wrapped chat
  payloads. No app action available until Render exposes PQC origin pulls.
- **Signatures/certificates** (ML-DSA/SLH-DSA migration): ecosystem-blocked;
  nothing actionable at the application layer in 2026.
- **DoS note**: the research's PQC handshake-exhaustion amplification applies
  to TLS terminators, not this origin (Cloudflare absorbs it). The analogous
  origin hot path — worker-pool JWT verification — already has explicit
  backpressure (`EWORKERBUSY` → 503) and is load-tested in Wave 4
  (`backend/perf/`).
- **Revisit**: 2027-Q1, or when Render/Cloudflare announce PQC origin-pull /
  PQC certificates.

## N/A pillars (research → this stack)

- **eBPF/kernel telemetry**: Render PaaS, no kernel access. Compensating
  controls: Cloudflare WAF + edge worker (`magis-edge-worker/`), OBS1/OBS2
  alerting, append-only `auditLog`.
- **MCP / LLM guardrails**: no LLM or agent integration exists in the product.
  If AI chat-assist is ever added, start from OWASP LLM Top-10 (prompt
  injection, excessive agency) and this doc's staged-enforcement pattern.
- **Memory-safe language migration**: JS/Node throughout; no authored native code.
