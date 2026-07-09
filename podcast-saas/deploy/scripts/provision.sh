#!/usr/bin/env bash
#
# provision.sh — first-time setup for a fresh Ubuntu VM (run once, as ubuntu user).
# Installs Docker Engine + the compose plugin, enables the service, opens the
# firewall for 80/443, and installs the optional systemd unit.
#
# Usage:  ./provision.sh        (safe to re-run; each step is idempotent)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

[ "$(id -u)" -ne 0 ] || die "Run as the 'ubuntu' user (it will sudo where needed), not root."

# --- Docker Engine + compose plugin -----------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed: $(docker --version)"
else
  log "Installing Docker Engine…"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker installed."
fi

# --- let 'ubuntu' run docker without sudo -----------------------------------
if ! id -nG "$USER" | grep -qw docker; then
  log "Adding ${USER} to the docker group…"
  sudo usermod -aG docker "$USER"
  warn "Log out and back in (or run 'newgrp docker') for group membership to take effect."
fi

sudo systemctl enable --now docker

# --- firewall (only if ufw is active) ---------------------------------------
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  log "Opening ports 22/80/443 in ufw…"
  sudo ufw allow 22/tcp  || true
  sudo ufw allow 80/tcp  || true
  sudo ufw allow 443/tcp || true
fi

warn "Also ensure the AWS Security Group for this instance allows inbound 80 and 443."

# --- optional systemd unit ---------------------------------------------------
UNIT_SRC="${DEPLOY_DIR}/systemd/podcast-saas.service"
if [ -f "${UNIT_SRC}" ]; then
  log "Installing systemd unit (auto-start the stack on boot)…"
  # Render the WorkingDirectory to this checkout's actual deploy dir.
  sudo sed "s#__DEPLOY_DIR__#${DEPLOY_DIR}#g; s#__USER__#${USER}#g" "${UNIT_SRC}" \
    | sudo tee /etc/systemd/system/podcast-saas.service > /dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable podcast-saas.service
  ok "systemd unit installed & enabled (starts stack on boot)."
fi

ok "Provisioning complete."
echo
log "Next steps:"
echo "  1) cp deploy/.env.example deploy/.env   && edit it"
echo "  2) cp .env.example .env                 && edit app secrets"
echo "  3) point DNS A-records for app/api/admin subdomains at this VM"
echo "  4) ./deploy/scripts/init-ssl.sh         # issue TLS certificates"
echo "  5) ./deploy/scripts/deploy.sh           # build & launch"
