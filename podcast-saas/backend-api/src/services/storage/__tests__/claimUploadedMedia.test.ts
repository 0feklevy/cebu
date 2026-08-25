/**
 * Storing an uploaded file once — and the two ways this helper could silently break uploads.
 *
 * ── THE TRAP IT EXISTS TO PREVENT ─────────────────────────────────────────────────────────────
 * On a dedup hit the bytes are at the EXISTING blob's key, not at the key the caller proposed.
 * A caller that writes its own proposed key to the row while the bytes live elsewhere produces a
 * row pointing at nothing — a 404 on somebody's image, with no error at upload time and nothing
 * in any log. That is why `storageKey` is returned rather than assumed, and why the first test
 * below is about which key comes back.
 *
 * ── AND THE TRADE IT MUST NEVER MAKE ──────────────────────────────────────────────────────────
 * If the dedup path fails — the blob table unreachable, a probe erroring, anything — the upload
 * must still succeed. A storage optimisation that can fail a user's upload is a feature making
 * the product less reliable in exchange for disk, which is the wrong trade in every direction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const state = {
  uploads: [] as string[],
  blobs: new Map<string, { id: string; key: string }>(),
  claimThrows: false,
};

vi.mock('../MediaBlobStore.js', () => ({
  claimBlob: vi.fn(async (input: { identity: { sha256: string }; upload: (k: string) => Promise<void> }) => {
    if (state.claimThrows) throw new Error('blob table unreachable');
    const hit = state.blobs.get(input.identity.sha256);
    if (hit) return { blob: { id: hit.id, storage_key: hit.key }, deduped: true, declinedBecause: null };
    const key = `blobs/aa/bb/${input.identity.sha256}`;
    await input.upload(key);
    const rec = { id: `blob-${state.blobs.size + 1}`, key };
    state.blobs.set(input.identity.sha256, rec);
    return { blob: { id: rec.id, storage_key: rec.key }, deduped: false, declinedBecause: null };
  }),
}));
vi.mock('../uploadWithFallback.js', () => ({
  uploadWithFallback: vi.fn(async (key: string) => { state.uploads.push(key); return `https://cdn/${key}`; }),
}));
vi.mock('../uploadFromDisk.js', () => ({
  uploadFileFromDisk: vi.fn(async (key: string) => { state.uploads.push(key); return `https://cdn/${key}`; }),
}));
vi.mock('../getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPublicUrl: (k: string) => `https://cdn/${k}` }),
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { claimUploadedMedia } = await import('../claimUploadedMedia.js');

const PIC = Buffer.from('the same picture bytes');
const SHA = createHash('sha256').update(PIC).digest('hex');

beforeEach(() => {
  state.uploads.length = 0;
  state.blobs.clear();
  state.claimThrows = false;
});

describe('the first time these bytes are seen', () => {
  it('uploads them and returns a blob to reference', async () => {
    const r = await claimUploadedMedia({ proposedKey: 'images/p1/a.png', bytes: PIC, contentType: 'image/png' });
    expect(state.uploads).toHaveLength(1);
    expect(r.deduped).toBe(false);
    expect(r.blobId).toBeTruthy();
    expect(r.storageKey).toContain(SHA);
  });
});

describe('the second time — the whole point', () => {
  it('uploads NOTHING and returns the EXISTING key', async () => {
    // The saving, and the trap in one test: the caller must write THIS key to its row. Writing
    // the proposed one instead leaves the row pointing at nothing.
    await claimUploadedMedia({ proposedKey: 'images/p1/a.png', bytes: PIC, contentType: 'image/png' });
    const uploadsAfterFirst = state.uploads.length;

    const second = await claimUploadedMedia({ proposedKey: 'images/p2/DIFFERENT.png', bytes: PIC, contentType: 'image/png' });

    expect(state.uploads.length, 'the second upload stored the bytes again').toBe(uploadsAfterFirst);
    expect(second.deduped).toBe(true);
    expect(second.storageKey, 'returned the caller\'s proposed key on a dedup hit').not.toBe('images/p2/DIFFERENT.png');
    expect(second.storageKey).toContain(SHA);
    expect(second.publicUrl).toContain(second.storageKey);
  });

  it('gives both projects the SAME blob id, which is what makes the reference shared', async () => {
    const a = await claimUploadedMedia({ proposedKey: 'images/p1/a.png', bytes: PIC, contentType: 'image/png' });
    const b = await claimUploadedMedia({ proposedKey: 'images/p2/b.png', bytes: PIC, contentType: 'image/png' });
    expect(b.blobId).toBe(a.blobId);
  });

  it('does NOT dedup genuinely different bytes that share a filename', async () => {
    // Name is not identity. Two projects uploading their own `chart.png` must keep their own.
    await claimUploadedMedia({ proposedKey: 'images/p1/chart.png', bytes: PIC, contentType: 'image/png' });
    const other = await claimUploadedMedia({
      proposedKey: 'images/p2/chart.png', bytes: Buffer.from('an entirely different chart'), contentType: 'image/png',
    });
    expect(other.deduped).toBe(false);
    expect(state.uploads).toHaveLength(2);
  });
});

describe('when dedup is unavailable', () => {
  it('STILL UPLOADS, at the caller\'s key, with no blob', async () => {
    // A storage optimisation that can fail a user's upload is the wrong trade in every direction.
    state.claimThrows = true;
    const r = await claimUploadedMedia({ proposedKey: 'images/p1/a.png', bytes: PIC, contentType: 'image/png' });

    expect(r.storageKey).toBe('images/p1/a.png');
    expect(r.blobId, 'claimed a blob while the blob path was failing').toBeNull();
    expect(r.deduped).toBe(false);
    expect(state.uploads).toContain('images/p1/a.png');
  });

  it('a null blobId is a usable row, not a broken one', async () => {
    // `blob_id` is nullable precisely so this case writes a normal, working media row — exactly
    // what every row created before dedup existed looks like.
    state.claimThrows = true;
    const r = await claimUploadedMedia({ proposedKey: 'audio/p1/x.mp3', bytes: PIC, contentType: 'audio/mpeg' });
    expect(r.publicUrl).toContain('audio/p1/x.mp3');
  });
});

describe('the callers write back what the claim returned', () => {
  // The helper's own suite CANNOT see a caller's mistake — mutating images.controller to keep its
  // proposed key left all six tests above green. That is the failure this block exists for: the
  // row would point at a key the bytes are not at, producing a 404 on somebody's image with no
  // error at upload time and nothing in any log.
  const read = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', rel), 'utf8');

  /** Controllers that store uploaded media and must therefore honour the claim's answer. */
  const CLAIMING_CONTROLLERS = [
    'controllers/v1/images.controller.ts',
    'controllers/v1/audio.controller.ts',
  ];

  it('every claiming controller writes the CLAIM\'s key, never its own proposed one', () => {
    for (const rel of CLAIMING_CONTROLLERS) {
      const t = read(rel);
      // Every storage_key written next to a claim must come from the claim.
      const bareKey = /storage_key:\s*key\b/.test(t);
      expect(bareKey, `${rel} writes its proposed key while the bytes may be at the blob's`).toBe(false);
      expect(t, `${rel} does not use the claim's key`).toMatch(/storage_key:\s*claimed\w*\.storageKey/);
    }
  });

  it('and records the blob, or the reference is lost the moment it is created', () => {
    // Without `blob_id` the row is deduplicated in storage and invisible to the sweeper's
    // reference union — which is worse than not deduplicating: the bytes get collected while a
    // row still serves them.
    for (const rel of CLAIMING_CONTROLLERS) {
      expect(read(rel), `${rel} claims a blob and never references it`)
        .toMatch(/blob_id:\s*claimed\w*\.blobId/);
    }
  });
});
