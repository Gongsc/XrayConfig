#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Web adapter for xykt/IPQuality; see vendor/IPQuality/LICENSE and NOTICE.md.
# Load the fixed upstream functions, without its interactive entry point.
set -o pipefail
QUALITY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in 4|6) family="$1" ;; *) exit 64 ;; esac
source <(sed -e '/^generate_random_user_agent$/,$d' \
  -e 's/${ipapi\[ipqs\]:-null}/${ipqs[score]:-null}/g' \
  "$QUALITY_DIR/vendor/IPQuality/ip.sh")

# Pin reference data too. All other HTTP probes use the requested IP family.
curl() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      "${rawgithub}main/ref/iso3166.json") cat "$QUALITY_DIR/vendor/IPQuality/ref/iso3166.json"; return ;;
      "${rawgithub}main/ref/iata-icao.csv") cat "$QUALITY_DIR/vendor/IPQuality/ref/iata-icao.csv"; return ;;
    esac
  done
  command curl "-$family" --connect-timeout 5 --max-time 15 "$@"
}
countRunTimes() { :; }
show_progress_bar() { :; }
kill_progress_bar() { :; }
clean_ansi() {
  printf '%b' "$1" | command sed -E $'s/\033\\[[0-9;]*m//g; s/^[[:space:]]*//; s/[[:space:]]*$//'
}
# Native Node probes handle SMTP in a bridge network and distinguish DNS errors.
check_mail() { services=(); smail[local]=2; smail[remote]=0; }
check_dnsbl() { :; }

mode_no=1
mode_json=1
mode_privacy=1
fullIP=1
YY=cn
rawgithub="https://raw.githubusercontent.com/xykt/IPQuality/"
Media_Cookie=$(cat "$QUALITY_DIR/vendor/IPQuality/ref/cookies.txt")
IATA_Database="${rawgithub}main/ref/iata-icao.csv"
generate_random_user_agent
adapt_locale
set_language
IP=""
for endpoint in https://api64.ipify.org https://icanhazip.com https://ipinfo.io/ip; do
  candidate=$(curl -fsS --max-time 5 "$endpoint")
  if node -e 'process.exit(require("node:net").isIP(process.argv[1]) === Number(process.argv[2]) ? 0 : 1)' "$candidate" "$family"; then
    IP="$candidate"
    break
  fi
done
[[ -n "$IP" ]] || exit "$((family * 10))"
check_IP "$IP" "$family"
