#!/usr/bin/env bash
# Local WSL helper: generate catalog cutouts on Linux (where sharp/onnxruntime
# prebuilts work), writing straight into the Windows public/ folder.
# Run from Windows:  wsl bash /mnt/c/Users/jmrey/magis-website-new/tools/catalog-cutouts/wsl-generate.sh
set -euo pipefail

REPO=/mnt/c/Users/jmrey/magis-website-new
SRC="$REPO/tools/catalog-cutouts"
OUT="$REPO/user-frontend/public/catalog-cutouts"

# 1) Load nvm + Node 20 (install if missing)
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 20 >/dev/null
nvm use 20 >/dev/null
echo "node=$(node -v) npm=$(npm -v)"

# 2) Install the generator deps on WSL's native fs (fast; avoids /mnt/c slowness)
WORK="$HOME/magis-cc"
mkdir -p "$WORK"
cp "$SRC/package.json" "$SRC/generate.mjs" "$WORK/"
cd "$WORK"
if [ ! -d node_modules ]; then
  echo "installing deps…"
  npm install --no-audit --no-fund
fi

# 3) Generate, writing transparent cutouts into the Windows public/ folder
echo "generating cutouts → $OUT"
OUT_DIR="$OUT" npm run generate
echo "ALL DONE"
