#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GENERATED_DIR="$ROOT_DIR/generated"
XRAY_DIR="$GENERATED_DIR/xray"
CREDENTIALS_FILE="$GENERATED_DIR/credentials.env"
CLIENT_FILE="$GENERATED_DIR/client.txt"
MIHOMO_FILE="$GENERATED_DIR/mihomo.yaml"
CADDY_FILE="$GENERATED_DIR/Caddyfile"
ROLLBACK_FILE="$GENERATED_DIR/update-rollback.env"
COMPOSE=()
COMPOSE_ALL=()

info() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

die() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./manage.sh <command>

Commands:
  init              Generate credentials and render configuration (idempotent)
  preflight         Check dependencies, DNS and port availability
  validate          Validate Compose, Caddy and Xray configuration
  up                Validate and start the stack
  down              Stop the stack without deleting certificates
  restart           Restart active services
  status            Show container status
  check-updates     Check latest releases and ask before updating .env
  rollback          Roll back the most recently backed-up service image update
  logs [service]    Follow logs (service: caddy, xray, news-api or network-check)
  show-client       Print the generated VLESS import link
  show-mihomo       Print the generated Mihomo proxy configuration
  backup            Create a private backup archive under backups/
  rotate --yes      Back up and replace UUID, Reality keys and short ID
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

