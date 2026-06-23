#!/usr/bin/env node
/**
 * conv-key-probe.js — READ-ONLY diagnostic for the CONV_KEY_SECRET mismatch.
 *
 * Given ONE wrapped conversation key (a `v1:iv:tag:enc` string copied from a
 * Firestore `conversationKeys` doc's `key` field), this tries to decrypt it with
 * each candidate secret and tells you which one works — so you can set the right
 * CONV_KEY_SECRET on the backend WITHOUT guessing or losing data.
 *
 * It is pure Node crypto: NO Firestore, NO network, NO writes. It never prints a
 * secret value — only an 8-char non-reversible fingerprint (sha256 prefix) so you
 * can tell candidates apart safely.
 *
 * Candidates tested (in order):
 *   1. process.env.CONV_KEY_SECRET (auto-loaded from backend/.env if present)
 *   2. each non-empty line of backend/.conv-key-candidates (gitignored; optional)
 *
 * Usage (run from the repo root):
 *   node backend/scripts/conv-key-probe.js "v1:IV:TAG:ENC"
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const wrapped = process.argv[2];
if (!wrapped || !String(wrapped).startsWith("v1:")) {
  console.error(
    'Pass ONE wrapped key as the first arg, e.g.\n  node backend/scripts/conv-key-probe.js "v1:iv:tag:enc"\n' +
      "(copy the `key` field of any conversationKeys doc in the Firebase console)"
  );
  process.exit(1);
}

// Auto-load CONV_KEY_SECRET from the backend env file (no dotenv dependency).
// Checks the dotfile AND the legacy custom name backend/backend.env, which is what
// the server actually loads (deploy log: "Loading env from: /app/backend.env").
function loadEnvSecret() {
  if (process.env.CONV_KEY_SECRET) return;
  const envFiles = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "backend.env"),
  ];
  for (const envPath of envFiles) {
    if (!fs.existsSync(envPath)) continue;
    const line = fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => /^\s*(export\s+)?CONV_KEY_SECRET\s*=/.test(l));
    if (!line) continue;
    let v = line.replace(/^\s*(export\s+)?CONV_KEY_SECRET\s*=\s*/, "").trim();
    v = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (v) {
      process.env.CONV_KEY_SECRET = v;
      return;
    }
  }
}
loadEnvSecret();

// 8 hex chars of sha256(secret): identifies a secret WITHOUT revealing it.
const fingerprint = (secret) =>
  crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8);

// Mirror backend deriveMasterKey()/unwrapConversationKey() exactly.
function canDecrypt(secret) {
  try {
    const master = crypto.createHash("sha256").update(secret).digest(); // 32 bytes
    const [, ivB64, tagB64, encB64] = String(wrapped).split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      master,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    Buffer.concat([
      decipher.update(Buffer.from(encB64, "base64")),
      decipher.final(),
    ]);
    return true;
  } catch {
    return false;
  }
}

const candidates = [];
if (process.env.CONV_KEY_SECRET) {
  candidates.push({ label: "env:CONV_KEY_SECRET", secret: process.env.CONV_KEY_SECRET });
}
const candFile = path.join(__dirname, "..", ".conv-key-candidates");
if (fs.existsSync(candFile)) {
  fs.readFileSync(candFile, "utf8")
    .split(/\r?\n/)
    .forEach((raw, idx) => {
      const secret = raw.trim();
      if (!secret || secret.startsWith("#")) return; // skip blank lines + comments
      candidates.push({ label: `file:line${idx + 1}`, secret });
    });
}

if (!candidates.length) {
  console.error(
    "No candidate secrets found. Add CONV_KEY_SECRET to backend/.env, or list\n" +
      "candidate secrets (one per line) in backend/.conv-key-candidates, then re-run."
  );
  process.exit(1);
}

let found = null;
for (const c of candidates) {
  const ok = canDecrypt(c.secret);
  console.log(`${ok ? "MATCH " : "no    "}  ${c.label}  (fp=${fingerprint(c.secret)})`);
  if (ok && !found) found = c;
}

if (found) {
  console.log(
    `\n==> ${found.label} (fp=${fingerprint(found.secret)}) DECRYPTS this key.\n` +
      "    Set CONV_KEY_SECRET on the Render backend to THIS value, then redeploy. Zero data loss."
  );
  process.exit(0);
}
console.log(
  "\n==> No candidate could decrypt this key.\n" +
    "    Add more candidates to backend/.conv-key-candidates and re-run, OR (staging only)\n" +
    "    delete the conversationKeys docs so they regenerate under the current secret."
);
process.exit(2);
