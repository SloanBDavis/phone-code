#!/usr/bin/env bash
# Proves every lemma of formal/tamarin/PhoneCode.spthy in every deployment
# variant with the Tamarin prover, and compares each result with the
# expectation below. Exits non-zero on any unexpected result or timeout.
#
#   formal/tamarin/check.sh                  all variants
#   formal/tamarin/check.sh insecure public  only these variants
#   TAMARIN_OUT=dir formal/tamarin/check.sh  keep every proof / attack trace in dir
#
# Downloads Tamarin 1.12.0 and Maude 3.5.1 (official GitHub release binaries,
# Linux x86_64, pinned by SHA-256) into formal/.tools/. Elsewhere, set
# TAMARIN=/path/to/tamarin-prover and put maude on PATH.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THEORY="$HERE/PhoneCode.spthy"
TOOLS="$HERE/../.tools"
TAMARIN_VERSION="1.12.0"
MAUDE_VERSION="3.5.1"
TAMARIN_URL="https://github.com/tamarin-prover/tamarin-prover/releases/download/${TAMARIN_VERSION}/tamarin-prover-${TAMARIN_VERSION}-linux64-ubuntu.tar.gz"
TAMARIN_SHA256="201be06f469e47cff554df6ca93db8366fc2c69d70c61fcbd1370a1074b469c6"
MAUDE_URL="https://github.com/maude-lang/Maude/releases/download/Maude${MAUDE_VERSION}/Maude-${MAUDE_VERSION}-linux-x86_64.zip"
MAUDE_SHA256="72ed1ca87e3b3d0dfc6ee1436baf154bf04c45ff97d521bec040c5e8dfc8f92c"
LEMMA_TIMEOUT="${LEMMA_TIMEOUT:-600}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

# ---------------------------------------------------------------- variants
# name | -D flags | lemmas expected to be FALSIFIED (every other lemma defined
# under those flags must verify). See formal/README.md for what each means.
VARIANTS=(
  # Tailscale, attacker outside the tailnet; the QR is seen by nobody else.
  "tailscale|NOLEAK|"
  # The attacker can connect and read answers: Cloudflare tunnel with a trusted
  # operator, a --url reverse proxy, a tailnet member, another local user.
  "public|NET_CLIENT NOLEAK|"
  # Tailscale, and the attacker photographed the QR. Off the tailnet it cannot use it.
  "tailscale_qr_seen|QR_LEAK|"
  # Same, code before the Host check: a DNS-rebinding page in the user's browser
  # pairs with the photographed code and gets a token (real flaw, fixed).
  "tailscale_qr_seen_old_host|QR_LEAK NO_HOST_CHECK|sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner"
  # Same, code before the Origin check: a CSRF page burns the code (it cannot
  # read the token, so sessions stay the owner's); fixed.
  "tailscale_qr_seen_old_origin|QR_LEAK NO_ORIGIN_CHECK|codes_redeemed_only_by_owner"
  # Public endpoint and a seen QR: whoever redeems first gets the device
  # (documented limit; the race is single-use and visible to the owner).
  "public_qr_seen|NET_CLIENT QR_LEAK|sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner"
  # Public endpoint and a leaked ?h= handoff URL (documented limit, same race;
  # the device it pairs is a child of the owner's and dies with it).
  "public_handoff_leak|NET_CLIENT HANDOFF_LEAK|handoff_code_secret sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner"
  # A stolen token: the thief has sessions until the owner revokes that device.
  "stolen_token|NET_CLIENT COMPROMISE|sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner"
  # Same, code before the cascade: devices the thief paired survive (real flaw, fixed).
  "stolen_token_old_nocascade|NET_CLIENT COMPROMISE NO_CASCADE|sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner revoke_cascades revoke_evicts_thief"
  # Code before PairingAuth fix 3: a handoff code pairs after its device was revoked.
  "old_handoff_forget|NOLEAK NO_HANDOFF_FORGET|no_handoff_after_revoke"
  # --insecure plain HTTP, or a tunnel operator that is the attacker (same rules):
  # everything on the wire is the attacker's (documented, expected).
  "insecure|PLAIN NET_CLIENT|token_secret pair_code_secret handoff_code_secret sessions_only_owner_devices hello_injective_agreement codes_redeemed_only_by_owner owner_first_excludes_others race_loss_is_visible handoff_bound_to_minter revoke_only_owner_or_holder"
)

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch() { # url sha256 dest
  curl -fsSL --retry 3 -o "$3.part" "$1"
  if [[ "$(sha256 "$3.part")" != "$2" ]]; then
    echo "checksum mismatch for $1" >&2
    rm -f "$3.part"
    exit 2
  fi
  mv "$3.part" "$3"
}