is_valid_ipv4() {
  local address="$1"
  local octet
  local -a octets=()

  IFS=. read -r -a octets <<<"$address"
  ((${#octets[@]} == 4)) || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
}

is_valid_ipv6() {
  local address="$1"

  command -v python3 >/dev/null 2>&1 || \
    die "Python 3 is required to validate an IPv6 RELAY_ADDRESS; use a relay hostname instead."
  python3 -c 'import ipaddress, sys; ipaddress.IPv6Address(sys.argv[1])' "$address" >/dev/null 2>&1
}

load_env() {
  [[ -f "$ROOT_DIR/.env" ]] || die "Missing .env. Run: cp .env.example .env"

  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a

  DOMAIN="${DOMAIN:-}"
  ACME_EMAIL="${ACME_EMAIL:-}"
  CLIENT_NAME="${CLIENT_NAME:-home-reality}"
  RELAY_ADDRESS="${RELAY_ADDRESS:-}"
  RELAY_PORT="${RELAY_PORT:-443}"
  ENABLE_60S="${ENABLE_60S:-true}"
  XRAY_IMAGE="${XRAY_IMAGE:-ghcr.io/xtls/xray-core:26.9.9}"
  CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.11.4-alpine}"
  SIXTY_SECONDS_IMAGE="${SIXTY_SECONDS_IMAGE:-vikiboss/60s:2.54.0}"
  LOG_MAX_SIZE="${LOG_MAX_SIZE:-10m}"
  LOG_MAX_FILE="${LOG_MAX_FILE:-3}"

  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || \
    die "DOMAIN must be a hostname such as node.example.com (no scheme, path, wildcard or port)."
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"

  if [[ -n "$ACME_EMAIL" ]]; then
    [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || \
      die "ACME_EMAIL is not a supported email address."
  fi

  [[ -n "$CLIENT_NAME" ]] || die "CLIENT_NAME must not be empty."
  if [[ "$RELAY_ADDRESS" =~ ^\[(.*)\]$ ]]; then
    RELAY_ADDRESS="${BASH_REMATCH[1]}"
  elif [[ "$RELAY_ADDRESS" == *"["* || "$RELAY_ADDRESS" == *"]"* ]]; then
    die "RELAY_ADDRESS has invalid brackets. Use a hostname, IPv4 address or IPv6 literal."
  fi
  if [[ "$RELAY_ADDRESS" == *"/"* || "$RELAY_ADDRESS" == *"@"* || \
    "$RELAY_ADDRESS" == *"?"* || "$RELAY_ADDRESS" == *"#"* || "$RELAY_ADDRESS" == *"%"* ]]; then
    die "RELAY_ADDRESS must be a hostname, IPv4 address or IPv6 literal without a scheme or port."
  fi
  if [[ -n "$RELAY_ADDRESS" ]]; then
    if [[ "$RELAY_ADDRESS" == *":"* ]]; then
      is_valid_ipv6 "$RELAY_ADDRESS" || die "RELAY_ADDRESS is not a valid IPv6 literal."
      RELAY_ADDRESS="$(printf '%s' "$RELAY_ADDRESS" | tr '[:upper:]' '[:lower:]')"
    elif is_valid_ipv4 "$RELAY_ADDRESS"; then
      :
    elif [[ "$RELAY_ADDRESS" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
      RELAY_ADDRESS="$(printf '%s' "$RELAY_ADDRESS" | tr '[:upper:]' '[:lower:]')"
    else
      die "RELAY_ADDRESS must be a hostname, IPv4 address or IPv6 literal without a scheme or port."
    fi
  fi
  [[ "$RELAY_PORT" =~ ^[0-9]+$ ]] || die "RELAY_PORT must be an integer from 1 to 65535."
  RELAY_PORT="$((10#$RELAY_PORT))"
  ((RELAY_PORT >= 1 && RELAY_PORT <= 65535)) || die "RELAY_PORT must be an integer from 1 to 65535."
  case "${ENABLE_60S,,}" in
    true|1|yes|on) ENABLE_60S=true ;;
    false|0|no|off) ENABLE_60S=false ;;
    *) die "ENABLE_60S must be true or false." ;;
  esac
  [[ "$LOG_MAX_SIZE" =~ ^[1-9][0-9]*[kKmMgG]$ ]] || \
    die "LOG_MAX_SIZE must be a positive size such as 10m or 1g."
  [[ "$LOG_MAX_FILE" =~ ^[1-9][0-9]*$ ]] || \
    die "LOG_MAX_FILE must be a positive integer."

  COMPOSE=(docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env")
  COMPOSE_ALL=(docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env" --profile news)
  if [[ "$ENABLE_60S" == "true" ]]; then
    COMPOSE+=(--profile news)
  fi
}

require_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
  docker info >/dev/null 2>&1 || die "Docker daemon is not available to the current user."
}

fetch_latest_release_version() {
  local repository="$1"
  local include_prereleases="${2:-false}"
  local endpoint="releases/latest"
  local response tag

  if [[ "$include_prereleases" == "true" ]]; then
    endpoint='releases?per_page=1'
  fi

  response="$(curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    "${RELEASE_API_BASE:-https://api.github.com}/repos/$repository/$endpoint")" || return 1
  tag="$(sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$response" | head -n 1)"
  tag="${tag#v}"
  [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$tag"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local env_tmp="$ROOT_DIR/.env.tmp"
  local env_mode

  if env_mode="$(stat -c '%a' "$ROOT_DIR/.env" 2>/dev/null)"; then
    :
  else
    env_mode="$(stat -f '%Lp' "$ROOT_DIR/.env")"
  fi

  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$ROOT_DIR/.env" >"$env_tmp"
  chmod "$env_mode" "$env_tmp"
  mv "$env_tmp" "$ROOT_DIR/.env"
}

image_version() {
  local service="$1"
  local image="$2"
  local version

  case "$service:$image" in
    caddy:caddy:*-alpine) image="${image#caddy:}"; version="${image%-alpine}" ;;
    xray:ghcr.io/xtls/xray-core:*) version="${image##*:}" ;;
    news-api:vikiboss/60s:*) version="${image##*:}" ;;
    *) return 1 ;;
  esac
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$version"
}

