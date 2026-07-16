/**
 * Immutable image manifest — the single source of truth for WHAT gets deployed.
 * Built right after `docker buildx --push` from the returned digests; the VM
 * pulls repo@digest (never a floating tag) and re-verifies before recreating
 * services. Rollback resolves a previous version's digests the same way.
 */
import { SERVICES, type ReleaseConfig, type Service } from './config.js';
import { finding, type Finding } from './severity.js';

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface ImageEntry {
  service: Service;
  repository: string;
  tag: string;
  digest: string;
}

export interface ImageManifest {
  schema: 'flowvid.image-manifest/v1';
  version: string;
  gitSha: string;
  builtAt?: string;
  images: ImageEntry[];
}

export function buildManifest(input: Omit<ImageManifest, 'schema'>): ImageManifest {
  return { schema: 'flowvid.image-manifest/v1', ...input };
}

export function parseManifest(json: string): ImageManifest {
  const m = JSON.parse(json) as ImageManifest;
  if (m.schema !== 'flowvid.image-manifest/v1') {
    throw new Error(`Unknown image-manifest schema: ${String((m as { schema?: unknown }).schema)}`);
  }
  return m;
}

/** repo@sha256:… — the only reference form the VM is allowed to pull. */
export function pinnedRef(entry: ImageEntry): string {
  return `${entry.repository}@${entry.digest}`;
}

export function validateManifest(manifest: ImageManifest, cfg: ReleaseConfig): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const e of manifest.images) {
    seen.add(e.service);
    if (!DIGEST_RE.test(e.digest)) {
      findings.push(finding('images.bad-digest', 'CRITICAL', 'images', `${e.service}: digest "${e.digest}" is not a valid sha256 digest.`));
    }
    if (!e.repository.startsWith(`${cfg.imageNamespace}/`)) {
      findings.push(
        finding('images.foreign-repository', 'CRITICAL', 'images', `${e.service}: repository ${e.repository} is outside the trusted namespace ${cfg.imageNamespace}.`),
      );
    }
    if (e.tag === 'latest') {
      findings.push(finding('images.floating-tag', 'CRITICAL', 'images', `${e.service}: floating "latest" tag is forbidden for deployment.`));
    }
    if (e.tag !== manifest.version && e.tag !== `sha-${manifest.gitSha}`) {
      findings.push(
        finding('images.tag-mismatch', 'HIGH', 'images', `${e.service}: tag ${e.tag} matches neither ${manifest.version} nor sha-${manifest.gitSha}.`),
      );
    }
  }

  for (const svc of SERVICES) {
    if (!seen.has(svc)) {
      findings.push(finding('images.missing-service', 'CRITICAL', 'images', `Manifest is missing the ${svc} image.`));
    }
  }

  return findings;
}

/** Compare expected digests against what a host actually pulled/inspected. */
export function compareDigests(manifest: ImageManifest, actual: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const e of manifest.images) {
    const got = actual[e.service];
    if (!got) {
      findings.push(finding('images.not-pulled', 'CRITICAL', 'images', `${e.service}: image not present on the host after pull.`));
    } else if (got !== e.digest) {
      findings.push(
        finding('images.digest-mismatch', 'CRITICAL', 'images', `${e.service}: pulled digest does not match the manifest.`, {
          detail: `expected ${e.digest}, host has ${got}`,
        }),
      );
    }
  }
  return findings;
}
