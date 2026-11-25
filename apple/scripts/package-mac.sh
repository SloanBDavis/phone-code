#!/bin/sh
# Builds the Mac app for a release: PhoneCode.app for Apple silicon, with its
# own phonecode inside (build-daemon.sh), zipped next to its checksum.
#
#   apple/scripts/package-mac.sh [output directory]   (default: release/)
#
# Signed ad hoc: there is no Apple Developer account behind it, so it is not
# notarized. A copy downloaded in a browser is held back by macOS until it is
# allowed in System Settings; install-app.sh downloads it with curl, which
# macOS does not hold back.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${1:-$ROOT/release}"
DERIVED="${DERIVED_DATA:-$ROOT/DerivedData/mac-release}"
NAME="PhoneCode-mac.zip"

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is needed to build the phonecode that goes inside the app" >&2
  exit 1
}

xcodebuild build \
  -project "$ROOT/apple/PhoneCode.xcodeproj" -scheme PhoneCode -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath "$DERIVED" \
  -skipPackagePluginValidation -skipMacroValidation \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO COMPILATION_CACHE_ENABLE_CACHING=YES \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= ENABLE_HARDENED_RUNTIME=NO \
  PC_BUNDLE_ID_PREFIX=io.github.sloanbdavis

APP="$DERIVED/Build/Products/Release/PhoneCode.app"
HELPER="$APP/Contents/Helpers/phonecode"
[ -x "$HELPER" ] || {
  echo "error: the app was built without its own phonecode" >&2
  exit 1
}
codesign --verify --deep --strict --verbose=2 "$APP"
lipo -archs "$APP/Contents/MacOS/PhoneCode"
lipo -archs "$HELPER"
"$HELPER" --version

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$NAME"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_DIR/$NAME"
(cd "$OUT_DIR" && shasum -a 256 "$NAME" > "$NAME.sha256" && cat "$NAME.sha256")
