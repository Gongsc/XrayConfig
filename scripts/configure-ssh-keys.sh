#!/usr/bin/env bash

set -Eeuo pipefail

DRY_RUN=false
CONFIG_FILE=/etc/ssh/sshd_config
WORK_DIR=""
BACKUP_DIR=""
COMMITTED=false
CHANGED_INDEXES=()
WRITTEN_INDEXES=()

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/configure-ssh-keys.sh [options]

Disable password and keyboard-interactive SSH authentication, enable public-key
authentication, and require AuthenticationMethods publickey. Update sshd_config
and existing *.conf files in sshd_config.d, including their Match blocks.
Back up changed files and restore them if writing or validation fails.
The SSH service is never restarted or reloaded.

Options:
  --dry-run       Show configuration diffs without writing to /etc/ssh
  --config PATH   Use another main config (drop-ins are read from PATH.d)
  -h, --help      Show this help

Optional environment variable:
  SSHD_BIN        Path to sshd (normally auto-detected)

Install and test your public key before manually applying the service changes.
Existing UsePAM, PermitRootLogin and authorized-key settings are preserved.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --config)
      (($# >= 2)) || die "--config requires an absolute path."
      CONFIG_FILE="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$CONFIG_FILE" == /* ]] || die "--config must be an absolute path."
if [[ "$DRY_RUN" != true && "$(id -u)" -ne 0 ]]; then
  die "Run this script as root, normally with sudo."
fi

[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || die "Expected a regular, non-symlink config: $CONFIG_FILE"
CONFIG_FILE="$(cd -- "$(dirname -- "$CONFIG_FILE")" && pwd -P)/$(basename -- "$CONFIG_FILE")"
DROPIN_DIR="$CONFIG_FILE.d"
CONFIG_FILES=("$CONFIG_FILE")
if [[ -e "$DROPIN_DIR" || -L "$DROPIN_DIR" ]]; then
  [[ -d "$DROPIN_DIR" && ! -L "$DROPIN_DIR" ]] || die "Expected a non-symlink directory: $DROPIN_DIR"
  shopt -s nullglob dotglob
  for file in "$DROPIN_DIR"/*.conf; do
    [[ -f "$file" && ! -L "$file" ]] || die "Expected a regular, non-symlink drop-in: $file"
    CONFIG_FILES+=("$file")
  done
  shopt -u nullglob dotglob
fi
for file in "${CONFIG_FILES[@]}"; do
  [[ -r "$file" ]] || die "Cannot read config: $file"
done

cleanup() {
  local status=$? index
  trap - EXIT HUP INT TERM
  if [[ "$COMMITTED" != true && ${#WRITTEN_INDEXES[@]} -gt 0 ]]; then
    warn "Restoring SSH configuration from $BACKUP_DIR"
    for index in "${WRITTEN_INDEXES[@]}"; do
      if ! cp -p -- "$BACKUP_DIR/$index" "${CONFIG_FILES[$index]}"; then
        warn "Restore failed for ${CONFIG_FILES[$index]}; backup: $BACKUP_DIR/$index"
        status=1
      fi
    done
  fi
  if [[ -n "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
WORK_DIR="$(mktemp -d)"

# Additional Include files could re-enable passwords inside Match blocks.
# Fail before writing if an existing include falls outside the requested scope.
check_includes() {
  local file="$1" pattern included canonical known candidate
  # Only conventional, unquoted keywords and unescaped Include paths are
  # supported. Reject other valid OpenSSH spellings rather than silently miss
  # an Include or an authentication directive during rewriting.
  awk '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      keyword = line
      sub(/[[:space:]=].*$/, "", keyword)
      if (keyword == "" || substr(keyword, 1, 1) == "#") next
      if (index(keyword, "\"") || index(keyword, sprintf("%c", 39)) || index(keyword, "\\")) exit 1
      if (tolower(keyword) != "include") next
      sub(/^[^[:space:]=]+[[:space:]=]+/, "", line)
      while (length(line)) {
        sub(/^[[:space:]]+/, "", line)
        if (line == "" || substr(line, 1, 1) == "#") break
        if (substr(line, 1, 1) == "\"") {
          line = substr(line, 2)
          end = index(line, "\"")
          if (!end) exit 1
          path = substr(line, 1, end - 1)
          line = substr(line, end + 1)
          if (length(line) && substr(line, 1, 1) !~ /[[:space:]]/) exit 1
        } else {
          match(line, /^[^[:space:]]+/)
          path = substr(line, 1, RLENGTH)
          line = substr(line, RLENGTH + 1)
          if (index(path, "\"")) exit 1
        }
        if (index(path, sprintf("%c", 39)) || index(path, "\\")) exit 1
        printf "%s%c", path, 0
      }
    }
  ' "$file" >"$WORK_DIR/includes" || die "Unsupported quoted/escaped keyword or Include path in $file. No files changed."
  while IFS= read -r -d '' pattern; do
    [[ "$pattern" == /* ]] || pattern="/etc/ssh/$pattern"
    while IFS= read -r included; do
      [[ -f "$included" && ! -L "$included" ]] || die "Unsupported included config: $included"
      canonical="$(cd -- "$(dirname -- "$included")" && pwd -P)/$(basename -- "$included")"
      known=false
      for candidate in "${CONFIG_FILES[@]}"; do
        if [[ "$canonical" == "$candidate" ]]; then known=true; break; fi
      done
      [[ "$known" == true ]] || die "Include outside sshd_config and its *.conf drop-ins: $included. No files changed."
    done < <(compgen -G "$pattern" || true)
  done <"$WORK_DIR/includes"
}
for file in "${CONFIG_FILES[@]}"; do check_includes "$file"; done

if [[ "$DRY_RUN" != true ]]; then
  SSHD_BIN="${SSHD_BIN:-$(command -v sshd || true)}"
  if [[ -z "$SSHD_BIN" && -x /usr/sbin/sshd ]]; then SSHD_BIN=/usr/sbin/sshd; fi
  [[ -n "$SSHD_BIN" && -x "$SSHD_BIN" ]] || die "Cannot find sshd. Set SSHD_BIN to its executable path."
  "$SSHD_BIN" -t -f "$CONFIG_FILE" || die "Existing SSH configuration failed validation. No files changed."
fi

cat >"$WORK_DIR/policy" <<'EOF'
# Managed by configure-ssh-keys.sh
PasswordAuthentication no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
AuthenticationMethods publickey
EOF

for index in "${!CONFIG_FILES[@]}"; do
  file="${CONFIG_FILES[$index]}"
  skip_lines=0
  if [[ "$index" -eq 0 ]]; then
    if head -n 6 "$file" | cmp -s "$WORK_DIR/policy" -; then skip_lines=6; fi
    cat "$WORK_DIR/policy" >"$WORK_DIR/$index"
  else
    : >"$WORK_DIR/$index"
  fi
  awk -v skip_lines="$skip_lines" '
    BEGIN {
      values["passwordauthentication"] = "PasswordAuthentication no"
      values["pubkeyauthentication"] = "PubkeyAuthentication yes"
      values["kbdinteractiveauthentication"] = "KbdInteractiveAuthentication no"
      values["challengeresponseauthentication"] = "ChallengeResponseAuthentication no"
      values["authenticationmethods"] = "AuthenticationMethods publickey"
    }
    NR <= skip_lines { next }
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      keyword = line
      sub(/[[:space:]=].*$/, "", keyword)
      replacement = values[tolower(keyword)]
      if (replacement != "") {
        match($0, /^[[:space:]]*/)
        indent = substr($0, 1, RLENGTH)
        comment = index(line, "#")
        print indent replacement (comment ? " " substr(line, comment) : "")
      } else {
        print
      }
    }
  ' "$file" >>"$WORK_DIR/$index"
  if ! cmp -s "$file" "$WORK_DIR/$index"; then CHANGED_INDEXES+=("$index"); fi
