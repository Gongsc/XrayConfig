#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GENERATED_DIR="$ROOT_DIR/generated"
XRAY_DIR="$GENERATED_DIR/xray"
CREDENTIALS_FILE="$GENERATED_DIR/credentials.env"
CLIENT_FILE="$GENERATED_DIR/client.txt"
CADDY_FILE="$GENERATED_DIR/Caddyfile"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env")

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
  restart           Restart all services
  status            Show container status
  logs [service]    Follow logs (service: caddy, xray or news-api)
  show-client       Print the generated VLESS import link
  backup            Create a private backup archive under backups/
  rotate --yes      Back up and replace UUID, Reality keys and short ID
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
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
  XRAY_IMAGE="${XRAY_IMAGE:-ghcr.io/xtls/xray-core:26.7.11}"
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
  [[ "$LOG_MAX_SIZE" =~ ^[1-9][0-9]*[kKmMgG]$ ]] || \
    die "LOG_MAX_SIZE must be a positive size such as 10m or 1g."
  [[ "$LOG_MAX_FILE" =~ ^[1-9][0-9]*$ ]] || \
    die "LOG_MAX_FILE must be a positive integer."
}

require_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
  docker info >/dev/null 2>&1 || die "Docker daemon is not available to the current user."
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
  local client_label

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
  sed \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__ACME_EMAIL_OPTION__|$acme_email_option|g" \
    "$ROOT_DIR/templates/Caddyfile.tpl" >"$CADDY_FILE"

  client_label="$(url_encode "$CLIENT_NAME")"
  printf '%s\n' \
    "vless://${UUID}@${DOMAIN}:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${DOMAIN}&fp=chrome&pbk=${REALITY_PASSWORD}&sid=${SHORT_ID}&type=tcp#${client_label}" \
    >"$CLIENT_FILE"

  # The official Xray image runs as a non-root user. The rendered config must
  # therefore be world-readable inside the bind mount. Its parent directories
  # remain mode 0700 on the host, so other host users cannot traverse to it.
  chmod 600 "$CREDENTIALS_FILE" "$CLIENT_FILE"
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
  load_env
  require_docker
  load_credentials
  check_ports
  check_dns
  validate_configuration
  "${COMPOSE[@]}" up -d
  "${COMPOSE[@]}" ps
  info "Direct website: https://$DOMAIN"
  info "Client link: ./manage.sh show-client"
}

backup_state() {
  local timestamp archive

  load_env
  load_credentials
  require_command tar
  timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
  mkdir -p "$ROOT_DIR/backups"
  archive="$ROOT_DIR/backups/vless-reality-$timestamp.tar.gz"
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

  info "Credentials rotated. Import the new link from './manage.sh show-client'."
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
      "${COMPOSE[@]}" down
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
    logs)
      load_env
      require_docker
      if [[ -n "${2:-}" && "${2:-}" != "caddy" && "${2:-}" != "xray" && "${2:-}" != "news-api" ]]; then
        die "Service must be 'caddy', 'xray' or 'news-api'."
      fi
      "${COMPOSE[@]}" logs --tail=100 --follow ${2:+"$2"}
      ;;
    show-client)
      [[ -f "$CLIENT_FILE" ]] || die "Client link is missing. Run: ./manage.sh init"
      cat "$CLIENT_FILE"
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
