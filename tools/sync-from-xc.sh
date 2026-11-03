#!/usr/bin/env sh
# Copy the RNBO export (and the matching rnbo.js) from an xplosive_collision
# checkout into this site, then rebuild the stylesheet.
#
#   tools/sync-from-xc.sh ../xplosive_collision
#
# The interface itself (js/app.js) is a hand-port of XC's
# APP/src/clients/player.js and is not copied automatically.
set -eu

XC="${1:-../xplosive_collision}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# The export the XC player loads — keep in step with PATCH_EXPORT_URL in js/app.js
EXPORT="${EXPORT:-patch.export.json}"
SRC="$XC/APP/public/assets/rnbo_export"
DST="$HERE/assets/rnbo_export"

if [ ! -f "$SRC/$EXPORT" ]; then
  echo "No $EXPORT found in $SRC" >&2
  exit 1
fi

# Replace the export (only the files, never .DS_Store or backups)
mkdir -p "$DST"
find "$DST" -maxdepth 1 -type f -name '*.export.*' -exec rm -f {} +
cp "$SRC/$EXPORT" "$DST/"
LICENSE="$SRC/${EXPORT%.json}.license"
[ -f "$LICENSE" ] && cp "$LICENSE" "$DST/"
[ -f "$SRC/dependencies.json" ] && cp "$SRC/dependencies.json" "$DST/"

# Ship only the rnbo.js the export was made with
VERSION=$(sed -n 's/.*"rnboversion": *"\([^"]*\)".*/\1/p' "$DST/$EXPORT" | head -n 1)
if [ -f "$XC/APP/public/assets/rnbo/$VERSION/rnbo.min.js" ]; then
  mkdir -p "$HERE/assets/rnbo/$VERSION"
  cp "$XC/APP/public/assets/rnbo/$VERSION/rnbo.min.js" "$HERE/assets/rnbo/$VERSION/"
  find "$HERE/assets/rnbo" -mindepth 1 -maxdepth 1 -type d ! -name "$VERSION" -exec rm -r {} +
else
  echo "warning: XC has no rnbo.js $VERSION — the page will fall back to the Cycling '74 CDN" >&2
fi
echo "RNBO export synced: $EXPORT (rnbo.js $VERSION)"

npx --yes sass --no-source-map "$HERE/style/app.scss" "$HERE/style/app.css"
echo "style/app.css rebuilt"
