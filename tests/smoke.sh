#!/usr/bin/env bash

set -Eeuo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vless-reality-test.XXXXXX")"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

cp -R "$REPO_DIR/.env.example" "$REPO_DIR/compose.yaml" "$REPO_DIR/manage.sh" \
  "$REPO_DIR/templates" "$REPO_DIR/site" "$TEST_DIR/"

sed \
  -e 's/^DOMAIN=.*/DOMAIN=node.example.com/' \
  -e 's/^ACME_EMAIL=.*/ACME_EMAIL=ops@example.com/' \
  -e 's/^CLIENT_NAME=.*/CLIENT_NAME="Smoke Test"/' \
  "$TEST_DIR/.env.example" >"$TEST_DIR/.env"

export PATH="$REPO_DIR/tests/fake-bin:$PATH"

bash -n "$REPO_DIR/scripts/bootstrap-server.sh"
node --check "$REPO_DIR/site/app.js"
"$REPO_DIR/scripts/bootstrap-server.sh" --help | grep -q 'Docker Engine and Compose'
grep -q 'https://download.docker.com/linux/' "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q "ufw allow 80/tcp" "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q "ufw allow 443/tcp" "$REPO_DIR/scripts/bootstrap-server.sh"
grep -q '\[sshd\]' "$REPO_DIR/scripts/bootstrap-server.sh"

ruby -e '
  require "yaml"
  compose = YAML.load_file(ARGV.fetch(0))
  caddy = compose.fetch("services").fetch("caddy")
  news_api = compose.fetch("services").fetch("news-api")
  abort "Caddy must retain NET_BIND_SERVICE" unless caddy.fetch("cap_add") == ["NET_BIND_SERVICE"]
  abort "Caddy must still drop default capabilities" unless caddy.fetch("cap_drop") == ["ALL"]
  abort "Caddy must remain available when the news API is unhealthy" if caddy.key?("depends_on")
  abort "60s API must not publish host ports" if news_api.key?("ports")
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
grep -Fq 'rewrite * /v2/60s?encoding=json' "$TEST_DIR/generated/Caddyfile"
grep -q '^    reverse_proxy news-api:4399$' "$TEST_DIR/generated/Caddyfile"
grep -q 'fetch(API_ENDPOINT' "$TEST_DIR/site/app.js"
grep -q '60 秒读世界' "$TEST_DIR/site/index.html"
grep -Eq '^vless://11111111-2222-4333-8444-555555555555@node\.example\.com:443\?.*pbk=BBBB.*sid=[0-9a-f]{16}.*#Smoke%20Test$' \
  "$TEST_DIR/generated/client.txt"

"$TEST_DIR/manage.sh" validate >/dev/null
"$TEST_DIR/manage.sh" backup >/dev/null

[[ "$(find "$TEST_DIR/backups" -name '*.tar.gz' | wc -l | tr -d ' ')" == "1" ]]

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

printf '%s\n' 'Smoke tests passed.'