version_is_newer() {
  local candidate="$1"
  local current="$2"
  local candidate_part current_part index
  local -a candidate_parts=()
  local -a current_parts=()

  IFS=. read -r -a candidate_parts <<<"$candidate"
  IFS=. read -r -a current_parts <<<"$current"
  for index in 0 1 2; do
    candidate_part=$((10#${candidate_parts[$index]}))
    current_part=$((10#${current_parts[$index]}))
    ((candidate_part > current_part)) && return 0
    ((candidate_part < current_part)) && return 1
  done
  return 1
}

check_service_updates() {
  local mode="${1:-normal}"
  local answer backup_answer backup_image container_id current_id service image index
  local rollback_timestamp rollback_tmp
  local current_version latest_version xray_version caddy_version sixty_seconds_version
  local -a services=()
  local -a env_keys=()
  local -a current_images=()
  local -a latest_images=()
  local -a updated_services=()
  local -a updated_env_keys=()
  local -a old_images=()
  local -a new_images=()
  local -a current_ids=()
  local -a deployed_services=()

  load_env
  require_docker
  require_command curl

  services=(caddy xray)
  env_keys=(CADDY_IMAGE XRAY_IMAGE)
  current_images=("$CADDY_IMAGE" "$XRAY_IMAGE")

  info "Checking the latest releases independently of the versions pinned in .env..."
  if ! caddy_version="$(fetch_latest_release_version caddyserver/caddy)"; then
    if [[ "$mode" == "initial" ]]; then
      warn "Could not check the latest Caddy release; continuing with the version in .env."
      return
    fi
    die "Could not determine the latest Caddy release."
  fi
  # Xray publishes current builds as GitHub pre-releases, so use its newest
  # release entry instead of the /releases/latest endpoint that omits them.
  if ! xray_version="$(fetch_latest_release_version XTLS/Xray-core true)"; then
    if [[ "$mode" == "initial" ]]; then
      warn "Could not check the latest Xray release; continuing with the version in .env."
      return
    fi
    die "Could not determine the latest Xray release."
  fi
  latest_images=("caddy:${caddy_version}-alpine" "ghcr.io/xtls/xray-core:$xray_version")

  if [[ "$ENABLE_60S" == "true" ]]; then
    services+=(news-api)
    env_keys+=(SIXTY_SECONDS_IMAGE)
    current_images+=("$SIXTY_SECONDS_IMAGE")
    if ! sixty_seconds_version="$(fetch_latest_release_version vikiboss/60s)"; then
      if [[ "$mode" == "initial" ]]; then
        warn "Could not check the latest 60s release; continuing with the versions in .env."
        return
      fi
      die "Could not determine the latest 60s release."
    fi
    latest_images+=("vikiboss/60s:$sixty_seconds_version")
  fi

  for index in "${!services[@]}"; do
    latest_version="$(image_version "${services[$index]}" "${latest_images[$index]}")"
    current_version=""
    image_version "${services[$index]}" "${current_images[$index]}" >/dev/null 2>&1 && \
      current_version="$(image_version "${services[$index]}" "${current_images[$index]}")"
    if [[ -z "$current_version" ]] || version_is_newer "$latest_version" "$current_version"; then
      updated_services+=("${services[$index]}")
      updated_env_keys+=("${env_keys[$index]}")
      old_images+=("${current_images[$index]}")
      new_images+=("${latest_images[$index]}")
    fi
  done

  if ((${#updated_services[@]} == 0)); then
    info "All enabled services are pinned to their latest release."
    return
  fi

  printf '\nUpdates are available:\n'
  for index in "${!updated_services[@]}"; do
    printf '  %-10s %s -> %s\n' "${updated_services[$index]}" \
      "${old_images[$index]}" "${new_images[$index]}"
  done
  if [[ "$mode" == "initial" ]]; then
    printf '\nUse these latest versions for the first deployment? [y/N] '
  else
    printf '\nUpdate .env and recreate the deployed services listed above? [y/N] '
  fi
  if ! IFS= read -r answer; then
    answer=""
  fi
  case "${answer,,}" in
    y|yes)
      if [[ "$mode" == "initial" ]]; then
        for index in "${!updated_services[@]}"; do
          set_env_value "${updated_env_keys[$index]}" "${new_images[$index]}"
        done
        load_env
        info "The first deployment will use the selected latest service versions."
        return
      fi

      load_credentials
      render_files
      for index in "${!updated_services[@]}"; do
        service="${updated_services[$index]}"
        container_id="$("${COMPOSE[@]}" ps --all --quiet "$service" 2>/dev/null | head -n 1)"
        current_id=""
        if [[ -n "$container_id" ]]; then
          current_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null)" || \
            die "Could not inspect the current $service container."
          deployed_services+=("$service")
        fi
        current_ids+=("$current_id")
      done

      printf 'Create an automatic configuration and image backup for rollback? [Y/n] '
      if ! IFS= read -r backup_answer; then
        backup_answer=""
      fi
      case "${backup_answer,,}" in
        ''|y|yes)
          backup_state
          rollback_timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
          rollback_tmp="$ROLLBACK_FILE.tmp"
          umask 077
          {
            printf 'ROLLBACK_CREATED_AT=%q\n' "$rollback_timestamp"
            printf 'ROLLBACK_COUNT=%q\n' "${#updated_services[@]}"
          } >"$rollback_tmp"
          for index in "${!updated_services[@]}"; do
            service="${updated_services[$index]}"
            backup_image=""
            if [[ -n "${current_ids[$index]}" ]]; then
              backup_image="vless-reality-site-rollback:$service"
              docker image tag "${current_ids[$index]}" "$backup_image"
            fi
            {
              printf 'ROLLBACK_SERVICE_%d=%q\n' "$index" "$service"
              printf 'ROLLBACK_ENV_KEY_%d=%q\n' "$index" "${updated_env_keys[$index]}"
              printf 'ROLLBACK_IMAGE_%d=%q\n' "$index" "${old_images[$index]}"
              printf 'ROLLBACK_BACKUP_IMAGE_%d=%q\n' "$index" "$backup_image"
            } >>"$rollback_tmp"
          done
          mv "$rollback_tmp" "$ROLLBACK_FILE"
          chmod 600 "$ROLLBACK_FILE"
          info "Rollback snapshot saved. Use './manage.sh rollback' to restore it."
          ;;
        *)
          if [[ -f "$ROLLBACK_FILE" ]]; then
            rollback_timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
            mv "$ROLLBACK_FILE" "$ROLLBACK_FILE.superseded-$rollback_timestamp"
          fi
          warn "Automatic backup skipped; this update cannot be rolled back with './manage.sh rollback'."
          ;;
      esac

      for index in "${!updated_services[@]}"; do
        set_env_value "${updated_env_keys[$index]}" "${new_images[$index]}"
      done
      load_env
      "${COMPOSE[@]}" pull "${updated_services[@]}"
      info "Validating configuration with the latest service versions..."
      "${COMPOSE[@]}" config --quiet
      "${COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy \
        validate --config /etc/caddy/Caddyfile --adapter caddyfile
      "${COMPOSE[@]}" run --rm --no-deps xray \
        run -test -config /usr/local/etc/xray/config.json
      if ((${#deployed_services[@]} > 0)); then
        "${COMPOSE[@]}" up -d --no-deps "${deployed_services[@]}"
        "${COMPOSE[@]}" ps "${deployed_services[@]}"
      else
        info "No affected containers are currently deployed; the new versions will be used by the next './manage.sh up'."
      fi
      info "Selected service updates applied."
      ;;
    *)
      if [[ "$mode" == "initial" ]]; then
        info "Latest versions declined. The first deployment will keep the versions pinned in .env."
      else
        info "Update cancelled. .env and running containers were not changed."
      fi
      ;;
  esac
}

rollback_service_update() {
  local answer backup_image env_key image service index
  local service_var env_key_var image_var backup_var
  local -a services=()
  local -a env_keys=()
  local -a images=()
  local -a backup_images=()
  local -a deployed_services=()

  load_env
  require_docker
  [[ -f "$ROLLBACK_FILE" ]] || \
    die "No rollback snapshot is available. Enable automatic backup when applying an update."

  # shellcheck disable=SC1090
  source "$ROLLBACK_FILE"
  [[ "${ROLLBACK_COUNT:-}" =~ ^[1-9][0-9]*$ ]] || die "Rollback snapshot is invalid."

  for ((index = 0; index < ROLLBACK_COUNT; index++)); do
    service_var="ROLLBACK_SERVICE_$index"
    env_key_var="ROLLBACK_ENV_KEY_$index"
    image_var="ROLLBACK_IMAGE_$index"
    backup_var="ROLLBACK_BACKUP_IMAGE_$index"
    service="${!service_var:-}"
    env_key="${!env_key_var:-}"
    image="${!image_var:-}"
    backup_image="${!backup_var:-}"
    case "$service" in
      caddy|xray|news-api) ;;
      *) die "Rollback snapshot contains an invalid service." ;;
    esac
    case "$env_key" in
      CADDY_IMAGE|XRAY_IMAGE|SIXTY_SECONDS_IMAGE) ;;
      *) die "Rollback snapshot contains an invalid environment key." ;;
    esac
    [[ -n "$image" ]] || \
      die "Rollback snapshot contains an invalid image reference."
    if [[ -n "$backup_image" ]]; then
      [[ "$backup_image" == vless-reality-site-rollback:* ]] || \
        die "Rollback snapshot contains an invalid backup image reference."
      docker image inspect "$backup_image" >/dev/null 2>&1 || \
        die "Rollback image is missing for $service: $backup_image"
      deployed_services+=("$service")
    fi
    services+=("$service")
    env_keys+=("$env_key")
    images+=("$image")
    backup_images+=("$backup_image")
  done

  printf 'Rollback snapshot from %s contains:\n' "${ROLLBACK_CREATED_AT:-unknown time}"
  for index in "${!services[@]}"; do
    printf '  %-10s %s\n' "${services[$index]}" "${images[$index]}"
  done
  printf '\nRestore these service images and recreate the listed services? [y/N] '
  if ! IFS= read -r answer; then
    answer=""
  fi
  case "${answer,,}" in
    y|yes)
      load_credentials
      for index in "${!services[@]}"; do
        set_env_value "${env_keys[$index]}" "${images[$index]}"
        if [[ -n "${backup_images[$index]}" ]]; then
          docker image tag "${backup_images[$index]}" "${images[$index]}"
        fi
      done
      load_env
      render_files
      info "Validating configuration with the rollback images..."
      "${COMPOSE[@]}" config --quiet
      "${COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy \
        validate --config /etc/caddy/Caddyfile --adapter caddyfile
      "${COMPOSE[@]}" run --rm --no-deps xray \
        run -test -config /usr/local/etc/xray/config.json
      if ((${#deployed_services[@]} > 0)); then
        "${COMPOSE[@]}" up -d --no-deps --force-recreate "${deployed_services[@]}"
        "${COMPOSE[@]}" ps "${deployed_services[@]}"
      fi
      info "Service image rollback applied."
      ;;
    *) info "Rollback cancelled. Running containers were not changed." ;;
  esac
}

compose_is_running() {
  "${COMPOSE[@]}" ps --status running --quiet 2>/dev/null | grep -q .
}

port_is_listening() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn | awk -v port="$port" '$4 ~ (":" port "$") { found=1 } END { exit !found }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    warn "Neither ss nor lsof is available; skipped the TCP $port availability check."
    return 1
  fi
}

check_ports() {
  if compose_is_running; then
    info "The Compose stack is already running; skipped the host port ownership check."
    return
  fi

  local port
  for port in 80 443; do
    if port_is_listening "$port"; then
      die "TCP port $port is already in use. Stop the existing service before deployment."
    fi
  done
}

check_dns() {
  local addresses=""

  if command -v getent >/dev/null 2>&1; then
    addresses="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dig >/dev/null 2>&1; then
    addresses="$( { dig +short A "$DOMAIN"; dig +short AAAA "$DOMAIN"; } 2>/dev/null | sed '/^$/d' | sort -u || true)"
  fi

  if [[ -z "$addresses" ]]; then
    warn "Could not resolve $DOMAIN locally. Confirm its DNS-only A/AAAA records before starting."
  else
    info "$DOMAIN currently resolves to: $(tr '\n' ' ' <<<"$addresses" | sed 's/[[:space:]]*$//')"
    warn "Confirm every address above belongs to this VPS and that no CDN proxy is enabled."
  fi
}

url_encode() {
  local input="$1"
  local output=""
  local char hex i
  local old_lc_all="${LC_ALL-}"

  LC_ALL=C
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) output+="$char" ;;
      *)
        printf -v hex '%02X' "'$char"
        output+="%$hex"
        ;;
    esac
  done
  LC_ALL="$old_lc_all"
  printf '%s' "$output"
}

