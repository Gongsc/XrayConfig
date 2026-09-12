#!/usr/bin/env bash

set -Eeuo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vless-reality-test.XXXXXX")"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

cp -R "$REPO_DIR/.env.example" "$REPO_DIR/compose.yaml" "$REPO_DIR/manage.sh" \
  "$REPO_DIR/templates" "$REPO_DIR/site" "$REPO_DIR/network-check" "$TEST_DIR/"

sed \
  -e 's/^DOMAIN=.*/DOMAIN=node.example.com/' \
  -e 's/^ACME_EMAIL=.*/ACME_EMAIL=ops@example.com/' \
  -e 's/^CLIENT_NAME=.*/CLIENT_NAME="Smoke Test"/' \
  -e 's/^RELAY_ADDRESS=.*/RELAY_ADDRESS=relay.example.net/' \
  -e 's/^RELAY_PORT=.*/RELAY_PORT=8443/' \
  "$TEST_DIR/.env.example" >"$TEST_DIR/.env"

export PATH="$REPO_DIR/tests/fake-bin:$PATH"

FIRST_DEPLOY_DIR="$TEST_DIR/first-deploy"
mkdir -p "$FIRST_DEPLOY_DIR"
cp -R "$REPO_DIR/.env.example" "$REPO_DIR/compose.yaml" "$REPO_DIR/manage.sh" \
  "$REPO_DIR/templates" "$REPO_DIR/site" "$REPO_DIR/network-check" "$FIRST_DEPLOY_DIR/"
sed 's/^DOMAIN=.*/DOMAIN=first.example.com/' \
  "$FIRST_DEPLOY_DIR/.env.example" >"$FIRST_DEPLOY_DIR/.env"
printf 'yes\n' | env FAKE_CADDY_LATEST=2.12.0 FAKE_XRAY_LATEST=26.10.1 \
  FAKE_SIXTY_SECONDS_LATEST=2.55.0 "$FIRST_DEPLOY_DIR/manage.sh" init >/dev/null
grep -q '^CADDY_IMAGE=caddy:2.12.0-alpine$' "$FIRST_DEPLOY_DIR/.env"
grep -q '^XRAY_IMAGE=ghcr.io/xtls/xray-core:26.10.1$' "$FIRST_DEPLOY_DIR/.env"
grep -q '^SIXTY_SECONDS_IMAGE=vikiboss/60s:2.55.0$' "$FIRST_DEPLOY_DIR/.env"

bash -n "$REPO_DIR/scripts/bootstrap-server.sh"
node --check "$REPO_DIR/site/app.js"
node --test "$REPO_DIR/network-check/server.test.js"
"$REPO_DIR/scripts/bootstrap-server.sh" --help | grep -q 'Docker Engine and Compose'
grep -q 'https://download.docker.com/linux/' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q "ufw allow 80/tcp" "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q "ufw allow 443/tcp" "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q '\[sshd\]' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q 'modprobe tcp_bbr' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q '^net.core.default_qdisc = fq$' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q '^net.ipv4.tcp_congestion_control = bbr' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q 'tcp_available_congestion_control' "$REPO_DIR/scripts/bootstrap-server.sh"

ruby -e '
  require "yaml"
  compose = YAML.load_file(ARGV.fetch(0))
  caddy = compose.fetch("services").fetch("caddy")
  news_api = compose.fetch("services").fetch("news-api")
  network_check = compose.fetch("services").fetch("network-check")
  abort "Caddy must retain NET_BIND_SERVICE" unless caddy.fetch("cap_add") == ["NET_BIND_SERVICE"]
  abort "Caddy must still drop default capabilities" unless caddy.fetch("cap_drop") == ["ALL"]
  abort "Caddy must remain available when the news API is unhealthy" if caddy.key?("depends_on")
  abort "60s API must not publish host ports" if news_api.key?("ports")
  abort "60s API must be optional" unless news_api.fetch("profiles") == ["news"]
  abort "network checks must be optional with the full site" unless network_check.fetch("profiles") == ["news"]
  abort "network checks must not publish host ports" if network_check.key?("ports")
  abort "60s API image must be configurable and pinned" unless news_api.fetch("image") == "${SIXTY_SECONDS_IMAGE:-vikiboss/60s:2.54.0}"
  compose.fetch("services").each do |name, service|
    logging = service.fetch("logging")
    abort "#{name} must use local log rotation" unless logging.fetch("driver") == "local"
    abort "#{name} max-size is not configurable" unless logging.fetch("options").fetch("max-size") == "${LOG_MAX_SIZE:-10m}"
    abort "#{name} max-file is not configurable" unless logging.fetch("options").fetch("max-file") == "${LOG_MAX_FILE:-3}"
  end
' "$TEST_DIR/compose.yaml"

"$TEST_DIR/manage.sh" init >/dev/null

first_credentials="$(cksum "$TEST_DIR/generated/credentials.env")"
"$TEST_DIR/manage.sh" init >/dev/null
second_credentials="$(cksum "$TEST_DIR/generated/credentials.env")"

