#!/usr/bin/env bash
#
# provision.sh — first-time setup for a fresh Ubuntu VM (run once, as ubuntu user).
# Installs Docker Engine + the compose plugin, enables the service, ensures a swapfile
# (so builds aren't OOM-killed on small VMs), opens the firewall for 80/443, and
# installs the optional systemd unit.
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

# --- swap (so image builds don't get OOM-killed on small VMs) ----------------
# The Next.js + backend builds are memory-hungry. On a 2–4 GB instance the build
# can be OOM-killed ("signal: killed"). Ensure adequate swap exists as a safety net.
# Idempotent and reboot-safe: fixes a half-created /swapfile, re-persists fstab, and
# only skips when EXISTING swap already meets the target size.

# Persist /swapfile in fstab + set a build-friendly swappiness (idempotent).
persist_swap() {
  grep -q '^/swapfile[[:space:]]' /etc/fstab \
    || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  sudo sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true
  # Replace any existing vm.swappiness line, else append (keep runtime == persisted).
  if grep -qE '^\s*vm\.swappiness' /etc/sysctl.conf 2>/dev/null; then
    sudo sed -i -E 's/^\s*vm\.swappiness.*/vm.swappiness=10/' /etc/sysctl.conf
  else
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
  fi
}

# (Re)format /swapfile as a swap area and enable it.
format_and_enable_swap() {
  sudo swapoff /swapfile 2>/dev/null || true
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null || die "mkswap /swapfile failed"
  sudo swapon /swapfile || die "swapon /swapfile failed"
}

ensure_swap() {
  local ram_mb size_gb free_gb active_mb
  ram_mb="$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || true)";  ram_mb="${ram_mb:-0}"
  # Target ~2x RAM capped at 4 GB (2 GB if the box already has >=4 GB RAM).
  size_gb=4; [ "${ram_mb}" -ge 4096 ] && size_gb=2

  # Skip only if ACTIVE swap already meets the target (presence != adequacy; a tiny
  # zram device shouldn't count as "done").
  active_mb="$(free -m 2>/dev/null | awk '/^Swap:/{print $2}' || true)"; active_mb="${active_mb:-0}"
  if [ "${active_mb}" -ge $(( size_gb * 1024 )) ]; then
    ok "Swap already adequate: ${active_mb}MB active."
    return
  fi

  # A leftover /swapfile may be valid-but-off, or half-created/invalid — handle both.
  if [ -e /swapfile ]; then
    if sudo swapon /swapfile 2>/dev/null; then
      persist_swap
      ok "Enabled existing /swapfile. Swap now: $(free -m | awk '/^Swap:/{print $2}')MB."
      return
    fi
    warn "/swapfile exists but is not a usable swap area — reformatting it."
    format_and_enable_swap
    persist_swap
    ok "Repaired /swapfile. Swap now: $(free -m | awk '/^Swap:/{print $2}')MB."
    return
  fi

  # Create fresh. Require free disk >= size + 1 GB (non-fatal parse).
  free_gb="$(df -PBG / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}' || true)"; free_gb="${free_gb:-0}"
  if [ "${free_gb}" -lt $(( size_gb + 1 )) ]; then
    warn "Only ${free_gb}G free on / — skipping swap creation. Free disk or add swap manually,"
    warn "then re-run this script. (A >=30 GB root volume is recommended for Docker builds.)"
    return
  fi

  log "Creating a ${size_gb}G swapfile (RAM=${ram_mb}MB)…"
  if ! sudo fallocate -l "${size_gb}G" /swapfile 2>/dev/null; then
    sudo dd if=/dev/zero of=/swapfile bs=1M count=$(( size_gb * 1024 )) status=none
  fi
  format_and_enable_swap
  persist_swap
  ok "Swap enabled: $(free -m | awk '/^Swap:/{print $2}')MB active."
}
ensure_swap

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
