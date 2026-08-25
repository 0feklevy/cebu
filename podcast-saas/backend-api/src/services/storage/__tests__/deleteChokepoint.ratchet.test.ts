/**
 * Who is allowed to delete storage objects WITHOUT going through the guarded chokepoint.
 *
 * ── THE HOLE THIS EXISTS TO KEEP CLOSED ───────────────────────────────────────────────────────
 * `deleteWithFallback` refuses `blobs/` keys, because those bytes are content-addressed and may be
 * referenced by any number of projects (migration 078). That guard protects exactly the callers
 * that go through it — and a call straight to `storage.deleteFile(...)` does not.
 *
 * The gap was found by auditing the merged tree rather than by a test: `audio.controller.ts`
 * deleted `file.storage_key` through the adapter, and `audio_files` is one of the three tables
 * that carries a `blob_id`. Nothing sets `blob_id` yet, so nothing could actually be destroyed —
 * the risk was LATENT, and it becomes live on the day the upload wiring lands. That is precisely
 * the kind of defect that ships: correct today, catastrophic after an unrelated change.
 *
 * ── WHY A RATCHET AND NOT A BAN ───────────────────────────────────────────────────────────────
 * Direct adapter deletion is legitimate in several places — a self-test script cleaning its own
 * probe keys, a subsystem deleting a prefix it exclusively owns, and eventually the blob sweeper
 * itself, which MUST bypass the refusal to do its job. A blanket ban would be wrong and would be
 * worked around. So the list is allowed to exist and is pinned: adding to it is a deliberate act
 * visible in a diff, with a reason written next to it.
 *
 * If this test fails, the question to answer is not "how do I make it pass" but "can the key this
 * new caller deletes ever be a content-addressed one?" If it can, route it through
 * `deleteWithFallback`. If it cannot, add it below and say why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Modules permitted to call the adapter's delete methods directly, each with the reason its keys
 * can never be content-addressed.
 */
const DIRECT_DELETE_ALLOWED: Record<string, string> = {
  // The chokepoint itself — it IS the guard, so it necessarily calls through.
  'services/storage/deleteWithFallback.ts': 'the guard',
  // Storage self-test: writes and removes its own probe keys under a fixed test prefix.
  'scripts/verify-storage.ts': 'deletes only the probe keys it just wrote',
  // Simulation packages live under simulations/{projectId}/{simId} — a namespace disjoint from
  // blobs/ by construction, and imports COPY into it rather than referencing shared bytes.
  'controllers/v1/simulations.controller.ts': 'simulation prefixes only',
  'services/simulation/SimulationService.ts': 'simulation package keys only',
  'services/simulation/RevisionService.ts': 'revision prefixes only',
  // Captions are written and replaced by this service alone, under its own key shape.
  'services/captions/CaptionService.ts': 'caption keys it owns',
  // Dub audio and HLS trees, keyed from `video_dubs` — a namespace of its own. Revisit if dub
  // renditions ever gain a blob_id.
  'services/dubbing/dubRegistry.ts': 'dub keys from video_dubs, not a blob-carrying table',
  // Avatar library items, keyed from `avatar_visuals` (image_key / sim_storage_prefix). Also not
  // blob-carrying today; revisit if the library is folded into the dedup store.
  'services/avatar/libraryService.ts': 'avatar_visuals keys, not a blob-carrying table',
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
};

/** Files that call `.deleteFile(` or `.deleteWithPrefix(` on something. */
function directDeleteCallers(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    // The adapter and its interface DEFINE these methods rather than calling them past a guard.
    if (/^services\/storage\/(StorageService|R2StorageAdapter|SupabaseStorageAdapter|LocalStorageAdapter)\.ts$/.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (/\.\s*(deleteFile|deleteWithPrefix)\s*\(/.test(text)) hits.push(rel);
  }
  return hits.sort();
}

describe('the delete chokepoint has no unlisted bypass', () => {
  it('every direct adapter deleter is on the list, with a reason', () => {
    const unlisted = directDeleteCallers().filter((f) => !(f in DIRECT_DELETE_ALLOWED));
    expect(
      unlisted,
      'these delete storage objects WITHOUT the blobs/ refusal. Can the key ever be content-addressed? '
      + 'If yes, route it through deleteWithFallback. If no, add it to DIRECT_DELETE_ALLOWED with the reason: '
      + unlisted.join(', '),
    ).toEqual([]);
  });

  it('the list has no stale entries — a removed caller must not keep its exemption', () => {
    // A permission nobody uses is a permission waiting to be inherited by the wrong code.
    const actual = new Set(directDeleteCallers());
    const stale = Object.keys(DIRECT_DELETE_ALLOWED).filter((f) => !actual.has(f));
    expect(stale, `listed but no longer delete directly: ${stale.join(', ')}`).toEqual([]);
  });

  // A third check was drafted here — "no file that reads video_files/image_files/audio_files may
  // call deleteFile directly" — and removed after it flagged three modules that merely MENTION
  // one of those tables while deleting keys from an entirely different one. A rule that cannot
  // tell those apart produces false positives, and a test that cries wolf gets muted, which is
  // worse than not having it. The allow-list above does the real work: it forces every direct
  // deleter to be looked at and justified, which is the judgement the coarse rule was imitating.
});