yaml_single_quote() {
  local input="$1"

  input="${input//\'/\'\'}"
  printf "'%s'" "$input"
}

load_credentials() {
  [[ -f "$CREDENTIALS_FILE" ]] || die "Credentials are missing. Run: ./manage.sh init"
  # shellcheck disable=SC1090
  source "$CREDENTIALS_FILE"

  [[ "${UUID:-}" =~ ^[0-9a-fA-F-]{36}$ ]] || die "Stored UUID is invalid."
  [[ "${PRIVATE_KEY:-}" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "Stored Reality private key is invalid."
  [[ "${REALITY_PASSWORD:-}" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "Stored Reality password/public key is invalid."
  [[ "${SHORT_ID:-}" =~ ^[0-9a-f]{16}$ ]] || die "Stored short ID is invalid."
}

render_files() {
  local acme_email_option=""
  local client_address="$DOMAIN"
  local client_uri_address="$DOMAIN"
  local client_label
  local client_port=443
  local site_root="/srv/static"

  [[ -d "$ROOT_DIR/templates" ]] || die "templates directory is missing."
  mkdir -p "$XRAY_DIR"
  chmod 700 "$GENERATED_DIR" "$XRAY_DIR"

  sed \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__UUID__|$UUID|g" \
    -e "s|__PRIVATE_KEY__|$PRIVATE_KEY|g" \
    -e "s|__SHORT_ID__|$SHORT_ID|g" \
    "$ROOT_DIR/templates/xray-config.json.tpl" >"$XRAY_DIR/config.json"

  if [[ -n "$ACME_EMAIL" ]]; then
    acme_email_option="  email $ACME_EMAIL"
  fi
  if [[ "$ENABLE_60S" == "true" ]]; then
    site_root="/srv"
  fi
  sed \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__ACME_EMAIL_OPTION__|$acme_email_option|g" \
    -e "s|__SITE_ROOT__|$site_root|g" \
    "$ROOT_DIR/templates/Caddyfile.tpl" | \
    awk -v enabled="$ENABLE_60S" '
      $0 == "__NEWS_ROUTE__" {
        if (enabled == "true") {
          print "  handle /api/60s {"
          print "    rewrite * /v2/60s?encoding=json"
          print "    reverse_proxy news-api:4399"
          print "  }"
          print ""
          print "  handle /api/network-check {"
          print "    rewrite * /check"
          print "    reverse_proxy network-check:8080 {"
          print "      flush_interval -1"
          print "    }"
          print "  }"
          print ""
          print "  handle /api/ip-quality* {"
          print "    uri replace /api/ip-quality /quality"
          print "    reverse_proxy network-check:8080"
          print "  }"
        }
        next
      }
      { print }
    ' >"$CADDY_FILE"

  client_label="$(url_encode "$CLIENT_NAME")"
  if [[ -n "$RELAY_ADDRESS" ]]; then
    client_address="$RELAY_ADDRESS"
    client_uri_address="$RELAY_ADDRESS"
    client_port="$RELAY_PORT"
    if [[ "$client_uri_address" == *":"* ]]; then
      client_uri_address="[$client_uri_address]"
    fi
  fi
  printf '%s\n' \
    "vless://${UUID}@${client_uri_address}:${client_port}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${DOMAIN}&fp=chrome&pbk=${REALITY_PASSWORD}&sid=${SHORT_ID}&type=tcp#${client_label}" \
    >"$CLIENT_FILE"

  {
    printf '%s\n' 'proxies:'
    printf '  - name: %s\n' "$(yaml_single_quote "$CLIENT_NAME")"
    printf '%s\n' '    type: vless'
    printf '    server: %s\n' "$(yaml_single_quote "$client_address")"
    printf '    port: %s\n' "$client_port"
    printf '    uuid: %s\n' "$(yaml_single_quote "$UUID")"
    printf '%s\n' '    encryption: none'
    printf '%s\n' '    network: tcp'
    printf '%s\n' '    udp: true'
    printf '%s\n' '    tls: true'
    printf '%s\n' '    flow: xtls-rprx-vision'
    printf '    servername: %s\n' "$(yaml_single_quote "$DOMAIN")"
    printf '%s\n' '    client-fingerprint: chrome'
    printf '%s\n' '    reality-opts:'
    printf '      public-key: %s\n' "$(yaml_single_quote "$REALITY_PASSWORD")"
    printf '      short-id: %s\n' "$(yaml_single_quote "$SHORT_ID")"
    printf '%s\n' '      support-x25519mlkem768: true'
  } >"$MIHOMO_FILE"

  # The official Xray image runs as a non-root user. The rendered config must
  # therefore be world-readable inside the bind mount. Its parent directories
  # remain mode 0700 on the host, so other host users cannot traverse to it.
  chmod 600 "$CREDENTIALS_FILE" "$CLIENT_FILE" "$MIHOMO_FILE"
  chmod 644 "$XRAY_DIR/config.json" "$CADDY_FILE"
}

generate_credentials() {
  local uuid_output key_output

  require_command openssl
  umask 077
  mkdir -p "$XRAY_DIR"

  info "Generating UUID with the pinned Xray image..."
  uuid_output="$(docker run --rm "$XRAY_IMAGE" uuid 2>&1)" || \
    die "Xray UUID generation failed: $uuid_output"
  UUID="$(grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' <<<"$uuid_output" | head -n 1)"

  info "Generating the X25519 key pair..."
  key_output="$(docker run --rm "$XRAY_IMAGE" x25519 2>&1)" || \
    die "Xray X25519 generation failed: $key_output"
  PRIVATE_KEY="$(awk -F': *' '/^Private[Kk]ey:/ {print $2; exit}' <<<"$key_output")"
  REALITY_PASSWORD="$(awk -F': *' '/^Password/ {print $2; exit}' <<<"$key_output")"
  SHORT_ID="$(openssl rand -hex 8)"
  CREATED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  [[ "$UUID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "Could not parse UUID from Xray output."
  [[ "$PRIVATE_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "Could not parse private key from Xray output."
  [[ "$REALITY_PASSWORD" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "Could not parse password/public key from Xray output."

  {
    printf 'UUID=%q\n' "$UUID"
    printf 'PRIVATE_KEY=%q\n' "$PRIVATE_KEY"
    printf 'REALITY_PASSWORD=%q\n' "$REALITY_PASSWORD"
    printf 'SHORT_ID=%q\n' "$SHORT_ID"
    printf 'CREATED_AT=%q\n' "$CREATED_AT"
  } >"$CREDENTIALS_FILE"
  chmod 600 "$CREDENTIALS_FILE"
}

initialize() {
  load_env
  require_docker
  if [[ ! -f "$CREDENTIALS_FILE" ]]; then
    check_service_updates initial
    load_env
  fi
  check_ports
  check_dns

  if [[ -f "$CREDENTIALS_FILE" ]]; then
    info "Existing credentials found; preserving them."
    load_credentials
  else
    generate_credentials
  fi

  render_files
  info "Configuration rendered under $GENERATED_DIR"
  if [[ -n "$RELAY_ADDRESS" ]]; then
    info "Client relay endpoint: $RELAY_ADDRESS:$RELAY_PORT (SNI remains $DOMAIN)"
  else
    info "Client relay endpoint: disabled (direct to $DOMAIN:443)"
  fi
  info "60s news homepage: $ENABLE_60S"
  info "Run './manage.sh validate' and then './manage.sh up'."
}

preflight() {
  load_env
  require_docker
  require_command openssl
  check_ports
  check_dns
  info "Preflight checks completed. Review any warnings above."
}

validate_configuration() {
  load_env
  require_docker
  load_credentials
  render_files

  info "Validating Docker Compose configuration..."
  "${COMPOSE[@]}" config --quiet

  info "Validating Caddy configuration..."
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy \
    validate --config /etc/caddy/Caddyfile --adapter caddyfile

  info "Validating Xray configuration..."
  "${COMPOSE[@]}" run --rm --no-deps xray \
    run -test -config /usr/local/etc/xray/config.json

  info "All configuration checks passed."
}

start_stack() {
  local caddy_was_running=false
  local optional_service

  load_env
  require_docker
  load_credentials
  if "${COMPOSE_ALL[@]}" ps --status running --quiet caddy 2>/dev/null | grep -q .; then
    caddy_was_running=true
  fi
  check_ports
  check_dns
  validate_configuration

  if [[ "$ENABLE_60S" == "false" ]]; then
    for optional_service in news-api network-check; do
      if "${COMPOSE_ALL[@]}" ps --all --quiet "$optional_service" 2>/dev/null | grep -q .; then
        info "Stopping disabled optional service: $optional_service"
        "${COMPOSE_ALL[@]}" stop "$optional_service"
        "${COMPOSE_ALL[@]}" rm --force "$optional_service"
      fi
    done
  fi

  "${COMPOSE[@]}" up -d --build
  if [[ "$caddy_was_running" == "true" ]]; then
    info "Restarting Caddy to load the rendered site configuration..."
    "${COMPOSE[@]}" restart caddy
  fi
  "${COMPOSE[@]}" ps
  info "Direct website: https://$DOMAIN"
  if [[ -n "$RELAY_ADDRESS" ]]; then
    info "Client relay endpoint: $RELAY_ADDRESS:$RELAY_PORT (SNI remains $DOMAIN)"
  else
    info "Client relay endpoint: disabled (direct to $DOMAIN:443)"
  fi
  info "60s news homepage: $ENABLE_60S"
  info "Client link: ./manage.sh show-client"
  info "Mihomo configuration: ./manage.sh show-mihomo"
}

backup_state() {
  local timestamp archive sequence

  load_env
  load_credentials
  require_command tar
  timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
  mkdir -p "$ROOT_DIR/backups"
  archive="$ROOT_DIR/backups/vless-reality-$timestamp.tar.gz"
  sequence=1
  while [[ -e "$archive" ]]; do
    archive="$ROOT_DIR/backups/vless-reality-$timestamp-$sequence.tar.gz"
    sequence=$((sequence + 1))
  done
  tar -C "$ROOT_DIR" -czf "$archive" generated .env
  chmod 600 "$archive"
  info "Private backup created: $archive"
}

rotate_credentials() {
  [[ "${1:-}" == "--yes" ]] || die "Rotation disconnects existing clients. Re-run: ./manage.sh rotate --yes"

  load_env
  require_docker
  load_credentials
  backup_state

  mv "$CREDENTIALS_FILE" "$CREDENTIALS_FILE.previous"
  generate_credentials
  render_files

  if compose_is_running; then
    "${COMPOSE[@]}" up -d --force-recreate xray
  fi

  info "Credentials rotated. Import the new configuration from './manage.sh show-client' or './manage.sh show-mihomo'."
  info "The previous credential file remains at $CREDENTIALS_FILE.previous until the next rotation."
}

main() {
  local command="${1:-}"

  case "$command" in
    init) initialize ;;
    preflight) preflight ;;
    validate) validate_configuration ;;
    up) start_stack ;;
    down)
      load_env
      require_docker
      "${COMPOSE_ALL[@]}" down
      ;;
    restart)
      load_env
      require_docker
      "${COMPOSE[@]}" restart
      ;;
    status)
      load_env
      require_docker
      "${COMPOSE[@]}" ps
      ;;
    check-updates|update) check_service_updates ;;
    rollback) rollback_service_update ;;
    logs)
      load_env
      require_docker
      if [[ -n "${2:-}" && "${2:-}" != "caddy" && "${2:-}" != "xray" && \
        "${2:-}" != "news-api" && "${2:-}" != "network-check" ]]; then
        die "Service must be 'caddy', 'xray', 'news-api' or 'network-check'."
      fi
      if [[ ("${2:-}" == "news-api" || "${2:-}" == "network-check") && "$ENABLE_60S" == "false" ]]; then
        die "${2:-} is disabled by ENABLE_60S=false."
      fi
      "${COMPOSE[@]}" logs --tail=100 --follow ${2:+"$2"}
      ;;
    show-client)
      [[ -f "$CLIENT_FILE" ]] || die "Client link is missing. Run: ./manage.sh init"
      cat "$CLIENT_FILE"
      ;;
    show-mihomo)
      [[ -f "$MIHOMO_FILE" ]] || die "Mihomo configuration is missing. Run: ./manage.sh init"
      cat "$MIHOMO_FILE"
      ;;
    backup) backup_state ;;
    rotate) rotate_credentials "${2:-}" ;;
    -h|--help|help|'') usage ;;
    *)
      usage >&2
      die "Unknown command: $command"
      ;;
  esac
}

main "$@"
