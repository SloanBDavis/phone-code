#!/bin/sh
# Install phone-code from the latest GitHub release: the phonecode command, the
# Mac app, or both. On a Mac that can run the app it asks which; anywhere else
# it installs the command.
#
#   curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh | sh
#
# Without the question:
#   ... | sh -s -- --cli     the phonecode command only
#   ... | sh -s -- --app     the Mac app only (it has its own phonecode inside)
#   ... | sh -s -- --all     both
#
# Environment:
#   PHONECODE_INSTALL   where the command goes (default: ~/.local/bin)
#   PHONECODE_APP_DIR   where the app goes (default: /Applications, or ~/Applications if that is not writable)
#   PHONECODE_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
#   PHONECODE_BASE_URL  download base URL (default: GitHub releases; for mirrors and testing)
# Used by `phonecode update` and the app's own updater:
#   PHONECODE_WAIT_PID  wait for this process to exit before replacing the app
#   PHONECODE_READY_FILE  created once the app is downloaded and checked
#   PHONECODE_OPEN_APP  1 = open the app once it is installed
#   PHONECODE_QUIET     1 = no "next steps" at the end
set -eu

REPO="SloanBDavis/phone-code"
INSTALL_DIR="${PHONECODE_INSTALL:-$HOME/.local/bin}"
VERSION="${PHONECODE_VERSION:-latest}"
APP_ASSET="PhoneCode-mac.zip"

say() { printf '%s\n' "$*"; }
die() {
  printf 'phone-code install: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------- what to install

want=""
for arg in "$@"; do
  case "$arg" in
    --cli) want=cli ;;
    --app) want=app ;;
    --all | --both) want=both ;;
    -h | --help)
      sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
      exit 0
      ;;
    *) die "unknown option $arg (use --cli, --app or --all)" ;;
  esac
done

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

# The Mac app: Apple silicon and macOS 26 or newer. Empty when it can run here.
app_blocker=""
if [ "$os" != darwin ]; then
  app_blocker="the app is for macOS"
elif [ "$arch" != arm64 ]; then
  app_blocker="the app is for Macs with Apple silicon"
elif [ "$(sw_vers -productVersion | cut -d . -f 1)" -lt 26 ]; then
  app_blocker="the app needs macOS 26 or newer (this Mac has $(sw_vers -productVersion))"
fi

# Piped from curl, stdin is the script: the question is asked on the terminal itself.
can_ask() { [ -t 1 ] && (: </dev/tty) 2>/dev/null; }

if [ -z "$want" ]; then
  if [ -z "$app_blocker" ] && can_ask; then
    say "What do you want to install?"
    say ""
    say "  1) Both: the phonecode command and the Mac app"
    say "  2) The phonecode command only (you use it from your phone)"
    say "  3) The Mac app only (it has its own phonecode inside)"
    say ""
    printf 'Choose 1, 2 or 3 [1]: '
    read -r answer </dev/tty || answer=""
    case "$answer" in
      "" | 1) want=both ;;
      2) want=cli ;;
      3) want=app ;;
      *) die "\"$answer\" is not 1, 2 or 3" ;;
    esac
    say ""
  else
    want=cli
  fi
fi

if [ "$want" != cli ] && [ -n "$app_blocker" ]; then
  [ "$want" = app ] && die "$app_blocker; install the command instead (--cli) and use the web app"
  say "Leaving out the Mac app: $app_blocker."
  want=cli
fi

# ---------------------------------------------------------------- downloads

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

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t phonecode)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

# download <asset> <file that lists its checksum>
download() {
  fetch "$base/$1" "$tmp/$1" || die "download failed: $base/$1"
  fetch "$base/$2" "$tmp/$2" || die "download failed: $base/$2"
  expected="$(awk -v f="$1" '$2 == f { print $1 }' "$tmp/$2")"
  [ -n "$expected" ] || die "$1 is not listed in $2"
  actual="$(sha256 "$tmp/$1")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $1 (expected $expected, got $actual)"
  say "Checksum OK."
}

# ---------------------------------------------------------------- the command