setup_tools() {
  if [[ -n "${TAMARIN:-}" ]]; then return; fi
  local tdir="$TOOLS/tamarin-$TAMARIN_VERSION" mdir="$TOOLS/maude-$MAUDE_VERSION"
  if [[ ! -x "$tdir/tamarin-prover" ]]; then
    mkdir -p "$tdir"
    echo "Downloading Tamarin $TAMARIN_VERSION from github.com/tamarin-prover ..."
    fetch "$TAMARIN_URL" "$TAMARIN_SHA256" "$TOOLS/tamarin.tgz"
    tar -xzf "$TOOLS/tamarin.tgz" -C "$tdir" tamarin-prover
    rm -f "$TOOLS/tamarin.tgz"
  fi
  if [[ ! -x "$mdir/maude" ]]; then
    mkdir -p "$mdir"
    echo "Downloading Maude $MAUDE_VERSION from github.com/maude-lang ..."
    fetch "$MAUDE_URL" "$MAUDE_SHA256" "$TOOLS/maude.zip"
    if command -v unzip >/dev/null; then unzip -q -o "$TOOLS/maude.zip" -d "$mdir"; else python3 -I -m zipfile -e "$TOOLS/maude.zip" "$mdir"; fi
    chmod +x "$mdir/maude"
    rm -f "$TOOLS/maude.zip"
  fi
  TAMARIN="$tdir/tamarin-prover"
  PATH="$mdir:$PATH"
}

# ------------------------------------------------- one proof (worker mode)
if [[ "${1:-}" == "--one" ]]; then
  variant="$2"; flags="$3"; lemma="$4"; out="$5"
  dflags=()
  for f in $flags; do dflags+=("-D=$f"); done
  start=$(date +%s.%N)
  set +e
  timeout "$LEMMA_TIMEOUT" "$TAMARIN" --prove="$lemma" "${dflags[@]}" "$THEORY" \
    --output="$out/$variant.$lemma.spthy" >"$out/$variant.$lemma.log" 2>&1
  rc=$?
  set -e
  secs=$(awk -v s="$start" -v e="$(date +%s.%N)" 'BEGIN { printf "%.1f", e - s }')
  line=$(grep -E "^  $lemma \((all-traces|exists-trace)\): " "$out/$variant.$lemma.log" | tail -n 1 || true)
  if [[ "$line" =~ :\ verified\ \(([0-9]+)\ steps\) ]]; then result="verified ${BASH_REMATCH[1]}"
  elif [[ "$line" =~ :\ falsified\ -\ found\ trace\ \(([0-9]+)\ steps\) ]]; then result="falsified ${BASH_REMATCH[1]}"
  elif [[ $rc == 124 ]]; then result="timeout -"
  else result="error -"
  fi
  echo "$variant $lemma $result $secs"
  exit 0
fi

# ---------------------------------------------------------------- driver
setup_tools
export LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH TAMARIN LEMMA_TIMEOUT THEORY
echo "$("$TAMARIN" --version 2>/dev/null | grep -m1 -o 'tamarin-prover [0-9.]*'), maude $(maude --version)"

OUT="${TAMARIN_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/phonecode-tamarin.XXXXXX")}"
mkdir -p "$OUT"
[[ -z "${TAMARIN_OUT:-}" ]] && trap 'rm -rf "$OUT"' EXIT

selected=("$@")
declare -A expect_false
jobs="$OUT/jobs.txt"
: >"$jobs"
for entry in "${VARIANTS[@]}"; do
  IFS='|' read -r name flags falsified <<<"$entry"
  if [[ ${#selected[@]} -gt 0 ]] && [[ ! " ${selected[*]} " == *" $name "* ]]; then continue; fi
  for l in $falsified; do expect_false["$name.$l"]=1; done
  dflags=()
  for f in $flags; do dflags+=("-D=$f"); done
  lemmas=$("$TAMARIN" "${dflags[@]}" "$THEORY" 2>/dev/null | grep -oE '^lemma [a-z_]+' | cut -d' ' -f2)
  if [[ -z "$lemmas" ]]; then echo "ERROR: no lemmas for variant $name (theory does not load?)"; exit 2; fi
  for l in $falsified; do
    grep -qx "$l" <<<"$lemmas" || { echo "ERROR: variant $name expects $l falsified, but it is not defined"; exit 2; }
  done
  for l in $lemmas; do printf '%s\0%s\0%s\0' "$name" "$flags" "$l" >>"$jobs"; done
done

start=$(date +%s)
results="$OUT/results.txt"
# sh -c gets $0 = this script, $1 = the output dir, then variant, flags, lemma from xargs.
xargs -0 -n 3 -P "$JOBS" sh -c '"$0" --one "$2" "$3" "$4" "$1"' "$HERE/check.sh" "$OUT" <"$jobs" >"$results.raw" 2>&1 || true
sort "$results.raw" >"$results"

failures=0
while read -r variant lemma result steps secs; do
  want=verified
  [[ -n "${expect_false[$variant.$lemma]:-}" ]] && want=falsified
  if [[ "$result" == "$want" ]]; then
    printf 'ok    %-30s %-30s %-9s %6s steps %7ss\n' "$variant" "$lemma" "$result" "$steps" "$secs"
  else
    printf 'FAIL  %-30s %-30s %-9s (expected %s) %7ss\n' "$variant" "$lemma" "$result" "$want" "$secs"
    failures=$((failures + 1))
  fi
done <"$results"
total=$(wc -l <"$results")
echo "$total proofs in $(( $(date +%s) - start ))s"
if [[ -n "${TAMARIN_OUT:-}" ]]; then echo "proofs and attack traces: $OUT/<variant>.<lemma>.spthy"; fi
if [[ $failures -gt 0 ]]; then echo "$failures unexpected result(s)"; exit 1; fi
echo "all $total lemma results as expected"
