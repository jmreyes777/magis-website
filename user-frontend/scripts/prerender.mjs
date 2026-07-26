// user-frontend/scripts/prerender.mjs
// SEO megaplan Wave 3 — build-time prerender for AI/non-JS crawlers.
//
// WHY: Google/Bing render JS, but GPTBot, ClaudeBot, PerplexityBot and most
// social scrapers do NOT — they saw an empty <div id="root">. This postbuild
// step renders the STATIC routes headlessly and writes real-HTML snapshots to
// build/<route>/index.html. The edge worker maps those paths to the snapshot
// files; humans hydrate the same DOM (src/index.js hydrateRoot switch).
//
// HOW IT STAYS SAFE (the invariants):
//   1. Snapshots are built from the ORIGINAL shell bytes + injected content —
//      never from serialized browser DOM — so every CSP nonce placeholder
//      ("xyz123"), the static-map placeholder, and all inline scripts survive
//      byte-exact (browsers redact nonce attrs in serialized DOM, which would
//      have broken the worker's nonce substitution).
//   2. ALL network beyond the local static server is aborted during capture,
//      so every component renders its deterministic initial (pre-fetch) state
//      — exactly what a fresh client render produces → hydration matches.
//   3. Every snapshot is re-loaded and HYDRATED headlessly; any console error
//      (e.g. minified React #418/#423 hydration errors) fails that route and
//      deletes its snapshot.
//   4. FAIL-OPEN: any failure (Chrome missing, timeout, invariant breach)
//      skips that route — the SPA shell keeps serving exactly as today. The
//      script exits 0 unless PRERENDER_STRICT=1.
//
// Skip entirely with PRERENDER=off (e.g. quick local builds).
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.resolve(__dirname, "..", "build");
const STRICT = process.env.PRERENDER_STRICT === "1";

// Keep in sync with PRERENDERED_ROUTES in magis-edge-worker/index.js.
// "/" is intentionally excluded: its countdown + FB carousel are
// time/network-dependent; static JSON-LD + /llms.txt cover its facts.
const ROUTES = [
  "/pawning",
  "/jewelry-sales",
  "/faqs",
  "/terms",
  "/privacy-policy",
  "/contact-us",
  "/guides/gold-prices-appraisal",
  "/guides/how-to-pawn",
  "/guides/gold-karat-guide",
  "/guides/pawnshop-interest-rates",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const log = (msg) => console.log(`[prerender] ${msg}`);
const warn = (msg) => console.warn(`[prerender] WARN: ${msg}`);

const count = (haystack, needle) => haystack.split(needle).length - 1;

async function main() {
  if (process.env.PRERENDER === "off") {
    log("PRERENDER=off — skipping.");
    return;
  }
  if (!existsSync(path.join(BUILD_DIR, "index.html"))) {
    warn("build/index.html not found — run after `npm run build`. Skipping.");
    return;
  }

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    warn("puppeteer not installed — skipping prerender (SPA shell serves as before).");
    return;
  }

  const shell = await readFile(path.join(BUILD_DIR, "index.html"), "utf8");
  if (!shell.includes('<div id="root"></div>')) {
    warn('shell has no empty <div id="root"></div> marker — skipping (unexpected build output).');
    return;
  }
  const shellNonceCount = count(shell, "xyz123");

  // ── Tiny static server with SPA fallback + per-route snapshot overrides ──
  const overrides = new Map(); // "/faqs" -> absolute snapshot path (verify phase)
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let filePath = null;
      const key = urlPath.length > 1 && urlPath.endsWith("/") ? urlPath.slice(0, -1) : urlPath;
      if (overrides.has(key)) {
        filePath = overrides.get(key);
      } else {
        const candidate = path.join(BUILD_DIR, path.normalize(urlPath).replace(/^([\\/])+/, ""));
        filePath = candidate.startsWith(BUILD_DIR) && existsSync(candidate) && (await stat(candidate)).isFile()
          ? candidate
          : path.join(BUILD_DIR, "index.html"); // SPA fallback → shell
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  log(`static server on ${origin}`);

  let browser;
  const results = { ok: [], failed: [] };
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    // ── Phase 1: capture ──────────────────────────────────────────────────
    for (const route of ROUTES) {
      try {
        const html = await captureRoute(browser, origin, route, shell, shellNonceCount);
        const outDir = path.join(BUILD_DIR, ...route.split("/").filter(Boolean));
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, "index.html"), html, "utf8");
        results.ok.push(route);
        log(`captured ${route} (${(html.length / 1024).toFixed(0)} KB)`);
      } catch (e) {
        results.failed.push(route);
        warn(`capture failed for ${route}: ${e?.message || e}`);
      }
    }

    // ── Phase 2: hydration verify (serve each snapshot, expect 0 errors) ──
    let diffPrinted = false;
    for (const route of [...results.ok]) {
      const snapPath = path.join(BUILD_DIR, ...route.split("/").filter(Boolean), "index.html");
      overrides.set(route, snapPath);
      try {
        await verifyHydration(browser, origin, route);
        log(`hydration clean ${route}`);
      } catch (e) {
        warn(`hydration verify FAILED for ${route}: ${e?.message || e} — deleting snapshot (fail-open)`);
        // Diagnose the FIRST failure: diff the parsed snapshot DOM against a
        // pure client render — prints the exact first divergence.
        if (!diffPrinted) {
          diffPrinted = true;
          try {
            await printFirstDomDiff(browser, origin, route, overrides);
          } catch (de) {
            warn(`dom-diff failed: ${de?.message || de}`);
          }
        }
        await rm(snapPath, { force: true });
        results.ok.splice(results.ok.indexOf(route), 1);
        results.failed.push(route);
      } finally {
        overrides.delete(route);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  log(`done — ${results.ok.length}/${ROUTES.length} routes prerendered${results.failed.length ? `; failed: ${results.failed.join(", ")}` : ""}`);
  if (STRICT && results.failed.length) {
    console.error("[prerender] PRERENDER_STRICT=1 and some routes failed.");
    process.exit(1);
  }
}

// Abort every request that isn't the local static server: components render
// their deterministic pre-fetch state (matches a fresh client's first render).
async function blockExternal(page, origin) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (u.startsWith(origin) && !new URL(u).pathname.startsWith("/api/")) req.continue().catch(() => {});
    else req.abort("blockedbyclient").catch(() => {});
  });
}

