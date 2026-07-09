#!/usr/bin/env bash
#
# init-ssl.sh — one-time Let's Encrypt bootstrap.
#
# Problem: the nginx vhost references certificate files that don't exist yet, so
# nginx can't start to serve the ACME HTTP-01 challenge. Standard fix:
#   1. Write throwaway self-signed certs so nginx can boot.
#   2. Start nginx (only nginx, via --no-deps) serving /.well-known/acme-challenge.
#   3. Delete the dummies and request real certs per domain via the certbot webroot.
#   4. Reload nginx with the real certificates.
#
# Re-runnable. Run this BEFORE the first ./deploy.sh, after DNS A-records for all
# three subdomains point at this VM.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

require_env_file

EMAIL="$(env_get LETSENCRYPT_EMAIL)"
STAGING="$(env_get LETSENCRYPT_STAGING)"
DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
DOMAIN_WWW="$(env_get DOMAIN_WWW)"
DOMAIN_APP="$(env_get DOMAIN_APP)"
DOMAIN_API="$(env_get DOMAIN_API)"
DOMAIN_ADMIN="$(env_get DOMAIN_ADMIN)"

[ -n "${EMAIL}" ]       || die "LETSENCRYPT_EMAIL not set in deploy/.env"
[ -n "${DOMAIN_ROOT}" ] || die "DOMAIN_ROOT not set in deploy/.env"
[ -n "${DOMAIN_API}" ]  || die "DOMAIN_API not set in deploy/.env"

# Certificate lineages: "LINEAGE_NAME | space-separated SAN list".
# The frontend names share one SAN cert stored under live/<DOMAIN_ROOT>/.
CERTS=(
  "${DOMAIN_ROOT}|${DOMAIN_ROOT} ${DOMAIN_WWW} ${DOMAIN_APP}"
  "${DOMAIN_API}|${DOMAIN_API}"
)
# admin is optional — only request it if a subdomain is configured.
[ -n "${DOMAIN_ADMIN}" ] && CERTS+=("${DOMAIN_ADMIN}|${DOMAIN_ADMIN}")

staging_arg=""
if [ "${STAGING}" = "1" ]; then
  warn "Using Let's Encrypt STAGING (untrusted certs, high rate limits)."
  staging_arg="--staging"
fi

# --- 1. dummy certs so nginx can start --------------------------------------
log "Writing throwaway certificates so nginx can boot…"
for entry in "${CERTS[@]}"; do
  lineage="${entry%%|*}"
  compose run --rm --entrypoint sh certbot -c "
    mkdir -p /etc/letsencrypt/live/${lineage} &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /etc/letsencrypt/live/${lineage}/privkey.pem \
      -out    /etc/letsencrypt/live/${lineage}/fullchain.pem \
      -subj '/CN=${lineage}'"
done

# --- 2. start nginx alone ----------------------------------------------------
log "Starting nginx (no app dependencies) to serve the ACME challenge…"
compose up -d --no-deps nginx
sleep 3
compose exec -T nginx nginx -t || die "nginx config test failed — check deploy/nginx/*."
compose exec -T nginx nginx -s reload || true

# --- 3. request real certs ---------------------------------------------------
for entry in "${CERTS[@]}"; do
  lineage="${entry%%|*}"
  sans="${entry#*|}"
  # Build the -d flags from the SAN list.
  d_args=""
  for name in ${sans}; do d_args="${d_args} -d ${name}"; done

  log "Requesting certificate '${lineage}' for:${sans}"
  # Remove the dummy so certbot writes a fresh lineage at the same path.
  compose run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/${lineage} /etc/letsencrypt/archive/${lineage} /etc/letsencrypt/renewal/${lineage}.conf" || true
  if ! compose run --rm certbot certonly --webroot -w /var/www/certbot \
        --email "${EMAIL}" --agree-tos --no-eff-email ${staging_arg} \
        --cert-name "${lineage}" ${d_args}; then
    die "Certbot failed for '${lineage}'. Check DNS (${sans}) -> this VM and that port 80 is open."
  fi
  ok "Certificate '${lineage}' issued."
done

# --- 4. reload with real certs ----------------------------------------------
compose exec -T nginx nginx -s reload
ok "SSL bootstrap complete. Certificates auto-renew via the 'certbot' service."
log "You can now run ./scripts/deploy.sh to build and launch the app."
