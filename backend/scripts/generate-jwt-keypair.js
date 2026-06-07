// backend/scripts/generate-jwt-keypair.js
//
// P2-3 helper: generate an RS256 (RSA-2048) key pair for asymmetric JWT signing
// and print it in the exact forms needed for the backend origin and the
// Cloudflare edge worker. The PRIVATE key goes ONLY on the backend; the PUBLIC
// key goes on both (backend, to verify) and the edge (to verify).
//
// Usage:
//   node backend/scripts/generate-jwt-keypair.js
//
// This script only PRINTS keys — it never writes secrets to disk. Copy the
// values into your secret manager (Render env / `wrangler secret put`).

const { generateKeyPairSync } = require("crypto");

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Single-line, escaped form for dotenv-style env vars (matches FIREBASE_PRIVATE_KEY).
const esc = (pem) => pem.trim().replace(/\n/g, "\\n");

const line = "─".repeat(72);

console.log(line);
console.log("1) BACKEND (origin) — set these env vars, then set JWT_ALG=RS256");
console.log("   Keep JWT_SECRET for now so in-flight HS256 tokens still verify.");
console.log(line);
console.log(`JWT_PRIVATE_KEY=${esc(privateKey)}`);
console.log(`JWT_PUBLIC_KEY=${esc(publicKey)}`);
console.log("JWT_ALG=RS256");
console.log("JWT_ACCEPT_HS256=true   # flip to false after the longest TTL (~4h) elapses");
console.log("");

console.log(line);
console.log("2) EDGE (Cloudflare) — wrangler.toml [vars] (multi-line TOML string)");
console.log(line);
console.log('JWT_PUBLIC_KEY = """');
console.log(publicKey.trim());
console.log('"""');
console.log("");

console.log(line);
console.log("   …or as a Wrangler secret instead of a [vars] entry:");
console.log(line);
console.log("# wrangler secret put JWT_PUBLIC_KEY   (paste the PEM below when prompted)");
console.log(publicKey.trim());
console.log("");

console.log(line);
console.log("3) After max token TTL has elapsed (cutover complete):");
console.log("   - backend: set JWT_ACCEPT_HS256=false");
console.log("   - edge:    remove JWT_SECRET from the worker (HS256 then rejected)");
console.log("   Edge compromise can no longer forge tokens (it holds only the");
console.log("   public key).");
console.log(line);
