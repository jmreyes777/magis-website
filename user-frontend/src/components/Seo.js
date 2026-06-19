// src/components/Seo.js
// Centralized SEO/meta helper (Waves 1-2 — SEO-OPTIMIZATION-PLAN.md).
// Renders per-page <title>, description, canonical, Open Graph & Twitter tags
// (Wave 1) plus optional JSON-LD structured data — BreadcrumbList and any page
// schema such as FAQPage (Wave 2) — through react-helmet-async.
// JSON-LD ships as a <script type="application/ld+json"> DATA block: it is NOT
// executable, so the nonce-based CSP (P3-1, script-src) does not gate it and is
// unaffected. Canonical/OG URLs come from a single SITE_ORIGIN so they never
// vary by host (fixes SEO-5).
import React from "react";
import { Helmet } from "react-helmet-async";

// Single source of truth for the canonical production origin.
// Override at build time with REACT_APP_SITE_URL; defaults to the live domain.
export const SITE_ORIGIN = (
  process.env.REACT_APP_SITE_URL || "https://www.magispawnshop.com"
).replace(/\/+$/, "");

export const SITE_NAME = "Magis Gold & Gems Pawnshop & Jewelry";

const DEFAULT_OG_IMAGE = "/logo512.png";

const normalizePath = (p) =>
  p === "/" ? "/" : p.startsWith("/") ? p : `/${p}`;

const toAbsolute = (value) => {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value)
    ? value
    : `${SITE_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
};

// Escape "<" so structured-data strings can never break out of the <script>.
const toJsonLd = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

const buildBreadcrumb = (items) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: `${SITE_ORIGIN}${normalizePath(item.path)}`,
  })),
});

export default function Seo({
  title,
  description,
  path = "/",
  image,
  type = "website",
  noindex = false,
  breadcrumbs,
  jsonLd,
}) {
  const url = `${SITE_ORIGIN}${normalizePath(path)}`;
  const ogImage = toAbsolute(image || DEFAULT_OG_IMAGE);

  const graph = [];
  if (Array.isArray(breadcrumbs) && breadcrumbs.length > 0) {
    graph.push(buildBreadcrumb(breadcrumbs));
  }
  if (jsonLd) {
    graph.push(...(Array.isArray(jsonLd) ? jsonLd : [jsonLd]));
  }

  return (
    <Helmet>
      {title ? <title>{title}</title> : null}
      {description ? <meta name="description" content={description} /> : null}
      {noindex ? null : <link rel="canonical" href={url} />}
      {noindex ? <meta name="robots" content="noindex, follow" /> : null}

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      {title ? <meta property="og:title" content={title} /> : null}
      {description ? (
        <meta property="og:description" content={description} />
      ) : null}
      {ogImage ? <meta property="og:image" content={ogImage} /> : null}

      <meta name="twitter:card" content="summary_large_image" />
      {title ? <meta name="twitter:title" content={title} /> : null}
      {description ? (
        <meta name="twitter:description" content={description} />
      ) : null}
      {ogImage ? <meta name="twitter:image" content={ogImage} /> : null}

      {graph.length > 0 ? (
        <script type="application/ld+json">
          {toJsonLd({ "@context": "https://schema.org", "@graph": graph })}
        </script>
      ) : null}
    </Helmet>
  );
}
