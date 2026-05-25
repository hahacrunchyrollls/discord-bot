#!/usr/bin/env bash
set -euo pipefail

APP_NAME="discord-music-bot"
REPO_URL="https://github.com/hahacrunchyrollls/discord-bot.git"
REPO_BRANCH="${REPO_BRANCH:-}"
DEFAULT_INSTALL_DIR="/opt/${APP_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
APP_DIR="${APP_DIR:-${SCRIPT_DIR}}"
SERVICE_NAME="${APP_NAME}.service"
NODE_MAJOR="20"
RUN_USER="${SUDO_USER:-root}"
RUN_GROUP="$(id -gn "${RUN_USER}")"

log() {
  printf '\n[%s] %s\n' "$APP_NAME" "$*"
}

env_quote() {
  local value="${1}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  printf '"%s"' "${value}"
}

require_debian() {
  if [[ ! -f /etc/debian_version ]]; then
    echo "This installer is intended for Debian-based systems."
    exit 1
  fi
}

require_root_for_system() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run this installer with sudo: sudo bash install-debian13.sh"
    exit 1
  fi
}

install_system_packages() {
  log "Updating apt and installing required packages..."
  apt-get update
  apt-get install -y ca-certificates curl git gnupg ffmpeg python3 build-essential
}

install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "${current_major}" -ge "${NODE_MAJOR}" ]]; then
      log "Node.js $(node --version) is already installed."
      return
    fi
  fi

  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

prepare_app_directory() {
  if [[ -f "${APP_DIR}/package.json" ]]; then
    log "Using existing app directory: ${APP_DIR}"
    return
  fi

  APP_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"

  if [[ -d "${APP_DIR}/.git" ]]; then
    log "Updating existing repository in ${APP_DIR}..."
    if [[ -n "${REPO_BRANCH}" ]]; then
      git -C "${APP_DIR}" fetch origin "${REPO_BRANCH}"
      git -C "${APP_DIR}" checkout "${REPO_BRANCH}"
      git -C "${APP_DIR}" pull --ff-only origin "${REPO_BRANCH}"
    else
      git -C "${APP_DIR}" pull --ff-only
    fi
    return
  fi

  if [[ -e "${APP_DIR}" ]]; then
    echo "${APP_DIR} already exists but is not a git repository."
    echo "Set INSTALL_DIR to another path or move the existing directory."
    exit 1
  fi

  log "Cloning ${REPO_URL} to ${APP_DIR}..."
  if [[ -n "${REPO_BRANCH}" ]]; then
    git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}"
  else
    git clone "${REPO_URL}" "${APP_DIR}"
  fi
}

install_dependencies() {
  log "Installing bot dependencies..."
  cd "${APP_DIR}"
  chown -R "${RUN_USER}:${RUN_GROUP}" "${APP_DIR}"
  if [[ "${RUN_USER}" == "root" ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci --omit=dev
    else
      npm install --omit=dev
    fi
  else
    if [[ -f package-lock.json ]]; then
      runuser -u "${RUN_USER}" -- npm ci --omit=dev
    else
      runuser -u "${RUN_USER}" -- npm install --omit=dev
    fi
  fi
}

prepare_env_file() {
  cd "${APP_DIR}"
  if [[ -f .env ]]; then
    log ".env already exists."
    read -r -p "Do you want to replace it with new values? [y/N]: " replace_env
    if [[ ! "${replace_env}" =~ ^[Yy]$ ]]; then
      log "Keeping your current .env settings."
      return
    fi
  fi

  log "Enter your bot environment variables."
  read -r -p "DISCORD_TOKEN: " discord_token
  read -r -p "CLIENT_ID: " client_id
  read -r -p "SPOTIFY_CLIENT_ID: " spotify_client_id
  read -r -s -p "SPOTIFY_CLIENT_SECRET: " spotify_client_secret
  printf '\n'

  cat > .env <<EOF
DISCORD_TOKEN=$(env_quote "${discord_token}")
CLIENT_ID=$(env_quote "${client_id}")
SPOTIFY_CLIENT_ID=$(env_quote "${spotify_client_id}")
SPOTIFY_CLIENT_SECRET=$(env_quote "${spotify_client_secret}")
PORT=3000
EOF

  chmod 600 .env
  chown "${RUN_USER}:${RUN_GROUP}" .env
  log "Saved environment variables to ${APP_DIR}/.env"
}

create_systemd_service() {
  log "Creating systemd service ${SERVICE_NAME}..."
  cat > "/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=Discord Music Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=$(command -v npm) start
Restart=always
RestartSec=10
User=${RUN_USER}
Group=${RUN_GROUP}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
}

print_next_steps() {
  cat <<EOF

Installation finished.

Next steps:
1. Edit your environment variables:
   nano ${APP_DIR}/.env

2. Start the bot:
   sudo systemctl start ${SERVICE_NAME}

3. Check logs:
   sudo journalctl -u ${SERVICE_NAME} -f

4. Restart after code or .env changes:
   sudo systemctl restart ${SERVICE_NAME}

EOF
}

main() {
  require_debian
  require_root_for_system
  install_system_packages
  install_nodejs
  prepare_app_directory
  install_dependencies
  prepare_env_file
  create_systemd_service
  print_next_steps
}

main "$@"
