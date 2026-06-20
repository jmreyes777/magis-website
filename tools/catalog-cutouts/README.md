# Catalog cutout generator

Produces **transparent WebP cutouts** of the latest Facebook auction album so the
homepage carousel shows jewelry "floating" on the page — with **no** runtime ML,
no browser model download, and no extra load/attack surface on the live server.

The heavy background-removal work runs **off-site** (GitHub Actions on a schedule,
or locally), and the site just serves small static images.

## What it does
1. Fetches the latest album from the public backend API
   (`/api/facebook/albums/latest/photos`).
2. Removes each photo's background with a free local model
   (`@imgly/background-removal-node`).
3. Trims transparent margins, resizes (longest side `MAX_DIM`), compresses to WebP
   (`sharp`).
4. Writes images to `user-frontend/public/catalog-cutouts/<photoId>.webp`.
5. Writes `user-frontend/public/catalog-cutouts/manifest.json` (the carousel's
   data source).
6. Prunes cutouts whose photos are no longer in the album (keeps the folder ~album-sized).

It is **idempotent**: already-cached photos are skipped, so a new monthly album
only processes the new photos.

## Run locally
```bash
cd tools/catalog-cutouts
npm install
npm run generate
```

## Options (env vars)
| Var            | Default                                   | Meaning                          |
| -------------- | ----------------------------------------- | -------------------------------- |
| `SOURCE_API`   | `https://magis-website.onrender.com`      | Backend base for the album list  |
| `OUT_DIR`      | `../../user-frontend/public/catalog-cutouts` | Output folder                 |
| `MAX_DIM`      | `900`                                     | Max longest side (px)            |
| `WEBP_QUALITY` | `82`                                      | WebP quality (0–100)             |
| `FORCE`        | `0`                                       | `1` = reprocess every photo      |

## CI
`.github/workflows/catalog-cutouts.yml` runs this on a schedule (and on demand)
and commits any changed cutouts + manifest back to `main`.

## Output is committed
The generated `*.webp` and `manifest.json` under
`user-frontend/public/catalog-cutouts/` **are** committed (served as static assets
via the existing CDN). Only this tool's `node_modules/` is ignored.
