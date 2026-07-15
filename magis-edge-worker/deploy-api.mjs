import fs from "node:fs";

const ACCOUNT = "8cf3c3e9847d67196d92e0e315a14b9f";
const SCRIPT = "magis-edge-worker-staging";
// Resolve the Cloudflare API token, preferring magis-edge-worker/.env (the
// documented place to manage it) over a shell CF_API_TOKEN. .env-first prevents
// a stale/invalid CF_API_TOKEN lingering in the shell/user environment from
// shadowing the value you just set in .env. No dotenv dependency required.
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

const code = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

// P2-3 (RS256 cutover): if JWT_PUBLIC_KEY is present in .env (SPKI PEM, NOT a
// secret), bind it so the edge can verify RS256 tokens. Multi-line PEM must be
// stored in .env with literal \n escapes; we unescape here.
let JWT_PUBLIC_KEY = "";
try {
  const envText = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  const m = envText.match(/^\s*JWT_PUBLIC_KEY\s*=\s*(.+?)\s*$/m);
  if (m) JWT_PUBLIC_KEY = m[1].replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").trim();
} catch {}

// OBS4 (observability megaplan): optional watchdog bindings from .env.
//   ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID — Telegram alerts sent
//     directly from the edge cron (bound as secret_text; skipped when absent).
//   WATCH_SITE_URL — public-site check target. Bind on the production worker
//     only, so a staging deploy doesn't double-alert on the prod site.
function envVal(name) {
  try {
    const envText = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
    const m = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  } catch {}
  return (process.env[name] || "").trim();
}
const TG_TOKEN = envVal("ALERT_TELEGRAM_BOT_TOKEN");
const TG_CHAT = envVal("ALERT_TELEGRAM_CHAT_ID");
const WATCH_SITE_URL = envVal("WATCH_SITE_URL");

const metadata = {
  body_part: "worker.js",
  compatibility_date: "2026-06-01",
  bindings: [
    { name: "ADMIN_URL", text: "https://magis-admin-staging.onrender.com", type: "plain_text" },
    { name: "GUEST_URL", text: "https://magis-guest-staging.onrender.com", type: "plain_text" },
    { name: "BACKEND_URL", text: "https://magis-website.onrender.com", type: "plain_text" },
    { name: "EDGE_SHARED_SECRET", type: "inherit" },
    { name: "JWT_SECRET", type: "inherit" },
    // P2-1/P1.7: KV-backed edge rate limiting (namespace created 2026-07-12).
    { name: "RATE_LIMIT_KV", type: "kv_namespace", namespace_id: "cf4fbc55e27a44a0b2a867c4847a6e97" },
    // P2-3: RS256 verify key, bound only once provided (see .env note above).
    ...(JWT_PUBLIC_KEY ? [{ name: "JWT_PUBLIC_KEY", text: JWT_PUBLIC_KEY, type: "plain_text" }] : []),
    // OBS4: watchdog transports/targets — bound only when configured.
    ...(TG_TOKEN ? [{ name: "ALERT_TELEGRAM_BOT_TOKEN", text: TG_TOKEN, type: "secret_text" }] : []),
    ...(TG_CHAT ? [{ name: "ALERT_TELEGRAM_CHAT_ID", text: TG_CHAT, type: "secret_text" }] : []),
    ...(WATCH_SITE_URL ? [{ name: "WATCH_SITE_URL", text: WATCH_SITE_URL, type: "plain_text" }] : []),
  ],
};

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.append("worker.js", new Blob([code], { type: "application/javascript" }), "worker.js");

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`,
  { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: form }
);

const text = await res.text();
console.log("HTTP", res.status);
let deployOk = false;
try {
  const j = JSON.parse(text);
  deployOk = Boolean(j.success);
  console.log("success:", j.success);
  if (j.errors?.length) console.log("errors:", JSON.stringify(j.errors));
  if (j.messages?.length) console.log("messages:", JSON.stringify(j.messages));
  if (j.result?.id) console.log("deployed id:", j.result.id, "modified:", j.result.modified_on);
} catch {
  console.log(text.slice(0, 800));
}

// SPD1-1 keep-warm + OBS4 watchdog cron. Idempotent PUT of the full schedule
// list on every deploy. */5 (was */10): halves worst-case outage detection
// (2 consecutive fails → ~10-15 min) and keeps the Render free-tier instance
// warmer — still comfortably inside the Workers free plan.
if (deployOk) {
  const cronRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/schedules`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ cron: "*/5 * * * *" }]),
    }
  );
  const cronJson = await cronRes.json().catch(() => ({}));
  console.log("cron schedule:", cronRes.status, cronJson.success ? "*/5 * * * * registered" : JSON.stringify(cronJson.errors || cronJson).slice(0, 300));
  console.log(
    "watchdog bindings:",
    `telegram=${TG_TOKEN && TG_CHAT ? "on" : "off"}`,
    `siteCheck=${WATCH_SITE_URL ? WATCH_SITE_URL : "off"}`
  );
}