done

if [[ "$DRY_RUN" == true ]]; then
  if ((${#CHANGED_INDEXES[@]})); then
    for index in "${CHANGED_INDEXES[@]}"; do
      info "Planned changes: ${CONFIG_FILES[$index]}"
      diff -u "${CONFIG_FILES[$index]}" "$WORK_DIR/$index" || [[ "$?" -eq 1 ]]
    done
  else
    info "SSH authentication settings already match; no changes planned."
  fi
  info "Dry run completed. No configuration files changed; SSH was not restarted or reloaded."
  exit 0
fi

if ((${#CHANGED_INDEXES[@]})); then
  BACKUP_DIR="$(mktemp -d "$(dirname -- "$CONFIG_FILE")/.ssh-key-auth-backup-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
  for index in "${CHANGED_INDEXES[@]}"; do
    cp -p -- "${CONFIG_FILES[$index]}" "$BACKUP_DIR/$index"
    printf '%s\t%s\n' "$index" "${CONFIG_FILES[$index]}" >>"$BACKUP_DIR/manifest.tsv"
  done
  info "Backups and file mapping: $BACKUP_DIR"
  for index in "${CHANGED_INDEXES[@]}"; do
    # Record before writing, so a failed or interrupted write is also restored.
    WRITTEN_INDEXES+=("$index")
    cat "$WORK_DIR/$index" >"${CONFIG_FILES[$index]}"
    info "Updated ${CONFIG_FILES[$index]}"
  done
else
  info "SSH authentication settings already match; no files changed."
fi

"$SSHD_BIN" -t -f "$CONFIG_FILE" || die "Updated SSH configuration failed validation."
effective="$("$SSHD_BIN" -T -f "$CONFIG_FILE")" || die "Could not inspect the effective SSH configuration."
for expected in 'passwordauthentication no' 'pubkeyauthentication yes' \
  'kbdinteractiveauthentication no' 'authenticationmethods publickey'; do
  grep -Fxq "$expected" <<<"$effective" || die "Effective SSH setting differs from: $expected"
done

COMMITTED=true
info "SSH configuration validated: password login disabled, public-key login enabled."
info "SSH was not restarted or reloaded. Test your key and apply the service changes manually when ready."
