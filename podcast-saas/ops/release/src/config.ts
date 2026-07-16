/**
 * Central deterministic configuration for the release system.
 *
 * Everything the pipeline needs to know about THIS application lives here — one
 * reviewed, versioned source of truth. No values are read from AI, and secrets are
 * never present: only public origins, image names, thresholds, and policies.
 */

export const SERVICES = ['backend', 'client-web', 'admin-web'] as const;
export type Service = (typeof SERVICES)[number];

/** Docker-internal hostnames that must never be browser-visible. */
export const DOCKER_SERVICE_HOSTS = ['backend', 'worker', 'nginx', 'client-web', 'admin-web'] as const;

export interface ReleaseConfig {
  /** GitHub repository (owner/name). */
  githubRepo: string;
  /** Application root inside the monorepo. */
  appDir: string;
  /** Container registry host. */
  registry: string;
  /** GHCR namespace all release images are pushed under. */
  imageNamespace: string;
  /** Local image prefix used by docker-compose on the VM (podcast-saas/<svc>:<version>). */
  localImagePrefix: string;
  services: readonly Service[];
  endpoints: {
    app: string;
    api: string;
    admin: string;
    apiHealth: string;
  };
  csp: {
    /** Firebase Auth iframe host — its exact https origin must be allowed by frame-src. */
    firebaseAuthDomain: string;
    stripeJsOrigin: string;
  };
  migrations: {
    /** Migration SQL directory, relative to the app root. */
    dir: string;
    /** The runner whose hardcoded list must stay in sync with the directory. */
    runnerSource: string;
    /** Canonical migration filename shape. */
    filePattern: RegExp;
    /** Files in the directory that are intentionally NOT run by the runner. */
    excluded: readonly string[];
  };
  backfill: {
    backupTable: string;
    /** Default ceiling for rows a data repair may touch without explicit approval. */
    maxAffectedRowsDefault: number;
  };
  certExpiry: {
    warnDays: number;
    criticalDays: number;
  };
}

export const RELEASE_CONFIG: ReleaseConfig = {
  githubRepo: '0feklevy/cebu',
  appDir: 'podcast-saas',
  registry: 'ghcr.io',
  imageNamespace: 'ghcr.io/0feklevy/cebu',
  localImagePrefix: 'podcast-saas',
  services: SERVICES,
  endpoints: {
    app: 'https://flowvidco.com',
    api: 'https://api.flowvidco.com',
    admin: 'https://admin.flowvidco.com',
    apiHealth: 'https://api.flowvidco.com/health',
  },
  csp: {
    firebaseAuthDomain: 'cebu-1a10f.firebaseapp.com',
    stripeJsOrigin: 'https://js.stripe.com',
  },
  migrations: {
    dir: 'backend-api/src/db/migrations',
    runnerSource: 'backend-api/src/db/migrate.ts',
    filePattern: /^\d{3}_[a-z0-9_]+\.sql$/i,
    excluded: ['phase2-schema.sql'],
  },
  backfill: {
    backupTable: '_url_backfill_backup',
    maxAffectedRowsDefault: 50,
  },
  certExpiry: {
    warnDays: 21,
    criticalDays: 7,
  },
};

/** GHCR repository for a service, e.g. ghcr.io/0feklevy/cebu/backend. */
export function imageRepository(cfg: ReleaseConfig, service: Service): string {
  return `${cfg.imageNamespace}/${service}`;
}

/** Local compose tag for a service at a version, e.g. podcast-saas/backend:v0.1.2. */
export function localImageTag(cfg: ReleaseConfig, service: Service, version: string): string {
  return `${cfg.localImagePrefix}/${service}:${version}`;
}
