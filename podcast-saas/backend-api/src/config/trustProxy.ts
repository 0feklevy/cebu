/**
 * The number of trusted proxy hops in front of this process — the single source of truth for
 * both `server.ts` and the tests that prove forwarded-header handling is safe.
 *
 * It lives in its own module deliberately. The proxy suite used to declare its own local
 * `PROD_TRUST_PROXY = 1` and build its Fastify instance from that, so the suite proved a claim
 * about a number the production server did not have to share: reverting `server.ts` to
 * `trustProxy: true` — the exact vulnerability the suite exists to prevent — left it fully green.
 * Importing this constant means the tests exercise whatever production actually configures.
 * (`server.ts` cannot be imported by a test: it opens listeners and database connections.)
 *
 * WHY 1, NOT `true`:
 * `true` trusts the whole X-Forwarded-For chain and takes the LEFTMOST entry, which the caller
 * writes. Every IP-keyed rate limit would then be keyed on a value the caller chooses — one forged
 * header per request puts every request in its own bucket, which is not a weaker bound but no
 * bound at all.
 *
 * The production topology is a single VM where nginx terminates TLS and is the ONLY hop in front
 * of this process (deploy/docker-compose.yml — nginx alone binds 80/443; the API is reachable only
 * on a private Docker network). nginx forwards `X-Forwarded-For: $proxy_add_x_forwarded_for`,
 * which APPENDS the real peer to whatever the caller sent, so the true client is always the entry
 * nginx appended and `1` selects exactly that.
 *
 * IF A SECOND PROXY IS EVER PUT IN FRONT (a CDN, an ALB), THIS NUMBER MUST CHANGE TO MATCH THE HOP
 * COUNT, or `request.ip` becomes spoofable again. Changing it is a deployment-topology decision,
 * not a code-style one.
 */
export const TRUST_PROXY_HOPS = 1;
