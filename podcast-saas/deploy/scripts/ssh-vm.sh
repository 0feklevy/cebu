#!/usr/bin/env bash
#
# ssh-vm.sh — convenience wrapper to SSH into the deployment VM from your laptop.
# Run from your LOCAL machine (the repo root), NOT from the VM.
#
# The private key is expected at keys/Cebu_key1.pem and is NEVER read/echoed by
# this script — only passed to ssh via -i. Override host/user/key with env vars.
#
# Usage:
#   ./deploy/scripts/ssh-vm.sh                       # open an interactive shell
#   ./deploy/scripts/ssh-vm.sh 'cd ~/podcast-saas && ./deploy/scripts/health-check.sh'
#   VM_HOST=1.2.3.4 ./deploy/scripts/ssh-vm.sh

set -euo pipefail

VM_USER="${VM_USER:-ubuntu}"
VM_HOST="${VM_HOST:-44.225.68.155}"
VM_KEY="${VM_KEY:-keys/Cebu_key1.pem}"

[ -f "${VM_KEY}" ] || { echo "SSH key not found at ${VM_KEY} (set VM_KEY=...)." >&2; exit 1; }
chmod 600 "${VM_KEY}" 2>/dev/null || true

if [ "$#" -gt 0 ]; then
  exec ssh -i "${VM_KEY}" -o StrictHostKeyChecking=accept-new "${VM_USER}@${VM_HOST}" "$@"
else
  exec ssh -i "${VM_KEY}" -o StrictHostKeyChecking=accept-new "${VM_USER}@${VM_HOST}"
fi
