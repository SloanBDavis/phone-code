#!/usr/bin/env bash
# Model-checks every TLA+ spec in formal/ with TLC.
#
#   formal/check.sh              all default configs (about 3.5 minutes on 4 cores)
#   formal/check.sh --extended   also the large ChatSync safety run (long)
#   formal/check.sh NAME.cfg ... only these configs
#
# A config whose first line says "Expected to FAIL" must produce a violation
# of its (single) property: it pins a counterexample (a fixed bug, or a
# documented limitation) so the model keeps demonstrating it. Every other
# config must pass. Exits non-zero on any unexpected result.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$HERE/.tools"
JAR="$TOOLS/tla2tools.jar"
TLA_VERSION="1.8.0"
JAR_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"
JAR_SHA256="fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713"
JAVA="${JAVA:-java}"
WORKERS="${TLC_WORKERS:-auto}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [[ ! -f "$JAR" ]]; then
  mkdir -p "$TOOLS"
  echo "Downloading tla2tools.jar v$TLA_VERSION from github.com/tlaplus/tlaplus ..."
  curl -fsSL --retry 3 -o "$JAR.part" "$JAR_URL"
  mv "$JAR.part" "$JAR"
fi
if [[ "$(sha256 "$JAR")" != "$JAR_SHA256" ]]; then
  echo "tla2tools.jar checksum mismatch (expected v$TLA_VERSION); delete $JAR and retry" >&2
  exit 2
fi

DEFAULT=(
  ChatSync.cfg ChatSync_bug.cfg ChatSync_ghost.cfg
  PairingAuth.cfg PairingAuth_live.cfg PairingAuth_fixedcode.cfg
  PairingAuth_bug_handoff.cfg PairingAuth_bug_durable.cfg PairingAuth_bug_offline.cfg PairingAuth_bug_cascade.cfg
  PairingAuth_inflight.cfg
  PermissionReq.cfg PermissionReq_bug_status.cfg PermissionReq_forward.cfg
)
if [[ $# -gt 0 && "$1" == "--extended" ]]; then
  CONFIGS=("${DEFAULT[@]}" ChatSync_safety.cfg)
elif [[ $# -gt 0 ]]; then
  CONFIGS=("$@")
else
  CONFIGS=("${DEFAULT[@]}")
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phonecode-tlc.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
failures=0

for cfg in "${CONFIGS[@]}"; do
  spec="${cfg%%_*}"; spec="${spec%.cfg}"
  expect_fail=0
  head -n 1 "$HERE/$cfg" | grep -q "Expected to FAIL" && expect_fail=1
  log="$WORK/${cfg%.cfg}.log"
  start=$(date +%s)
  set +e
  "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers "$WORKERS" -deadlock -noGenerateSpecTE \
    -metadir "$WORK/meta-${cfg%.cfg}" -config "$HERE/$cfg" "$HERE/$spec.tla" >"$log" 2>&1
  rc=$?
  set -e
  secs=$(( $(date +%s) - start ))
  states=$(grep -Eo '[0-9,]+ distinct states found' "$log" | tail -n 1 || true)
  violated=$(grep -Eo '(Invariant|Temporal properties?) [A-Za-z]* ?(is|were) violated' "$log" | head -n 1 || true)
  if grep -q "Model checking completed. No error has been found." "$log"; then outcome=pass; elif [[ -n "$violated" ]]; then outcome=violation; else outcome=error; fi
  if [[ $outcome == error ]]; then
    printf 'ERROR %-34s TLC exit %s (%ss)\n' "$cfg" "$rc" "$secs"; tail -n 30 "$log"; failures=$((failures + 1))
  elif [[ $expect_fail == 1 && $outcome == violation ]]; then
    printf 'ok    %-34s counterexample as expected: %s (%s, %ss)\n' "$cfg" "$violated" "$states" "$secs"
  elif [[ $expect_fail == 0 && $outcome == pass ]]; then
    printf 'ok    %-34s %s (%ss)\n' "$cfg" "$states" "$secs"
  elif [[ $expect_fail == 1 ]]; then
    printf 'FAIL  %-34s expected a counterexample, none found (%s)\n' "$cfg" "$states"; failures=$((failures + 1))
  else
    printf 'FAIL  %-34s %s\n' "$cfg" "$violated"; sed -n '/violated/,$p' "$log" | head -n 200; failures=$((failures + 1))
  fi
done

if [[ $failures -gt 0 ]]; then echo "$failures config(s) failed"; exit 1; fi
echo "all ${#CONFIGS[@]} configs behaved as expected"
