// src/components/Seo.js
// Centralized SEO/meta helper (Wave 1 — SEO-OPTIMIZATION-PLAN.md).
// Renders per-page <title>, description, canonical, Open Graph & Twitter tags
// through react-helmet-async. It adds NO executable <script>, so the nonce-based
// CSP (P3-1) is unaffected. Canonical/OG URLs come from a single SITE_ORIGIN so
// they never vary by host (fixes SEO-5).
import React from "react";
import { Helmet } from "react-helmet-async";

// Single source of truth for the canonical production origin.
// Override at build time with REACT_APP_SITE_URL; defaults to the live domain.
export const SITE_ORIGIN = (
  process.env.REACT_APP_SITE_URL || "https://www.magispawnshop.com"
).replace(/\/+$/, "");

export const SITE_NAME = "Magis Gold & Gems Pawnshop & Jewelry";

const DEFAULT_OG_IMAGE = "/logo512.png";

const toAbsolute = (value) => {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value)
    ? value
    : `${SITE_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
};

export default function Seo({
  title,
  description,
  path = "/",
  image,
  type = "website",
  noindex = false,
}) {
  const normalizedPath =
    path === "/" ? "/" : path.startsWith("/") ? path : `/${path}`;
  const url = `${SITE_ORIGIN}${normalizedPath}`;
  const ogImage = toAbsolute(image || DEFAULT_OG_IMAGE);

  return (
    <Helmet>
      {title ? <title>{title}</title> : null}
      {description ? <meta name="description" content={description} /> : null}
      <link rel="canonical" href={url} />
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
    </Helmet>
  );
}
