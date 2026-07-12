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
try {
  const j = JSON.parse(text);
  console.log("success:", j.success);
  if (j.errors?.length) console.log("errors:", JSON.stringify(j.errors));
  if (j.messages?.length) console.log("messages:", JSON.stringify(j.messages));
  if (j.result?.id) console.log("deployed id:", j.result.id, "modified:", j.result.modified_on);
} catch {
  console.log(text.slice(0, 800));
}
