/**
 * Verify the tamper-evident audit chain (megaplan Phase 4).
 *
 *   node backend/scripts/verify-audit-chain.js
 *
 * Walks every chained audit event (security/auth/admin categories) in
 * sequence order, recomputes each hash and reports gaps, prevHash mismatches
 * and altered records. Read-only; needs backend Firebase credentials
 * (backend/backend.env or GOOGLE_APPLICATION_CREDENTIALS), same as the server.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../backend.env") });

const { verifyAuditChain } = require("../utils/auditLog");

(async () => {
  const started = Date.now();
  const { ok, checked, breaks } = await verifyAuditChain();
  console.log(`checked ${checked} chained events in ${Date.now() - started}ms`);
  if (ok) {
    console.log("✅ audit chain INTACT");
    process.exit(0);
  }
  console.error(`❌ audit chain BROKEN — ${breaks.length} problem(s):`);
  for (const b of breaks.slice(0, 20)) {
    console.error(`  seq=${b.seq} doc=${b.id}: ${b.reason}`);
  }
  if (breaks.length > 20) console.error(`  … and ${breaks.length - 20} more`);
  process.exit(1);
})().catch((e) => {
  console.error("verify failed:", e?.message || e);
  process.exit(1);
});
