#!/bin/sh
# The Mac app's UI tests, on this Mac: builds the app, starts phone-code with the
# fake agents the browser tests use, runs the tests against it and leaves the
# screenshots in apple/build/ui-tests/screenshots. CI runs this same script.
#
#   apple/scripts/test-mac.sh                      all of them
#   apple/scripts/test-mac.sh test03MacShellTopButtonsAndHover   only these
#
# Environment: DAEMON_PORT (default 7787), OUT (default apple/build/ui-tests).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$ROOT/apple/build/ui-tests}"
PORT="${DAEMON_PORT:-7787}"
CODE="UITEST-PAIR-01"
SIGNING="CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= ENABLE_HARDENED_RUNTIME=NO PC_BUNDLE_ID_PREFIX=dev.phonecode.ci"

rm -rf "$OUT"
mkdir -p "$OUT/home/project" "$OUT/state" "$OUT/screenshots"
echo '# project' >"$OUT/home/project/README.md"

show() { grep -E "$1" "$2" | awk '!seen[$0]++' | head -600 || true; }

echo "Building the app and its tests..."
status=0
# shellcheck disable=SC2086
xcodebuild build-for-testing \
  -project "$ROOT/apple/PhoneCode.xcodeproj" -scheme PhoneCode \
  -destination "platform=macOS" -derivedDataPath "$ROOT/DerivedData" \
  -skipPackagePluginValidation -skipMacroValidation $SIGNING \
  >"$OUT/build.log" 2>&1 || status=$?
show '(error|warning):|BUILD|\*\*' "$OUT/build.log"
[ "$status" = 0 ] || exit "$status"

FAKES="$ROOT/e2e/fakes"
(
  cd "$OUT/home"
  HOME="$OUT/home" SHELL=/bin/bash PHONECODE_HOME="$OUT/state" PHONECODE_JSON=1 \
    PHONECODE_PAIR_CODE="$CODE" PHONECODE_NO_UPDATE_CHECK=1 \
    PHONECODE_CLAUDE_BIN="$FAKES/fake-claude.mjs" PHONECODE_CODEX_BIN="$FAKES/fake-codex.mjs" \
    PHONECODE_GEMINI_BIN="$FAKES/fake-acp.mjs" PHONECODE_ANTIGRAVITY_BIN="$FAKES/fake-acp.mjs" CLAUDE_CONFIG_DIR="$OUT/home/.claude" \
    CODEX_HOME="$OUT/home/.codex" FAKE_ACP_HOME="$OUT/fake-acp" FAKE_SPEED=2 \
    exec bun "$ROOT/packages/daemon/src/cli.ts" --local --port "$PORT" >"$OUT/daemon.log" 2>&1
) &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT INT TERM
n=0
until curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; do
  n=$((n + 1))
  [ "$n" -lt 60 ] || {
    echo "phone-code did not start; see $OUT/daemon.log" >&2
    exit 1
  }
  sleep 1
done

only=""
for t in "$@"; do only="$only -only-testing:PhoneCodeUITests/PhoneCodeUITests/$t"; done

echo "Running the UI tests..."
status=0
# shellcheck disable=SC2086
TEST_RUNNER_PC_UITEST_DAEMON="http://127.0.0.1:$PORT" \
  TEST_RUNNER_PC_UITEST_CODE="$CODE" \
  TEST_RUNNER_PC_UITEST_HOME="$OUT/state" \
  xcodebuild test-without-building \
  -project "$ROOT/apple/PhoneCode.xcodeproj" -scheme PhoneCode \
  -destination "platform=macOS" -derivedDataPath "$ROOT/DerivedData" \
  -resultBundlePath "$OUT/uitests.xcresult" $only \
  -retry-tests-on-failure -test-iterations 2 $SIGNING \
  >"$OUT/uitests.log" 2>&1 || status=$?
show 'Test Case|error:|\*\*|PCDIAG' "$OUT/uitests.log"

xcrun xcresulttool export attachments --path "$OUT/uitests.xcresult" --output-path "$OUT/screenshots" >/dev/null 2>&1 || true
# The screenshots under the names the tests gave them.
python3 - "$OUT/screenshots" <<'PY' || true
import json, os, sys
d = sys.argv[1]
for t in json.load(open(os.path.join(d, "manifest.json"))):
    for a in t.get("attachments", []):
        src = os.path.join(d, a["exportedFileName"])
        if src.endswith(".png") and os.path.exists(src):
            name = a["suggestedHumanReadableName"].split("_0_")[0]
            os.replace(src, os.path.join(d, name + ".png"))
PY
echo "Screenshots and logs: $OUT"
exit "$status"