async function captureRoute(browser, origin, route, shell, shellNonceCount) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900 });
    // Capture-only flag: lets effectful widgets (e.g. FacebookLatestVideo)
    // skip their fetches so the captured DOM stays in the initial state that
    // hydration's first render reproduces. NOT set during verify — that pass
    // must behave like a real visitor.
    await page.evaluateOnNewDocument(() => {
      window.__PRERENDER__ = true;
    });
    await blockExternal(page, origin);
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle0", timeout: 45_000 });
    // Root must contain the real page (an <h1> from the route), not the
    // Suspense "Loading..." fallback.
    await page.waitForFunction(
      () => {
        const root = document.getElementById("root");
        return root && root.querySelector("h1") && !/^Loading/.test(root.textContent || "");
      },
      { timeout: 30_000 }
    );
    // Let Helmet flush head tags (title/meta/ld+json) after the last commit.
    await page.waitForFunction(() => document.title && document.title.length > 0, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 250));

    const captured = await page.evaluate(() => {
      // innerHTML would MERGE adjacent text nodes (JSX like `Reviewed {date}`
      // renders two text nodes) — on re-parse React sees one node where it
      // expects two → hydration error #418. React's own SSR emits `<!-- -->`
      // separators between adjacent text nodes for exactly this reason, so
      // this serializer does the same.
      const VOID = new Set([
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
      ]);
      const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
      const serChildren = (node) => {
        let out = "";
        let prevWasText = false;
        for (const child of node.childNodes) {
          const isText = child.nodeType === Node.TEXT_NODE;
          if (isText && prevWasText) out += "<!-- -->";
          out += ser(child);
          prevWasText = isText;
        }
        return out;
      };
      const ser = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return escText(node.data);
        if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.data}-->`;
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const tag = node.tagName.toLowerCase();
        let out = `<${tag}`;
        for (const a of node.attributes) out += ` ${a.name}="${escAttr(a.value)}"`;
        out += ">";
        if (VOID.has(tag) && node.namespaceURI === "http://www.w3.org/1999/xhtml") return out;
        return out + serChildren(node) + `</${tag}>`;
      };
      return {
        rootHtml: serChildren(document.getElementById("root")),
        title: document.title,
        description:
          document.querySelector('meta[name="description"][data-rh="true"]')?.content ||
          document.querySelector('meta[name="description"]')?.content ||
          "",
        canonical: document.querySelector('link[rel="canonical"]')?.href || "",
        // Helmet-owned OG/Twitter tags (UAT F-G11): the LAST tag per key wins
        // — when the shell default and <Seo>'s tag briefly coexist, Helmet's
        // per-route value is the later one in document order.
        socialMetas: (() => {
          const byKey = new Map();
          for (const m of document.querySelectorAll("meta[data-rh]")) {
            const key = m.getAttribute("property") || m.getAttribute("name");
            if (key && /^(og:|twitter:)/.test(key)) {
              byKey.set(key, m.getAttribute("content") || "");
            }
          }
          return [...byKey.entries()];
        })(),
        ldJson: Array.from(
          document.querySelectorAll('script[type="application/ld+json"][data-rh="true"]')
        ).map((s) => s.textContent),
      };
    });

    // ── Invariants ────────────────────────────────────────────────────────
    if (!captured.rootHtml || captured.rootHtml.length < 2000) {
      throw new Error(`captured root too small (${captured.rootHtml?.length ?? 0} bytes)`);
    }
    if (/<script\b/i.test(captured.rootHtml)) {
      throw new Error("captured root contains a <script> tag — refusing");
    }
    if (!captured.title) throw new Error("no document.title captured");

    // Build the snapshot from the ORIGINAL shell bytes (nonces intact).
    let html = shell;
    // React 18 hydrateRoot expects a server-rendered <Suspense> boundary to be
    // delimited by <!--$--> … <!--/$--> comment markers (renderToString emits
    // them). App.js has exactly one Suspense boundary — the direct child of
    // <main class="content site-content"> — so mark its content as a completed
    // boundary; without this, hydration throws #418/#423 on every route.
    {
      const openTag = '<main class="content site-content">';
      const openIdx = captured.rootHtml.indexOf(openTag);
      const closeIdx = captured.rootHtml.lastIndexOf("</main>");
      if (openIdx === -1 || closeIdx <= openIdx) {
        throw new Error("app <main> wrapper not found — cannot mark Suspense boundary");
      }
      captured.rootHtml =
        captured.rootHtml.slice(0, openIdx + openTag.length) +
        "<!--$-->" +
        captured.rootHtml.slice(openIdx + openTag.length, closeIdx) +
        "<!--/$-->" +
        captured.rootHtml.slice(closeIdx);
    }
    html = html.replace('<div id="root"></div>', `<div id="root">${captured.rootHtml}</div>`);
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtmlText(captured.title)}</title>`);
    if (captured.description) {
      html = html.replace(
        /<meta[^>]*name="description"[^>]*\/?>/,
        `<meta data-rh="true" name="description" content="${escapeAttr(captured.description)}"/>`
      );
    }
    // UAT F-G11: bake the per-route OG/Twitter values over the shell's static
    // homepage defaults, so non-JS scrapers (FB/X/LinkedIn, GPTBot…) see the
    // right og:url/title/description on every prerendered route. Tags keep
    // data-rh="true" so react-helmet-async adopts them on hydration.
    for (const [key, content] of captured.socialMetas || []) {
      const attr = key.startsWith("og:") ? "property" : "name";
      const re = new RegExp(`<meta[^>]*${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*\\/?>`);
      const tag = `<meta data-rh="true" ${attr}="${key}" content="${escapeAttr(content)}"/>`;
      html = re.test(html) ? html.replace(re, tag) : html.replace("</head>", `${tag}</head>`);
    }
    const headExtras = [];
    if (captured.canonical && !html.includes('rel="canonical"')) {
      headExtras.push(`<link rel="canonical" href="${escapeAttr(captured.canonical)}"/>`);
    }
    for (const block of captured.ldJson) {
      // ld+json is a non-executable DATA block (not gated by script-src);
      // "<" is already escaped by <Seo>'s serializer. data-rh="true" lets
      // react-helmet-async ADOPT/replace these on hydration instead of
      // appending duplicates.
      headExtras.push(`<script type="application/ld+json" data-rh="true">${block}</script>`);
    }
    if (headExtras.length) html = html.replace("</head>", `${headExtras.join("")}</head>`);

    // Nonce placeholders must survive byte-exact for the worker substitution.
    if (count(html, "xyz123") !== shellNonceCount) {
      throw new Error("nonce placeholder count changed — refusing");
    }
    if (!html.includes("map-static-placeholder")) {
      throw new Error("static-map placeholder lost — refusing");
    }
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