[[ "$first_credentials" == "$second_credentials" ]]
grep -q '"target": "caddy:8443"' "$TEST_DIR/generated/xray/config.json"
grep -q '"minClientVer": "1.0.0"' "$TEST_DIR/generated/xray/config.json"
grep -q '"node.example.com"' "$TEST_DIR/generated/xray/config.json"
grep -q '^  email ops@example.com$' "$TEST_DIR/generated/Caddyfile"
grep -q '^node.example.com {' "$TEST_DIR/generated/Caddyfile"
grep -q '^  handle /api/60s {' "$TEST_DIR/generated/Caddyfile"
grep -q '^    root \* /srv$' "$TEST_DIR/generated/Caddyfile"
grep -Fq 'rewrite * /v2/60s?encoding=json' "$TEST_DIR/generated/Caddyfile"
grep -q '^    reverse_proxy news-api:4399$' "$TEST_DIR/generated/Caddyfile"
grep -q '^  handle /api/network-check {' "$TEST_DIR/generated/Caddyfile"
grep -q '^    reverse_proxy network-check:8080 {' "$TEST_DIR/generated/Caddyfile"
grep -q '^      flush_interval -1$' "$TEST_DIR/generated/Caddyfile"
grep -q 'fetch(API_ENDPOINT' "$TEST_DIR/site/app.js"
grep -q 'fetch(NETWORK_ENDPOINT' "$TEST_DIR/site/app.js"
grep -q 'EXPECTED_SAMPLES = 5' "$TEST_DIR/site/app.js"
grep -q 'NETWORK_SCHEMA_VERSION = 3' "$TEST_DIR/site/app.js"
grep -q 'application/x-ndjson' "$TEST_DIR/site/app.js"
grep -q 'className = "sample-result"' "$TEST_DIR/site/app.js"
grep -Fq '"${COMPOSE[@]}" up -d --build' "$TEST_DIR/manage.sh"
grep -q '60 秒读世界' "$TEST_DIR/site/index.html"
grep -q '网络延迟' "$TEST_DIR/site/index.html"
! grep -q 'network-grade' "$TEST_DIR/site/index.html"
grep -q '一切运行正常' "$TEST_DIR/site/static/index.html"
! grep -q '<script' "$TEST_DIR/site/static/index.html"
grep -Eq '^vless://11111111-2222-4333-8444-555555555555@relay\.example\.net:8443\?.*sni=node\.example\.com.*pbk=BBBB.*sid=[0-9a-f]{16}.*#Smoke%20Test$' \
  "$TEST_DIR/generated/client.txt"
grep -q "^  - name: 'Smoke Test'$" "$TEST_DIR/generated/mihomo.yaml"
grep -q "^    server: 'relay.example.net'$" "$TEST_DIR/generated/mihomo.yaml"
grep -q '^    port: 8443$' "$TEST_DIR/generated/mihomo.yaml"
grep -q '^    client-fingerprint: chrome$' "$TEST_DIR/generated/mihomo.yaml"
grep -q '^      support-x25519mlkem768: true$' "$TEST_DIR/generated/mihomo.yaml"
cmp -s <("$TEST_DIR/manage.sh" show-mihomo) "$TEST_DIR/generated/mihomo.yaml"
ruby -e '
  require "yaml"
  proxy = YAML.safe_load(File.read(ARGV.fetch(0))).fetch("proxies").fetch(0)
  abort "Mihomo fingerprint must be chrome" unless proxy.fetch("client-fingerprint") == "chrome"
  reality = proxy.fetch("reality-opts")
  abort "Mihomo ML-KEM support must default to true" unless reality.fetch("support-x25519mlkem768") == true
  abort "Mihomo short ID must remain a string" unless reality.fetch("short-id").is_a?(String)
' "$TEST_DIR/generated/mihomo.yaml"

"$TEST_DIR/manage.sh" validate >/dev/null
ruby -pi -e '
  gsub(/^RELAY_ADDRESS=.*/, "RELAY_ADDRESS=[2001:db8::5]")
  gsub(/^RELAY_PORT=.*/, "RELAY_PORT=2443")
' "$TEST_DIR/.env"
"$TEST_DIR/manage.sh" init >/dev/null
grep -Eq '^vless://11111111-2222-4333-8444-555555555555@\[2001:db8::5\]:2443\?.*sni=node\.example\.com' \
  "$TEST_DIR/generated/client.txt"
grep -q "^    server: '2001:db8::5'$" "$TEST_DIR/generated/mihomo.yaml"
grep -q '^    port: 2443$' "$TEST_DIR/generated/mihomo.yaml"

ruby -pi -e '
  gsub(/^RELAY_ADDRESS=.*/, "RELAY_ADDRESS=")
  gsub(/^RELAY_PORT=.*/, "RELAY_PORT=443")
  gsub(/^ENABLE_60S=.*/, "ENABLE_60S=false")
