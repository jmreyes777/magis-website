// src/utils/branchSeo.js
// Per-branch slug + SEO helpers (BRANCH-GBP-LINKS-PLAN.md, Option B).
// Each branch gets a stable /branches/<slug> URL used as its Google Business
// Profile "Website" link, so slugs must NEVER change once a GBP field points
// at them.
//
// Slug resolution order (plan §5):
//   1. `slug` field on the Firestore branch doc (operator-set; wins always)
//   2. static override table below (Appendix A of the plan — city-disambiguated)
//   3. slugify(branch.name)
//   4. branch doc id (last-resort exact match on inbound URLs only)
import { SITE_NAME } from "../components/Seo";

// Lowercase, ASCII, hyphenated. "N.S Amoranto" -> "n-s-amoranto".
export const slugify = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Appendix A (BRANCH-GBP-LINKS-PLAN.md), keyed by slugify(branch name) so
// lookups survive punctuation/casing differences in Firestore data.
// `area` feeds the <title>/description ("Pawnshop in <area> | …").
const APPENDIX_A = {
  "dolores":      { slug: "dolores-san-fernando",            area: "Dolores, San Fernando, Pampanga" },
  "mabalacat":    { slug: "mabalacat",                       area: "Mabalacat, Pampanga" },
  "balibago":     { slug: "balibago-angeles",                area: "Balibago, Angeles City" },
  "pandacaqui":   { slug: "pandacaqui-mexico",               area: "Pandacaqui, Mexico, Pampanga" },
  "madapdap":     { slug: "madapdap-mabalacat",              area: "Madapdap, Mabalacat, Pampanga" },
  "rizal":        { slug: "rizal-angeles",                   area: "Rizal St, Angeles City" },
  "dau":          { slug: "dau-mabalacat",                   area: "Dau, Mabalacat, Pampanga" },
  "don-gueco":    { slug: "don-gueco-angeles",               area: "Aniceto Gueco St, Angeles City" },
  "novaliches-1": { slug: "novaliches-buenamar-quezon-city", area: "Novaliches (Buenamar), Quezon City" },
  "novaliches-2": { slug: "novaliches-susano-quezon-city",   area: "Novaliches (Susano), Quezon City" },
  "n-s-amoranto": { slug: "amoranto-quezon-city",            area: "La Loma, Quezon City" },
};

const appendixEntry = (branch) => APPENDIX_A[slugify(branch?.name)] || null;

// Canonical slug for a branch (resolution order documented above).
export const getBranchSlug = (branch) => {
  if (!branch) return null;
  if (typeof branch.slug === "string" && branch.slug.trim()) {
    return slugify(branch.slug);
  }
  return appendixEntry(branch)?.slug || slugify(branch.name) || branch.id || null;
};

// Match an inbound /branches/<slug> URL to a loaded branch. Case-insensitive;
// accepts the canonical slug, the plain slugified name, or the doc id so
// operator typos in GBP degrade gracefully instead of 404ing.
export const findBranchBySlug = (branches, rawSlug) => {
  if (!Array.isArray(branches) || !rawSlug) return null;
  const wanted = slugify(rawSlug);
  if (!wanted) return null;
  return (
    branches.find((b) => getBranchSlug(b) === wanted) ||
    branches.find((b) => slugify(b.name) === wanted) ||
    branches.find((b) => String(b.id).toLowerCase() === wanted) ||
    null
  );
};

// Obvious seed-data placeholders (backend/branches.json) — never emit these
// into structured data (plan Appendix A warning: fake NAP hurts local SEO).
const isPlaceholderPhone = (phone) => /^1234567890?$/.test(String(phone || "").replace(/\D/g, ""));

// schema.org OpeningHoursSpecification from the branch `schedule` array
// (items: { day: "Monday", open: bool, openTime: "09:00", closeTime: "17:00" }).
// Times are already 24h HH:MM; anything malformed is skipped, never guessed.
const toOpeningHours = (schedule) => {
  if (!Array.isArray(schedule)) return [];
  const TIME = /^\d{2}:\d{2}$/;
  return schedule
    .filter((d) => d && d.open && TIME.test(d.openTime) && TIME.test(d.closeTime) && d.day)
    .map((d) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: d.day,
      opens: d.openTime,
      closes: d.closeTime,
    }));
};

// Props for <Seo> on /branches/<slug> (plan §10): unique title/description,
// canonical path, breadcrumbs, and a PawnShop JSON-LD node built ONLY from
// fields actually present on the branch doc.
export const buildBranchSeo = (branch, siteOrigin) => {
  const slug = getBranchSlug(branch);
  const path = `/branches/${slug}`;
  const area = appendixEntry(branch)?.area || branch.name;
  const url = `${siteOrigin}${path}`;

  const jsonLd = {
    "@type": "PawnShop",
    "@id": url,
    name: `Magis Gold & Gems — ${branch.name}`,
    url,
  };
  const streetAddress = branch.actualAddress || branch.address;
  if (streetAddress) {
    jsonLd.address = {
      "@type": "PostalAddress",
      streetAddress,
      addressCountry: "PH",
    };
  }
  if (branch.location?.lat && branch.location?.lng) {
    jsonLd.geo = {
      "@type": "GeoCoordinates",
      latitude: branch.location.lat,
      longitude: branch.location.lng,
    };
  }
  if (branch.phone && !isPlaceholderPhone(branch.phone)) {
    jsonLd.telephone = branch.phone;
  }
  const hours = toOpeningHours(branch.schedule);
  if (hours.length > 0) jsonLd.openingHoursSpecification = hours;
  jsonLd.parentOrganization = { "@type": "Organization", name: SITE_NAME };

  return {
    title: `Pawnshop in ${area} | Magis Gold & Gems`,
    description:
      `Magis Gold & Gems ${branch.name} branch in ${area} — pawn (sangla) gold & jewelry, free appraisal` +
      `${branch.hasJewelryDisplay ? ", jewelry sales" : ""}. Address, opening hours, directions, and live chat.`,
    path,
    breadcrumbs: [
      { name: "Home", path: "/" },
      { name: "Find a Branch", path: "/branches" },
      { name: branch.name, path },
    ],
    jsonLd,
  };
};
