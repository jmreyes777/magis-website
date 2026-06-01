import fs from "node:fs";

const ACCOUNT = "8cf3c3e9847d67196d92e0e315a14b9f";
const SCRIPT = "magis-edge-worker-staging";
const TOKEN = process.env.CF_API_TOKEN;
if (!TOKEN) {
  console.error("Missing CF_API_TOKEN env var");
  process.exit(1);
}

const code = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

const metadata = {
  body_part: "worker.js",
  compatibility_date: "2026-06-01",
  bindings: [
    { name: "ADMIN_URL", text: "https://magis-admin-staging.onrender.com", type: "plain_text" },
    { name: "BACKEND_URL", text: "https://magis-website.onrender.com", type: "plain_text" },
    { name: "EDGE_SHARED_SECRET", type: "inherit" },
    { name: "JWT_SECRET", type: "inherit" },
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
