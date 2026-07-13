// cutover.mjs — Phase 3.5 domain cutover (BRANCH-GBP-LINKS-PLAN.md).
// One-button attach of magispawnshop.com to the edge worker once the operator
// has (a) added the zone to this Cloudflare account and (b) pointed the
// nameservers at Cloudflare from the Squarespace domain panel.
//
// Usage:
//   node cutover.mjs           # dry run — reports zone status + what WOULD change
//   node cutover.mjs --apply   # actually create DNS records + worker routes
//
// Idempotent: existing records/routes are detected and skipped, so re-running
// is always safe. Requires the CF_API_TOKEN in ./.env to carry ZONE-level
// permissions for the magispawnshop.com zone: Zone:Read, DNS:Edit,
// Workers Routes:Edit (Account > Workers Scripts alone is NOT enough — the
// script tells you exactly this if it hits a 403).
import fs from "node:fs";

const ACCOUNT = "8cf3c3e9847d67196d92e0e315a14b9f";
const SCRIPT = "magis-edge-worker-staging"; // worker script serving the site
const ZONE_NAME = "magispawnshop.com";
const APPLY = process.argv.includes("--apply");

// Same token resolution as deploy-api.mjs: .env first, shell fallback.
let TOKEN = "";
try {
  const envText = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  const m = envText.match(/^\s*CF_API_TOKEN\s*=\s*(.+?)\s*$/m);
  if (m) TOKEN = m[1].replace(/^["']|["']$/g, "").trim();
} catch {}
if (!TOKEN) TOKEN = (process.env.CF_API_TOKEN || "").trim();
if (!TOKEN) {
  console.error("Missing CF_API_TOKEN (set it in magis-edge-worker/.env or the shell)");
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403) {
    console.error(
      `403 on ${method} ${path} — the CF_API_TOKEN lacks zone permissions.\n` +
        `Edit the token (dash.cloudflare.com → My Profile → API Tokens) and add, scoped to ${ZONE_NAME}:\n` +
        `  Zone : Zone : Read\n  Zone : DNS : Edit\n  Zone : Workers Routes : Edit`
    );
    process.exit(1);
  }
  return { status: res.status, ok: json.success === true, result: json.result, errors: json.errors };
};

async function main() {
// ---------- 1) Zone present + active? ----------
const zones = await api("GET", `/zones?name=${ZONE_NAME}`);
const zone = zones.result?.[0];
if (!zone) {
  console.log(
    `Zone ${ZONE_NAME} is NOT on this Cloudflare account yet.\n\nOperator steps (once):\n` +
      `  1. dash.cloudflare.com → Add a domain → ${ZONE_NAME} (Free plan) → Cloudflare shows two nameservers.\n` +
      `  2. Squarespace → Settings → Domains → ${ZONE_NAME} → Nameservers → replace with those two.\n` +
      `  3. Wait for the zone to show "Active" (minutes–24h), then re-run this script.`
  );
  return;
}
console.log(`Zone found: ${zone.id} status=${zone.status}`);
if (zone.status !== "active") {
  console.log(
    `Zone is pending nameserver activation. Point the Squarespace nameservers at:\n` +
      `  ${zone.name_servers?.join("\n  ") || "(shown in the CF dashboard)"}\n` +
      `Re-run this script once the zone is Active.`
  );
  return;
}

// ---------- 2) DNS records (proxied placeholders — the worker answers) ----------
// AAAA 100:: is the standard "worker-only hostname" pattern: a discard-prefix
// address that never receives traffic because the orange-cloud proxy + worker
// route intercept every request.
const wantRecords = [
  { type: "AAAA", name: ZONE_NAME, content: "100::", proxied: true },
  { type: "AAAA", name: `www.${ZONE_NAME}`, content: "100::", proxied: true },
];
const existing = await api("GET", `/zones/${zone.id}/dns_records?per_page=100`);
for (const want of wantRecords) {
  const hit = (existing.result || []).find(
    (r) => r.name === want.name && ["A", "AAAA", "CNAME"].includes(r.type)
  );
  if (hit) {
    console.log(`DNS ok: ${hit.type} ${hit.name} → ${hit.content} (proxied=${hit.proxied}) — leaving as-is`);
    if (!hit.proxied) console.warn(`  ⚠ ${hit.name} is NOT proxied — worker routes will not fire. Enable the orange cloud.`);
    continue;
  }
  if (!APPLY) {
    console.log(`DRY RUN: would create ${want.type} ${want.name} → ${want.content} (proxied)`);
    continue;
  }
  const made = await api("POST", `/zones/${zone.id}/dns_records`, want);
  console.log(made.ok ? `DNS created: ${want.type} ${want.name}` : `DNS FAILED for ${want.name}: ${JSON.stringify(made.errors)}`);
}

// ---------- 3) Worker routes ----------
const wantRoutes = [`www.${ZONE_NAME}/*`, `${ZONE_NAME}/*`]; // apex route feeds the worker's 301 → www
const routes = await api("GET", `/zones/${zone.id}/workers/routes`);
for (const pattern of wantRoutes) {
  const hit = (routes.result || []).find((r) => r.pattern === pattern);
  if (hit) {
    if (hit.script === SCRIPT) {
      console.log(`Route ok: ${pattern} → ${hit.script}`);
    } else if (APPLY) {
      const upd = await api("PUT", `/zones/${zone.id}/workers/routes/${hit.id}`, { pattern, script: SCRIPT });
      console.log(upd.ok ? `Route repointed: ${pattern} → ${SCRIPT}` : `Route update FAILED: ${JSON.stringify(upd.errors)}`);
    } else {
      console.log(`DRY RUN: would repoint ${pattern} from ${hit.script || "(none)"} → ${SCRIPT}`);
    }
    continue;
  }
  if (!APPLY) {
    console.log(`DRY RUN: would create route ${pattern} → ${SCRIPT}`);
    continue;
  }
  const made = await api("POST", `/zones/${zone.id}/workers/routes`, { pattern, script: SCRIPT });
  console.log(made.ok ? `Route created: ${pattern} → ${SCRIPT}` : `Route FAILED for ${pattern}: ${JSON.stringify(made.errors)}`);
}

// ---------- 4) Post-cutover checklist (things this script cannot do) ----------
console.log(`
${APPLY ? "APPLIED." : "DRY RUN complete (re-run with --apply to execute)."}

Remaining checklist (consoles this script cannot reach):
  [ ] Render backend env  : FRONTEND_ORIGINS += https://www.${ZONE_NAME}
  [ ] Render guest FE env : REACT_APP_API_URL = https://www.${ZONE_NAME}  (then redeploy — CSP connect-src 'self' requires same-origin API)
  [ ] Render admin FE env : REACT_APP_API_URL = https://www.${ZONE_NAME}  (then redeploy)
  [ ] Firebase Console    : Authentication → Settings → Authorized domains += www.${ZONE_NAME}
  [ ] Google Cloud Console: Maps API key → HTTP referrer restrictions += https://www.${ZONE_NAME}/*
  [ ] Cloudflare Turnstile: widget hostnames += www.${ZONE_NAME}
  [ ] Verify: https://www.${ZONE_NAME}/branches/balibago-angeles → branch title, fresh nonce, working chat/map
  [ ] Search Console: add property + submit https://www.${ZONE_NAME}/sitemap.xml
`);
}

await main();
