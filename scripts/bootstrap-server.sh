#!/usr/bin/env bash

set -Eeuo pipefail

DRY_RUN=false
REPLACE_DISTRO_DOCKER=false
ADD_DOCKER_GROUP=true
DOCKER_USER="${DOCKER_USER:-${SUDO_USER:-}}"

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
Usage: sudo ./scripts/bootstrap-server.sh [options]

Installs and configures:
  - Docker Engine and Compose from Docker's official APT repository
  - UFW with SSH, TCP 80 and TCP 443 allowed
  - Fail2Ban with an SSH jail and UFW ban actions
  - TCP BBR congestion control with the fq queueing discipline

Options:
  --replace-distro-docker  Remove conflicting distro Docker/containerd packages
  --no-docker-group       Do not add the invoking sudo user to the docker group
  --dry-run               Print planned changes without modifying the server
  -h, --help              Show this help

Optional environment variables:
  SSH_PORTS="22,2222"       Override auto-detected SSH TCP ports
  EXTRA_TCP_PORTS="8080"    Additional inbound TCP ports to allow
  EXTRA_UDP_PORTS="51820"   Additional inbound UDP ports to allow
  DOCKER_USER="name"        User to add to the docker group
  FAIL2BAN_BANTIME="1h"     Ban duration (default: 1h)
  FAIL2BAN_FINDTIME="10m"   Retry observation window (default: 10m)
  FAIL2BAN_MAXRETRY="5"     Failed SSH attempts before banning (default: 5)
EOF
}

while (($#)); do
  case "$1" in
    --replace-distro-docker) REPLACE_DISTRO_DOCKER=true ;;
    --no-docker-group) ADD_DOCKER_GROUP=false ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

if [[ "$DRY_RUN" != true && "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "Run this script as root, normally with sudo."
fi

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '[DRY-RUN]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

install_text_file() {
  local mode="$1"
  local target="$2"
  local content="$3"
  local temp_file backup_target

  if [[ "$DRY_RUN" == true ]]; then
    info "Would install $target with mode $mode:"
    printf '%s\n' "$content"
    return
  fi

  temp_file="$(mktemp)"
  printf '%s\n' "$content" >"$temp_file"
  if [[ -f "$target" ]] && ! cmp -s "$temp_file" "$target"; then
    backup_target="$target.backup-$(date -u +'%Y%m%dT%H%M%SZ')"
    cp -a -- "$target" "$backup_target"
    warn "Backed up the previous $target to $backup_target"
  fi
  install -D -m "$mode" "$temp_file" "$target"
  rm -f -- "$temp_file"
}

configure_bbr() {
  local available active qdisc
  local module_config="tcp_bbr"
  local sysctl_config="# Managed by vless-reality bootstrap-server.sh
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr"

  if [[ "$DRY_RUN" == true ]]; then
    run modprobe tcp_bbr
    install_text_file 0644 /etc/modules-load.d/vless-reality-bbr.conf "$module_config"
    install_text_file 0644 /etc/sysctl.d/99-vless-reality-bbr.conf "$sysctl_config"
    run sysctl --load /etc/sysctl.d/99-vless-reality-bbr.conf
    info "Would verify that BBR is available and active with fq."
    return
  fi

  if ! modprobe tcp_bbr; then
    available="$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || true)"
    [[ " $available " == *" bbr "* ]] || \
      die "This kernel does not provide TCP BBR. Install a supported host kernel before retrying."
    warn "modprobe tcp_bbr failed, but BBR is built into the running kernel; continuing."
  fi

  available="$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || true)"
  [[ " $available " == *" bbr "* ]] || \
    die "TCP BBR is not listed by the running kernel: ${available:-none}."

  install_text_file 0644 /etc/modules-load.d/vless-reality-bbr.conf "$module_config"
  install_text_file 0644 /etc/sysctl.d/99-vless-reality-bbr.conf "$sysctl_config"
  run sysctl --load /etc/sysctl.d/99-vless-reality-bbr.conf

  active="$(sysctl -n net.ipv4.tcp_congestion_control)"
  qdisc="$(sysctl -n net.core.default_qdisc)"
  [[ "$active" == "bbr" ]] || die "BBR configuration did not become active (current: $active)."
  [[ "$qdisc" == "fq" ]] || die "fq did not become the default queueing discipline (current: $qdisc)."
  info "TCP BBR is enabled and active with the fq queueing discipline."
}

package_is_installed() {
  dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null | grep -q '^ii'
}

normalize_ports() {
  local raw="$1"
  local token port_number

  tr ',;' '  ' <<<"$raw" | tr -s '[:space:]' '\n' | while IFS= read -r token; do
    [[ -z "$token" ]] && continue
    [[ "$token" =~ ^[0-9]+$ ]] || die "Invalid port: $token"
    port_number="$((10#$token))"
    ((port_number >= 1 && port_number <= 65535)) || die "Port out of range: $token"
    printf '%s\n' "$port_number"
  done | sort -nu
}

detect_ssh_ports() {
  local detected=""
  local sshd_bin=""

  if [[ -n "${SSH_PORTS:-}" ]]; then
    detected="$(normalize_ports "$SSH_PORTS")"
  elif [[ -n "${SSH_CONNECTION:-}" ]]; then
    detected="$(awk '{print $4}' <<<"$SSH_CONNECTION")"
    detected="$(normalize_ports "$detected")"
  else
    if command -v sshd >/dev/null 2>&1; then
      sshd_bin="$(command -v sshd)"
    elif [[ -x /usr/sbin/sshd ]]; then
      sshd_bin=/usr/sbin/sshd
    fi

    if [[ -n "$sshd_bin" ]]; then
      detected="$($sshd_bin -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -nu || true)"
    fi
  fi

  [[ -n "$detected" ]] || die "Could not safely detect the SSH port. Re-run with SSH_PORTS=22 (or the actual port)."
  normalize_ports "$detected"
}

if [[ ! -r /etc/os-release ]]; then
  die "This script supports Ubuntu and Debian systems with /etc/os-release."
fi

# shellcheck disable=SC1091
source /etc/os-release
DISTRO_ID="${ID:-}"
case "$DISTRO_ID" in
  ubuntu)
    DOCKER_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
    ;;
  debian)
    DOCKER_CODENAME="${VERSION_CODENAME:-}"
    ;;
  *)
    die "Unsupported distribution: ${PRETTY_NAME:-$DISTRO_ID}. Only Ubuntu and Debian are supported."
    ;;
