/*
 * Free Philippine keyword harvester — Google Autocomplete (no API key).
 * --------------------------------------------------------------------------
 * Pulls what people actually type into Google (PH locale, English + Tagalog)
 * for pawnshop / gold-jewelry seed terms, classifies intent, maps each
 * suggestion to a site page, and writes keywords.json + keywords.csv.
 *
 * Source: suggestqueries.google.com/complete/search  (unofficial, free,
 * rate-limited). We stay polite: one request every REQUEST_DELAY_MS.
 *
 * Run:  node seo-research/keyword-harvester.mjs
 * Needs: Node (uses built-in node:https — no deps, no fetch requirement).
 * Note:  this is research TOOLING, not shipped to the site.
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GL = "ph"; // geo: Philippines
const HLS = ["en", "tl"]; // interface languages: English + Tagalog
const REQUEST_DELAY_MS = 300; // be polite to the free endpoint

// page -> seed phrases (bilingual: English + Filipino/Taglish)
const CLUSTERS = {
  "/": [
    "pawnshop philippines", "trusted pawnshop", "sanglaan",
    "magis pawnshop", "gold buyer philippines",
  ],
  "/pawning": [
    "pawnshop", "pawn shop", "pawn gold", "pawnshop interest rate",
    "sangla", "sangla ng gold", "sangla ng alahas", "sangla ng cellphone",
    "magkano ang sangla ng gold", "patubo", "tubos", "prenda",
    "pawnshop near me", "bsp pawnshop",
  ],
  "/jewelry-sales": [
    "gold jewelry", "buy gold jewelry", "18k gold price", "gold ring",
    "gold necklace", "alahas", "singsing na ginto", "kwintas na ginto",
    "hikaw na ginto", "pulseras na ginto", "presyo ng ginto",
    "gold price today philippines", "jewelry layaway",
  ],
  "/branches": [
    "pawnshop angeles city", "pawnshop pampanga", "sangla pampanga",
    "pawnshop balibago", "pawnshop near me open now", "pawnshop branches",
    "sanglaan malapit",
  ],
  "/faqs": [
    "how to pawn jewelry", "paano mag sangla", "ano ang sangla",
    "requirements sa sangla", "pawnshop interest rate philippines",
    "what happens if i cant redeem my pawn", "is pawning safe",
    "how is gold appraised", "pano ang tubos",
  ],
  "/contact-us": [
    "pawnshop contact number", "pawnshop customer service", "sanglaan hotline",
  ],
};

// question prefixes (EN + TL) used to widen the /faqs cluster
const QWORDS = ["how", "what", "paano", "magkano"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 (SEO keyword research)" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve("");
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", () => resolve(""));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve("");
    });
  });
}

async function suggest(query, hl) {
  const url =
    "https://suggestqueries.google.com/complete/search" +
    `?client=firefox&hl=${hl}&gl=${GL}&q=${encodeURIComponent(query)}`;
  const body = await httpsGet(url);
  if (!body) return [];
  try {
    const parsed = JSON.parse(body); // ["query", ["s1","s2",...]]
    return Array.isArray(parsed?.[1]) ? parsed[1] : [];
  } catch {
    return [];
  }
}

function intentOf(kw) {
  const k = kw.toLowerCase();
  if (/(magkano|price|presyo|rate|interest|patubo|cost|how much|18k|24k)/.test(k))
    return "commercial";
  if (/(near me|branch|open now|sangla ng|pawn |buy |layaway|hulugan|redeem|tubos|contact|hotline|number)/.test(k))
    return "transactional";
  if (/(how|what|where|why|is |paano|ano|saan|bakit|requirements|safe|happens|appraise)/.test(k))
    return "informational";
  return "navigational";
}

function variantsFor(page, seed) {
  const set = new Set([seed]);
  if (page === "/faqs") QWORDS.forEach((w) => set.add(`${w} ${seed}`));
  return [...set];
}

(async () => {
  const rows = new Map(); // lowercased keyword -> record
  let requests = 0;
  const startedAt = Date.now();

  for (const [page, seeds] of Object.entries(CLUSTERS)) {
    for (const seed of seeds) {
      for (const variant of variantsFor(page, seed)) {
        for (const hl of HLS) {
          const list = await suggest(variant, hl);
          requests++;
          for (const s of list) {
            const key = String(s).toLowerCase().trim();
            if (!key || rows.has(key)) continue;
            rows.set(key, {
              keyword: s,
              page,
              intent: intentOf(s),
              lang: hl,
              seed,
            });
          }
          process.stdout.write(
            `\r[${requests}] ${page} :: "${variant}" (${hl})  unique=${rows.size}     `
          );
          await sleep(REQUEST_DELAY_MS);
        }
      }
    }
  }

  const out = [...rows.values()].sort(
    (a, b) => a.page.localeCompare(b.page) || a.keyword.localeCompare(b.keyword)
  );

  const jsonPath = path.join(__dirname, "keywords.json");
  const csvPath = path.join(__dirname, "keywords.csv");
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = [
    "keyword,page,intent,lang,seed",
    ...out.map((r) => [r.keyword, r.page, r.intent, r.lang, r.seed].map(esc).join(",")),
  ].join("\n");

  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  fs.writeFileSync(csvPath, csv);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n\nDone in ${secs}s — ${out.length} unique suggestions from ${requests} requests.`);
  console.log(`Wrote: ${jsonPath}`);
  console.log(`Wrote: ${csvPath}\n`);

  // Per-page summary + samples for a quick eyeball
  const byPage = {};
  for (const r of out) (byPage[r.page] ||= []).push(r.keyword);
  for (const [p, list] of Object.entries(byPage).sort()) {
    console.log(`${p}  (${list.length})`);
    for (const kw of list.slice(0, 10)) console.log(`   - ${kw}`);
    if (list.length > 10) console.log(`   … +${list.length - 10} more`);
    console.log("");
  }

  if (out.length === 0) {
    console.log(
      "No results — the free endpoint may have rate-limited this IP. Wait a few minutes and retry, or lower HLS to [\"en\"]."
    );
  }
})();