' "$TEST_DIR/.env"
"$TEST_DIR/manage.sh" init >/dev/null
grep -q '^    root \* /srv/static$' "$TEST_DIR/generated/Caddyfile"
! grep -q 'reverse_proxy news-api:4399' "$TEST_DIR/generated/Caddyfile"
! grep -q 'reverse_proxy network-check:8080' "$TEST_DIR/generated/Caddyfile"
! grep -Eq '__[A-Z0-9_]+__' "$TEST_DIR/generated/Caddyfile"
grep -Eq '^vless://11111111-2222-4333-8444-555555555555@node\.example\.com:443\?.*sni=node\.example\.com' \
  "$TEST_DIR/generated/client.txt"

"$TEST_DIR/manage.sh" validate >/dev/null
"$TEST_DIR/manage.sh" up >/dev/null
"$TEST_DIR/manage.sh" check-updates >/dev/null

update_log="$TEST_DIR/update-docker.log"
printf 'n\n' | env FAKE_CADDY_LATEST=2.12.0 FAKE_XRAY_LATEST=26.10.1 \
  FAKE_SIXTY_SECONDS_LATEST=2.55.0 FAKE_UPDATE_AVAILABLE=true FAKE_DOCKER_LOG="$update_log" \
  "$TEST_DIR/manage.sh" check-updates >"$TEST_DIR/update-cancelled.log"
grep -q '^Updates are available:$' "$TEST_DIR/update-cancelled.log"
grep -q 'caddy.*caddy:2.11.4-alpine.*caddy:2.12.0-alpine' "$TEST_DIR/update-cancelled.log"
grep -q 'xray.*xray-core:26.9.9.*xray-core:26.10.1' "$TEST_DIR/update-cancelled.log"
grep -q 'Update cancelled' "$TEST_DIR/update-cancelled.log"
[[ ! -e "$update_log" ]]

printf 'yes\nyes\n' | env FAKE_CADDY_LATEST=2.12.0 FAKE_XRAY_LATEST=26.10.1 \
  FAKE_SIXTY_SECONDS_LATEST=2.55.0 FAKE_UPDATE_AVAILABLE=true FAKE_DOCKER_LOG="$update_log" \
  "$TEST_DIR/manage.sh" check-updates >"$TEST_DIR/update-applied.log"
grep -q 'Selected service updates applied' "$TEST_DIR/update-applied.log"
grep -q '^up up -d --no-deps caddy xray$' "$update_log"
[[ -f "$TEST_DIR/generated/update-rollback.env" ]]
grep -q '^ROLLBACK_COUNT=2$' "$TEST_DIR/generated/update-rollback.env"
grep -q '^ROLLBACK_ENV_KEY_0=CADDY_IMAGE$' "$TEST_DIR/generated/update-rollback.env"
grep -q '^image tag sha256:current vless-reality-site-rollback:caddy$' "$update_log"
grep -q '^CADDY_IMAGE=caddy:2.12.0-alpine$' "$TEST_DIR/.env"
grep -q '^XRAY_IMAGE=ghcr.io/xtls/xray-core:26.10.1$' "$TEST_DIR/.env"

printf 'yes\n' | env FAKE_DOCKER_LOG="$update_log" \
  "$TEST_DIR/manage.sh" rollback >"$TEST_DIR/rollback-applied.log"
grep -q 'Service image rollback applied' "$TEST_DIR/rollback-applied.log"
grep -q '^up up -d --no-deps --force-recreate caddy xray$' "$update_log"
grep -q '^CADDY_IMAGE=caddy:2.11.4-alpine$' "$TEST_DIR/.env"
grep -q '^XRAY_IMAGE=ghcr.io/xtls/xray-core:26.9.9$' "$TEST_DIR/.env"

"$TEST_DIR/manage.sh" backup >/dev/null

ruby -pi -e 'gsub(/^RELAY_ADDRESS=.*/, "RELAY_ADDRESS=https://relay.example.net")' "$TEST_DIR/.env"
if "$TEST_DIR/manage.sh" init >"$TEST_DIR/invalid-relay.log" 2>&1; then
  printf '%s\n' 'Invalid relay address was unexpectedly accepted.' >&2
  exit 1
fi
grep -q 'RELAY_ADDRESS must be a hostname' "$TEST_DIR/invalid-relay.log"

[[ "$(find "$TEST_DIR/backups" -name '*.tar.gz' | wc -l | tr -d ' ')" == "2" ]]

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

[[ "$(file_mode "$TEST_DIR/generated/credentials.env")" == "600" ]]
[[ "$(file_mode "$TEST_DIR/generated")" == "700" ]]
[[ "$(file_mode "$TEST_DIR/generated/xray")" == "700" ]]
[[ "$(file_mode "$TEST_DIR/generated/xray/config.json")" == "644" ]]
[[ "$(file_mode "$TEST_DIR/generated/client.txt")" == "600" ]]
[[ "$(file_mode "$TEST_DIR/generated/mihomo.yaml")" == "600" ]]

printf '%s\n' 'Smoke tests passed.'