esac
[[ -n "$DOCKER_CODENAME" ]] || die "Could not determine the distribution codename."

ARCHITECTURE="$(dpkg --print-architecture)"
SSH_PORT_OUTPUT="$(detect_ssh_ports)" || die "SSH port detection failed."
mapfile -t SSH_PORT_LIST <<<"$SSH_PORT_OUTPUT"

EXTRA_TCP_PORT_OUTPUT="$(normalize_ports "${EXTRA_TCP_PORTS:-}")" || die "EXTRA_TCP_PORTS is invalid."
EXTRA_TCP_PORT_LIST=()
if [[ -n "$EXTRA_TCP_PORT_OUTPUT" ]]; then
  mapfile -t EXTRA_TCP_PORT_LIST <<<"$EXTRA_TCP_PORT_OUTPUT"
fi

EXTRA_UDP_PORT_OUTPUT="$(normalize_ports "${EXTRA_UDP_PORTS:-}")" || die "EXTRA_UDP_PORTS is invalid."
EXTRA_UDP_PORT_LIST=()
if [[ -n "$EXTRA_UDP_PORT_OUTPUT" ]]; then
  mapfile -t EXTRA_UDP_PORT_LIST <<<"$EXTRA_UDP_PORT_OUTPUT"
fi

info "Detected platform: ${PRETTY_NAME:-$DISTRO_ID} ($ARCHITECTURE, $DOCKER_CODENAME)"
info "SSH TCP ports to preserve: ${SSH_PORT_LIST[*]}"

FAIL2BAN_BANTIME="${FAIL2BAN_BANTIME:-1h}"
FAIL2BAN_FINDTIME="${FAIL2BAN_FINDTIME:-10m}"
FAIL2BAN_MAXRETRY="${FAIL2BAN_MAXRETRY:-5}"
[[ "$FAIL2BAN_BANTIME" =~ ^[1-9][0-9]*[smhdw]?$ ]] || die "FAIL2BAN_BANTIME must look like 3600, 30m, 1h or 1d."
[[ "$FAIL2BAN_FINDTIME" =~ ^[1-9][0-9]*[smhdw]?$ ]] || die "FAIL2BAN_FINDTIME must look like 600, 10m or 1h."
[[ "$FAIL2BAN_MAXRETRY" =~ ^[1-9][0-9]*$ ]] || die "FAIL2BAN_MAXRETRY must be a positive integer."

if [[ "$ADD_DOCKER_GROUP" == true && -n "$DOCKER_USER" && "$DOCKER_USER" != root ]]; then
  id "$DOCKER_USER" >/dev/null 2>&1 || die "DOCKER_USER does not exist: $DOCKER_USER"
fi

CONFLICTING_PACKAGES=(
  docker.io
  docker-compose
  docker-compose-v2
  docker-doc
  docker-buildx
  podman-docker
  containerd
  runc
)
INSTALLED_CONFLICTS=()
for package in "${CONFLICTING_PACKAGES[@]}"; do
  if package_is_installed "$package"; then
    INSTALLED_CONFLICTS+=("$package")
  fi
done

