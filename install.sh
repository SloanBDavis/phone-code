#!/bin/sh
# Install phonecode from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh | sh
#
# Environment:
#   PHONECODE_INSTALL   install directory (default: ~/.local/bin)
#   PHONECODE_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
#   PHONECODE_BASE_URL  download base URL (default: GitHub releases; for mirrors and testing)
set -eu

REPO="SloanBDavis/phone-code"
INSTALL_DIR="${PHONECODE_INSTALL:-$HOME/.local/bin}"
VERSION="${PHONECODE_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'phonecode install: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS $(uname -s); prebuilt binaries exist for macOS and Linux" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m); prebuilt binaries exist for x64 and arm64" ;;
esac

# An x64 shell under Rosetta on Apple silicon: use the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

if [ "$os" = linux ] && [ -e /etc/alpine-release ]; then
  die "Alpine/musl is not supported by the prebuilt binaries (they need glibc); build from source instead"
fi

target="$os-$arch"
asset="phonecode-$target.tar.gz"

if [ -n "${PHONECODE_BASE_URL:-}" ]; then
  base="$PHONECODE_BASE_URL"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "need sha256sum or shasum to verify the download"
fi

command -v tar >/dev/null 2>&1 || die "need tar"

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t phonecode)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading phonecode for $target ($VERSION)..."
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"
say "Checksum OK."

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
# Write next to the target and rename, so a running phonecode is not clobbered mid-write.
cp "$tmp/phonecode-$target/phonecode" "$INSTALL_DIR/.phonecode.new"
chmod 755 "$INSTALL_DIR/.phonecode.new"
mv -f "$INSTALL_DIR/.phonecode.new" "$INSTALL_DIR/phonecode"

installed="$("$INSTALL_DIR/phonecode" --version 2>/dev/null || true)"
[ -n "$installed" ] || die "installed $INSTALL_DIR/phonecode but it does not run on this machine"

say ""
say "Installed phonecode $installed to $INSTALL_DIR/phonecode"
case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile"
    ;;
esac
say ""
say "Next steps:"
say "  1. For a private https URL, install Tailscale and enable HTTPS certificates"
say "     (https://tailscale.com/kb/1153/enabling-https). Without it phonecode"
say "     only listens on this computer and tells you your options."
say "  2. Run: phonecode"
say "  3. Scan the QR code with your phone's camera."
