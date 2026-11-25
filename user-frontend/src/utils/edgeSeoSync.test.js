// SEO contract: every ROUTE_META description in magis-edge-worker/index.js
// must appear verbatim in the SPA source — the worker mirrors the same values
// into the static <head> for non-JS scrapers (see the SEO-INJECT comment in the
// worker). Compared on DESCRIPTIONS only: the "/" description lives in
// public/index.html and the "/about-us" title is a template literal, so titles
// can't be checked the same way.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.resolve(__dirname, "..");

const edgeSource = fs.readFileSync(
  path.join(REPO_ROOT, "magis-edge-worker", "index.js"),
  "utf8"
);

// ROUTE_META sits between its own declaration and the BRANCH_META table.
const metaStart = edgeSource.indexOf("const ROUTE_META = {");
const metaEnd = edgeSource.indexOf("const BRANCH_META = {");
const routeMetaText =
  metaStart >= 0 && metaEnd > metaStart ? edgeSource.slice(metaStart, metaEnd) : "";

const ROUTE_RE =
  /"(\/[^"]*)":\s*\{\s*title:\s*"([^"]*)",\s*description:\s*"([^"]*)"/g;

const routes = [];
let m;
while ((m = ROUTE_RE.exec(routeMetaText)) !== null) {
  routes.push({ path: m[1], title: m[2], description: m[3] });
}

// Concatenate every non-test .js under src plus the static index.html — the
// same byte stream the <Seo> props are written in.
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const spaSource =
  collectJsFiles(SRC_ROOT)
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n") +
  "\n" +
  fs.readFileSync(path.join(REPO_ROOT, "user-frontend", "public", "index.html"), "utf8");

describe("edge worker ROUTE_META ↔ SPA <Seo> sync", () => {
  test("extracts every ROUTE_META entry", () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
  });

  test.each(routes.map((r) => [r.path, r.description]))(
    "description for %s appears verbatim in the SPA source",
    (_route, description) => {
      expect(spaSource).toContain(description);
    }
  );

  test("per-branch template tail matches buildBranchSeo byte-for-byte", () => {
    const tail = ". Address, opening hours, and directions.";
    expect(edgeSource).toContain(tail);
    const branchSeo = fs.readFileSync(
      path.join(SRC_ROOT, "utils", "branchSeo.js"),
      "utf8"
    );
    expect(branchSeo).toContain(tail);
  });
});