install_cli() {
  if [ "$os" = linux ] && [ -e /etc/alpine-release ]; then
    die "Alpine/musl is not supported by the prebuilt binaries (they need glibc); build from source instead"
  fi
  command -v tar >/dev/null 2>&1 || die "need tar"
  target="$os-$arch"
  asset="phonecode-$target.tar.gz"

  say "Downloading phonecode for $target ($VERSION)..."
  download "$asset" SHA256SUMS

  tar -xzf "$tmp/$asset" -C "$tmp"
  mkdir -p "$INSTALL_DIR"
  # Write next to the target and rename, so a running phonecode is not clobbered mid-write.
  cp "$tmp/phonecode-$target/phonecode" "$INSTALL_DIR/.phonecode.new"
  chmod 755 "$INSTALL_DIR/.phonecode.new"
  mv -f "$INSTALL_DIR/.phonecode.new" "$INSTALL_DIR/phonecode"

  installed="$("$INSTALL_DIR/phonecode" --version 2>/dev/null || true)"
  [ -n "$installed" ] || die "installed $INSTALL_DIR/phonecode but it does not run on this machine"
  say "Installed phonecode $installed to $INSTALL_DIR/phonecode"
}

# ---------------------------------------------------------------- the Mac app

install_app() {
  if [ -n "${PHONECODE_APP_DIR:-}" ]; then
    app_dir="$PHONECODE_APP_DIR"
  elif [ -w /Applications ]; then
    app_dir=/Applications
  else
    app_dir="$HOME/Applications"
  fi

  say "Downloading the phone-code app ($VERSION)..."
  download "$APP_ASSET" "$APP_ASSET.sha256"

  ditto -x -k "$tmp/$APP_ASSET" "$tmp/app"
  [ -d "$tmp/app/PhoneCode.app" ] || die "$APP_ASSET does not contain PhoneCode.app"
  codesign --verify --deep --strict "$tmp/app/PhoneCode.app" || die "the downloaded app is damaged"

  # The app updating itself: it quits once this has the new one (it watches for
  # PHONECODE_READY_FILE), so wait for it.
  if [ -n "${PHONECODE_READY_FILE:-}" ]; then : >"$PHONECODE_READY_FILE"; fi
  if [ -n "${PHONECODE_WAIT_PID:-}" ]; then
    n=0
    while kill -0 "$PHONECODE_WAIT_PID" 2>/dev/null && [ "$n" -lt 100 ]; do
      sleep 0.2
      n=$((n + 1))
    done
  fi
  mkdir -p "$app_dir"
  if [ -d "$app_dir/PhoneCode.app" ]; then
    if [ -z "${PHONECODE_WAIT_PID:-}" ] && pgrep -x PhoneCode >/dev/null 2>&1; then
      die "PhoneCode is running: quit it and run this again (or update from the app: PhoneCode > Check for Updates)"
    fi
    rm -rf "$app_dir/PhoneCode.app"
  fi
  mv "$tmp/app/PhoneCode.app" "$app_dir/PhoneCode.app"
  say "Installed $app_dir/PhoneCode.app"
  if [ "${PHONECODE_OPEN_APP:-}" = 1 ]; then open "$app_dir/PhoneCode.app"; fi
}

# ---------------------------------------------------------------- go

case "$want" in
  cli) install_cli ;;
  app) install_app ;;
  both)
    install_cli
    say ""
    install_app
    ;;
esac

[ "${PHONECODE_QUIET:-}" = 1 ] && exit 0

if [ "$want" != app ]; then
  case ":${PATH}:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      say ""
      say "$INSTALL_DIR is not on your PATH. Add it, for example:"
      say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile"
      ;;
  esac
fi
say ""
say "Next steps:"
if [ "$want" = app ] || [ "$want" = both ]; then
  say "  1. Open PhoneCode from Launchpad or Spotlight (or: open \"$app_dir/PhoneCode.app\")."
  say "  2. To use your phone as well, click the QR-code button in the app and scan it."
  say "     For a private https URL the phone can reach from anywhere, install Tailscale"
  say "     on both and enable HTTPS certificates (https://tailscale.com/kb/1153/enabling-https)."
  say ""
  say "Update later from the app (PhoneCode > Check for Updates)$([ "$want" = both ] && printf ' and with: phonecode update')."
else
  say "  1. For a private https URL, install Tailscale and enable HTTPS certificates"
  say "     (https://tailscale.com/kb/1153/enabling-https). Without it phonecode"
  say "     only listens on this computer and tells you your options."
  say "  2. Run: phonecode"
  say "  3. Scan the QR code with your phone's camera."
  say ""
  say "Update later with: phonecode update"
fi
