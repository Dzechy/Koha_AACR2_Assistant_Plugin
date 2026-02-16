#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_PM="$ROOT_DIR/Koha/Plugin/Cataloging/AutoPunctuation.pm"
DIST_DIR="/home/anonymous/Downloads"

if [[ ! -f "$PLUGIN_PM" ]]; then
  echo "Missing plugin entrypoint: $PLUGIN_PM" >&2
  exit 1
fi

VERSION="$(perl -ne 'if (/^our \$VERSION = "([^"]+)";/) { print $1; exit }' "$PLUGIN_PM")"
if [[ -z "$VERSION" ]]; then
  VERSION="dev"
fi

mkdir -p "$DIST_DIR"
OUT_FILE="$DIST_DIR/Koha_AACR2 AI Guardrail Assistant.kpz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/Koha"
cp -R "$ROOT_DIR/Koha/." "$TMP_DIR/Koha/"
cp "$ROOT_DIR/LICENSE" "$TMP_DIR/" 2>/dev/null || true
cp "$ROOT_DIR/README.md" "$TMP_DIR/" 2>/dev/null || true

(
  cd "$TMP_DIR"
  rm -f "$OUT_FILE"
  ZIP_ITEMS=(Koha)
  [[ -f LICENSE ]] && ZIP_ITEMS+=(LICENSE)
  [[ -f README.md ]] && ZIP_ITEMS+=(README.md)
  zip -r -q "$OUT_FILE" "${ZIP_ITEMS[@]}"
)

echo "Built $OUT_FILE"
