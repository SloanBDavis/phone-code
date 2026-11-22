#!/bin/sh
# Xcode build phase (macOS only): compile the phonecode daemon with bun and
# put it inside the app as Contents/Helpers/phonecode, so the Mac app is self
# contained: it starts its own phone-code, no CLI install needed.
#
# Rebuilt only when the daemon, protocol or web sources changed. Without bun
# the app is built without it (it then uses an installed phonecode).
set -eu

[ "${PLATFORM_NAME:-}" = "macosx" ] || exit 0

REPO="$(cd "$SRCROOT/.." && pwd)"
# Not Contents/MacOS: the file system is case-insensitive, and "phonecode"
# there would be the app's own "PhoneCode" executable.
OUT_DIR="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
OUT="$OUT_DIR/phonecode"
CACHE="$DERIVED_FILE_DIR/phonecode-daemon"
mkdir -p "$CACHE" "$OUT_DIR"

BUN=""
for b in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -n "$b" ] && [ -x "$b" ]; then BUN="$b"; break; fi
done
if [ -z "$BUN" ]; then
  echo "warning: bun not found: building the app without its own phone-code (install bun from https://bun.sh)"
  exit 0
fi

# One binary per architecture being built, combined with lipo.
STAMP="$CACHE/stamp-$(echo "$ARCHS" | tr ' ' '-')"
SOURCES="$REPO/packages/daemon/src $REPO/packages/protocol/src $REPO/packages/daemon/scripts/build.ts"
[ -d "$REPO/packages/web/dist" ] && SOURCES="$SOURCES $REPO/packages/web/dist"
# shellcheck disable=SC2086
if [ -f "$STAMP" ] && [ -f "$CACHE/phonecode" ] && [ -z "$(find $SOURCES -newer "$STAMP" -type f -print -quit)" ]; then
  echo "phonecode daemon is up to date"
else
  [ -d "$REPO/node_modules" ] || (cd "$REPO" && "$BUN" install --frozen-lockfile)
  # The web app, served to phones that use a browser instead of the app.
  [ -f "$REPO/packages/web/dist/index.html" ] || (cd "$REPO" && "$BUN" run --filter @phone-code/web build)
  parts=""
  for arch in $ARCHS; do
    case "$arch" in
      arm64) target=bun-darwin-arm64 ;;
      x86_64) target=bun-darwin-x64 ;;
      *) echo "error: no bun target for $arch"; exit 1 ;;
    esac
    (cd "$REPO" && "$BUN" packages/daemon/scripts/build.ts --target="$target" --outfile="$CACHE/phonecode-$arch")
    parts="$parts $CACHE/phonecode-$arch"
  done
  # shellcheck disable=SC2086
  lipo -create $parts -output "$CACHE/phonecode"
  touch "$STAMP"
fi

cp -f "$CACHE/phonecode" "$OUT"
chmod 755 "$OUT"

# Sign it like the app. bun's JIT needs these entitlements under the hardened runtime.
IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:-}"
[ -n "$IDENTITY" ] || IDENTITY="-"
if [ "${ENABLE_HARDENED_RUNTIME:-NO}" = "YES" ]; then
  codesign --force --sign "$IDENTITY" --options runtime \
    --entitlements "$SRCROOT/Config/phonecode-daemon.entitlements" "$OUT"
else
  codesign --force --sign "$IDENTITY" "$OUT"
fi
