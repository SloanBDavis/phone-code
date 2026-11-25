#!/bin/sh
# Install the phone-code Mac app from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install-app.sh | sh
#
# The app has its own phonecode inside: nothing else to install.
#
# Environment:
#   PHONECODE_APP_DIR   where the app goes (default: /Applications, or ~/Applications if that is not writable)
#   PHONECODE_VERSION   release tag to install, e.g. v0.2.3 (default: latest)
#   PHONECODE_BASE_URL  download base URL (default: GitHub releases; for mirrors and testing)
set -eu

REPO="SloanBDavis/phone-code"
VERSION="${PHONECODE_VERSION:-latest}"
ASSET="PhoneCode-mac.zip"

say() { printf '%s\n' "$*"; }
die() {
  printf 'phone-code app install: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || die "the app is for macOS; on Linux use install.sh"
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] ||
  die "the app is for Macs with Apple silicon; on an Intel Mac use install.sh and the web app"
major="$(sw_vers -productVersion | cut -d . -f 1)"
[ "$major" -ge 26 ] || die "the app needs macOS 26 or newer (this Mac has $(sw_vers -productVersion)); use install.sh and the web app instead"

if [ -n "${PHONECODE_BASE_URL:-}" ]; then
  base="$PHONECODE_BASE_URL"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if [ -n "${PHONECODE_APP_DIR:-}" ]; then
  dir="$PHONECODE_APP_DIR"
elif [ -w /Applications ]; then
  dir=/Applications
else
  dir="$HOME/Applications"
fi

tmp="$(mktemp -d -t phonecode-app)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

say "Downloading the phone-code app ($VERSION)..."
curl -fsSL --retry 3 -o "$tmp/$ASSET" "$base/$ASSET" || die "download failed: $base/$ASSET"
curl -fsSL --retry 3 -o "$tmp/$ASSET.sha256" "$base/$ASSET.sha256" || die "download failed: $base/$ASSET.sha256"

expected="$(awk -v f="$ASSET" '$2 == f { print $1 }' "$tmp/$ASSET.sha256")"
[ -n "$expected" ] || die "$ASSET.sha256 does not list $ASSET"
actual="$(shasum -a 256 "$tmp/$ASSET" | cut -d ' ' -f 1)"
[ "$expected" = "$actual" ] || die "checksum mismatch for $ASSET (expected $expected, got $actual)"
say "Checksum OK."

ditto -x -k "$tmp/$ASSET" "$tmp/app"
[ -d "$tmp/app/PhoneCode.app" ] || die "$ASSET does not contain PhoneCode.app"
codesign --verify --deep --strict "$tmp/app/PhoneCode.app" || die "the downloaded app is damaged"

mkdir -p "$dir"
if [ -d "$dir/PhoneCode.app" ]; then
  if pgrep -x PhoneCode >/dev/null 2>&1; then
    die "PhoneCode is running: quit it and run this again"
  fi
  rm -rf "$dir/PhoneCode.app"
fi
mv "$tmp/app/PhoneCode.app" "$dir/PhoneCode.app"

say ""
say "Installed $dir/PhoneCode.app"
say "Open it from Launchpad or Spotlight, or run: open \"$dir/PhoneCode.app\""