if ((${#INSTALLED_CONFLICTS[@]})); then
  if [[ "$REPLACE_DISTRO_DOCKER" != true ]]; then
    die "Conflicting distro packages are installed: ${INSTALLED_CONFLICTS[*]}. Back up existing Docker state, then re-run with --replace-distro-docker."
  fi
  warn "Removing conflicting distro packages: ${INSTALLED_CONFLICTS[*]}"
  run apt-get remove -y "${INSTALLED_CONFLICTS[@]}"
fi

export DEBIAN_FRONTEND=noninteractive
run apt-get update
run apt-get install -y ca-certificates curl ufw fail2ban kmod procps python3-systemd

if [[ "$DRY_RUN" != true && ! -f /etc/fail2ban/action.d/ufw.conf ]]; then
  die "The installed Fail2Ban package does not provide action.d/ufw.conf. No firewall rules have been changed."
fi

OFFICIAL_DOCKER_PACKAGES=(
  docker-ce
  docker-ce-cli
  containerd.io
  docker-buildx-plugin
  docker-compose-plugin
)
OFFICIAL_DOCKER_READY=true
for package in "${OFFICIAL_DOCKER_PACKAGES[@]}"; do
  if ! package_is_installed "$package"; then
    OFFICIAL_DOCKER_READY=false
    break
  fi
done

run install -m 0755 -d /etc/apt/keyrings
if [[ "$DRY_RUN" == true ]]; then
  info "Would download Docker's official signing key from https://download.docker.com/linux/$DISTRO_ID/gpg"
else
  docker_key_temp="$(mktemp)"
  curl -fsSL "https://download.docker.com/linux/$DISTRO_ID/gpg" -o "$docker_key_temp"
  install -m 0644 "$docker_key_temp" /etc/apt/keyrings/docker.asc
  rm -f -- "$docker_key_temp"
fi

DOCKER_SOURCE="Types: deb
URIs: https://download.docker.com/linux/$DISTRO_ID
Suites: $DOCKER_CODENAME
Components: stable
Architectures: $ARCHITECTURE
Signed-By: /etc/apt/keyrings/docker.asc"
install_text_file 0644 /etc/apt/sources.list.d/docker.sources "$DOCKER_SOURCE"

run apt-get update
if [[ "$OFFICIAL_DOCKER_READY" == true ]]; then
  info "The complete official Docker CE package set is already installed; skipped package replacement or upgrade."
else
  run apt-get install -y "${OFFICIAL_DOCKER_PACKAGES[@]}"
fi
run systemctl enable --now docker

if [[ "$ADD_DOCKER_GROUP" == true ]]; then
  if [[ -n "$DOCKER_USER" && "$DOCKER_USER" != root ]]; then
    run usermod -aG docker "$DOCKER_USER"
    warn "$DOCKER_USER was added to the docker group, which grants root-equivalent access. A new login session is required."
  else
    warn "No non-root sudo user was detected; skipped docker group membership."
  fi
fi

configure_bbr

run ufw default deny incoming
run ufw default allow outgoing
for port in "${SSH_PORT_LIST[@]}"; do
  run ufw allow "$port/tcp" comment 'SSH'
done
run ufw allow 80/tcp comment 'VLESS site HTTP and ACME'
run ufw allow 443/tcp comment 'VLESS REALITY and HTTPS fallback'
for port in "${EXTRA_TCP_PORT_LIST[@]}"; do
  run ufw allow "$port/tcp" comment 'Bootstrap extra TCP'
done
for port in "${EXTRA_UDP_PORT_LIST[@]}"; do
  run ufw allow "$port/udp" comment 'Bootstrap extra UDP'
done
run ufw --force enable
run systemctl enable --now ufw

SSH_PORT_CSV="$(IFS=,; printf '%s' "${SSH_PORT_LIST[*]}")"
FAIL2BAN_CONFIG="[DEFAULT]
backend = systemd
banaction = ufw
banaction_allports = ufw
bantime = $FAIL2BAN_BANTIME
findtime = $FAIL2BAN_FINDTIME
maxretry = $FAIL2BAN_MAXRETRY
usedns = no

[sshd]
enabled = true
mode = normal
port = $SSH_PORT_CSV"
install_text_file 0644 /etc/fail2ban/jail.d/vless-reality.local "$FAIL2BAN_CONFIG"

run fail2ban-client -t
run systemctl enable fail2ban
run systemctl restart fail2ban

if [[ "$DRY_RUN" != true ]]; then
  docker version >/dev/null
  docker compose version >/dev/null
  systemctl is-active --quiet docker || die "Docker did not become active."
  systemctl is-active --quiet fail2ban || die "Fail2Ban did not become active."
  [[ "$(sysctl -n net.ipv4.tcp_congestion_control)" == "bbr" ]] || die "BBR is no longer active."
  ufw status verbose
  fail2ban-client status sshd
fi

info "Server initialization completed. Allowed project ports: TCP 80 and TCP 443."
info "Review Docker's UFW caveat: only publish container ports that should be public."