async function verifyHydration(browser, origin, route) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err?.message || err)));
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await blockExternal(page, origin);
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle0", timeout: 45_000 });
    await page.waitForFunction(
      () => document.getElementById("root")?.querySelector("h1"),
      { timeout: 30_000 }
    );
    await new Promise((r) => setTimeout(r, 750)); // let hydration + effects settle
    // Network failures from aborted requests are expected; hydration/react
    // errors are not. Filter the benign aborts (they surface as fetch errors).
    const real = errors.filter(
      (e) =>
        !/net::ERR_BLOCKED_BY_CLIENT|Failed to load resource|fetch failed|NetworkError|ERR_FAILED|blocked:|Content Security Policy/i.test(e)
    );
    if (real.length) throw new Error(`console errors: ${real.slice(0, 3).join(" | ")}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// Serializer shared by the DOM-diff diagnostic (same shape as the capture
// serializer, evaluated inside the page).
const SERIALIZER_SNIPPET = `
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const serChildren = (node) => {
    let out = "";
    for (const child of node.childNodes) out += ser(child);
    return out;
  };
  const ser = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return "\\u27EA" + esc(node.data) + "\\u27EB"; // ⟪text⟫ markers show node boundaries
    if (node.nodeType === Node.COMMENT_NODE) return "<!--" + node.data + "-->";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    let out = "<" + tag;
    for (const a of node.attributes) out += " " + a.name + '="' + esc(a.value).replace(/"/g, "&quot;") + '"';
    out += ">";
    return out + serChildren(node) + "</" + tag + ">";
  };
  return serChildren(document.getElementById("root"));
`;

async function printFirstDomDiff(browser, origin, route, overrides) {
  // A) parsed snapshot DOM, JS disabled (exactly what hydration walks).
  // The route override is still active here, so the snapshot is served.
  const pa = await browser.newPage();
  let a, b;
  try {
    await pa.setJavaScriptEnabled(false);
    await pa.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    a = await pa.evaluate(new Function(SERIALIZER_SNIPPET));
  } finally {
    await pa.close().catch(() => {});
  }
  // B) pure client render: drop the override so the SHELL is served (empty
  // #root → createRoot path), then render with the same blocked network.
  overrides.delete(route);
  const pb = await browser.newPage();
  try {
    await pb.setViewport({ width: 1366, height: 900 });
    await pb.setRequestInterception(true);
    pb.on("request", (req) => {
      const u = req.url();
      if (u.startsWith(origin) && !new URL(u).pathname.startsWith("/api/")) req.continue().catch(() => {});
      else req.abort("blockedbyclient").catch(() => {});
    });
    await pb.goto(`${origin}${route}`, { waitUntil: "networkidle0", timeout: 45_000 });
    await pb.waitForFunction(
      () => document.getElementById("root")?.querySelector("h1"),
      { timeout: 30_000 }
    );
    await new Promise((r) => setTimeout(r, 400));
    b = await pb.evaluate(new Function(SERIALIZER_SNIPPET));
  } finally {
    await pb.close().catch(() => {});
  }
  await writeFile(path.join(BUILD_DIR, "..", "prerender-diff-snapshot.txt"), a, "utf8");
  await writeFile(path.join(BUILD_DIR, "..", "prerender-diff-client.txt"), b, "utf8");
  if (a === b) {
    warn(`dom-diff: parsed snapshot and client render are IDENTICAL (${a.length} chars) — mismatch must be timing/attr-level`);
    return;
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (s) => `${s.slice(Math.max(0, i - 60), i)} ▶▶ ${s.slice(i, i + 200)}`.replace(/\s+/g, " ");
  warn(`dom-diff first divergence at char ${i} of ${a.length}/${b.length} (full dumps: prerender-diff-*.txt)`);
  warn(`  SNAPSHOT: ${ctx(a)}`);
  warn(`  CLIENT  : ${ctx(b)}`);
}

const escapeHtmlText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeHtmlText(s).replace(/"/g, "&quot;");

main().catch((e) => {
  warn(`fatal: ${e?.message || e} — no snapshots written (fail-open).`);
  if (STRICT) process.exit(1);
});
