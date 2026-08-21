/**
 * REGRESSION — the avatar-circle face image URL that reached production as
 * `http://localhost:8080/local-storage/avatar-circles/{projectId}/{uuid}.png`.
 *
 * Every assertion here is on the OUTPUT of the functions the write path and the repair actually
 * call, not on the text of any file. Two failure modes are pinned, because each one produces a
 * repair that LOOKS successful:
 *   1. losing the column's shape — production stores `projects.avatar_config` double-encoded, as a
 *      jsonb *string*. Writing back an object would fix the URL and silently change how
 *      `rewriteAvatarConfig` (project duplication) treats that project.
 *   2. widening the match — anything that scans the whole document for URLs would also rewrite
 *      `avatarImageUrl` and go hunting through 40 kB of the author's `knowledge` prose.
 */
import { describe, it, expect } from 'vitest';
import {
  circleFaceUrlPersistError,
  circlesOf,
  nonPublicCircleFaceUrls,
  parseAvatarConfigColumn,
  serializeAvatarConfigColumn,
  withCircleFaceUrls,
} from '../circleFaceUrls.js';
import { keyFromUrl } from '../../../scripts/lib/urlBackfill.js';

const PROJECT_ID = '431df510-45e5-4d4b-9750-87ed723776ba';
const FACE_KEY = `avatar-circles/${PROJECT_ID}/4829af92-9757-4d4c-842e-8adc6bdaf763.png`;
const POISONED = `http://localhost:8080/local-storage/${FACE_KEY}`;
const REPAIRED = `https://abc123ref.supabase.co/storage/v1/object/public/media/${FACE_KEY}`;

/** The production document, field for field (avatar_config for the affected project). */
function productionConfig() {
  return {
    characterId: 'einstein',
    // A localhost URL in a field this repair must NOT touch: the persona's own avatar image is
    // an Anam-hosted identity field, not a storage object this script can resolve.
    avatarImageUrl: 'http://localhost:8080/not-a-circle-face.png',
    knowledge: 'The host mentions http://localhost:3000 in the script. Prose, not a URL column.',
    avatarCircles: {
      enabled: true,
      visibility: 'always',
      count: 1,
      faces: [{ speaker: 'host_a', side: 'left', label: 'hey hey', imageUrl: POISONED }],
    },
  };
}

/** The column as production holds it: a jsonb STRING containing the JSON document. */
const doubleEncodedColumn = () => JSON.stringify(productionConfig());

describe('nonPublicCircleFaceUrls — what the repair and the persist guard both look at', () => {
  it('finds the poisoned face URL, addressed by index and by path', () => {
    const sites = nonPublicCircleFaceUrls(productionConfig().avatarCircles);
    expect(sites).toEqual([
      { faceIndex: 0, path: 'avatarCircles.faces[0].imageUrl', url: POISONED },
    ]);
  });

  it('reports NOTHING once the face points at a public URL (so the repair converges)', () => {
    const cfg = productionConfig();
    cfg.avatarCircles.faces[0].imageUrl = REPAIRED;
    expect(nonPublicCircleFaceUrls(cfg.avatarCircles)).toEqual([]);
  });

  it('never matches outside faces[].imageUrl — not avatarImageUrl, not the author prose', () => {
    const cfg = productionConfig();
    cfg.avatarCircles.faces = [];
    // avatarImageUrl and knowledge both still contain a localhost URL.
    expect(nonPublicCircleFaceUrls(cfg.avatarCircles)).toEqual([]);
    expect(nonPublicCircleFaceUrls(circlesOf(cfg))).toEqual([]);
  });

  it('tolerates every degenerate stored shape instead of throwing mid-repair', () => {
    for (const junk of [null, undefined, 'string', 42, [], {}, { faces: null }, { faces: [null, 7] }]) {
      expect(nonPublicCircleFaceUrls(junk)).toEqual([]);
    }
  });

  it('flags loopback and internal docker hosts, and leaves real public hosts alone', () => {
    const withUrl = (u: string) => ({ faces: [{ speaker: 'host_a', side: 'left', imageUrl: u }] });
    for (const u of [
      'http://localhost:8080/local-storage/avatar-circles/p/a.png',
      'http://127.0.0.1:8080/local-storage/avatar-circles/p/a.png',
      'http://backend:8080/local-storage/avatar-circles/p/a.png',
    ]) {
      expect(nonPublicCircleFaceUrls(withUrl(u)), u).toHaveLength(1);
    }
    for (const u of [REPAIRED, 'https://api.flowvidco.com/local-storage/avatar-circles/p/a.png']) {
      expect(nonPublicCircleFaceUrls(withUrl(u)), u).toEqual([]);
    }
  });
});

describe('the persist-time guard on PUT /avatar/circles and PUT /avatar/config', () => {
  it('REFUSES a non-public face URL in production, naming the offending value', () => {
    const message = circleFaceUrlPersistError(productionConfig().avatarCircles, true);
    expect(message).toContain(POISONED);
    expect(message).toMatch(/not publicly reachable/i);
  });

  it('accepts the SAME config in local development, where localhost is the correct value', () => {
    expect(circleFaceUrlPersistError(productionConfig().avatarCircles, false)).toBeNull();
  });

  it('accepts a public face URL in production', () => {
    const cfg = productionConfig();
    cfg.avatarCircles.faces[0].imageUrl = REPAIRED;
    expect(circleFaceUrlPersistError(cfg.avatarCircles, true)).toBeNull();
  });
});

describe('the repair round trip — shape in, shape out', () => {
  it('rewrites the one field and preserves the double-encoded jsonb STRING shape', () => {
    const parsed = parseAvatarConfigColumn(doubleEncodedColumn())!;
    expect(parsed.shape).toBe('string');

    const next = withCircleFaceUrls(parsed.config, new Map([[0, REPAIRED]]));
    const payload = serializeAvatarConfigColumn(next, parsed.shape);

    // What Postgres would store: a jsonb string, i.e. JSON.parse gives back TEXT, not an object.
    const asJsonb = JSON.parse(payload) as unknown;
    expect(typeof asJsonb).toBe('string');
    const document = JSON.parse(asJsonb as string) as ReturnType<typeof productionConfig>;
    expect(document.avatarCircles.faces[0].imageUrl).toBe(REPAIRED);

    // Everything else is byte-identical to what was read.
    const original = productionConfig();
    original.avatarCircles.faces[0].imageUrl = REPAIRED;
    expect(document).toEqual(original);
  });

  it('the wrong write is detectable: an object payload is NOT what a string-shaped row takes', () => {
    const parsed = parseAvatarConfigColumn(doubleEncodedColumn())!;
    const next = withCircleFaceUrls(parsed.config, new Map([[0, REPAIRED]]));
    expect(serializeAvatarConfigColumn(next, 'string')).not.toBe(serializeAvatarConfigColumn(next, 'object'));
    expect(JSON.parse(serializeAvatarConfigColumn(next, 'object'))).toBeTypeOf('object');
  });

  it('keeps an object-shaped row an object', () => {
    const parsed = parseAvatarConfigColumn(productionConfig())!;
    expect(parsed.shape).toBe('object');
    const payload = serializeAvatarConfigColumn(
      withCircleFaceUrls(parsed.config, new Map([[0, REPAIRED]])),
      parsed.shape,
    );
    const document = JSON.parse(payload) as ReturnType<typeof productionConfig>;
    expect(document.avatarCircles.faces[0].imageUrl).toBe(REPAIRED);
  });

  it('a missing object clears ONLY the picture — the face keeps its slot, speaker, side and label', () => {
    const parsed = parseAvatarConfigColumn(doubleEncodedColumn())!;
    const next = withCircleFaceUrls(parsed.config, new Map([[0, null]]));
    const face = (next.avatarCircles as { faces: Array<Record<string, unknown>> }).faces[0];
    expect(face).toEqual({ speaker: 'host_a', side: 'left', label: 'hey hey' });
    expect('imageUrl' in face).toBe(false);
  });

  it('does not mutate the document it was handed, and leaves untargeted fields alone', () => {
    const parsed = parseAvatarConfigColumn(doubleEncodedColumn())!;
    const before = JSON.stringify(parsed.config);
    const next = withCircleFaceUrls(parsed.config, new Map([[0, REPAIRED]]));
    expect(JSON.stringify(parsed.config)).toBe(before);
    expect(next.avatarImageUrl).toBe('http://localhost:8080/not-a-circle-face.png');
    expect(next.knowledge).toBe(productionConfig().knowledge);
  });

  it('is idempotent: a repaired row plans no further edits', () => {
    const parsed = parseAvatarConfigColumn(doubleEncodedColumn())!;
    const payload = serializeAvatarConfigColumn(
      withCircleFaceUrls(parsed.config, new Map([[0, REPAIRED]])),
      parsed.shape,
    );
    const reread = parseAvatarConfigColumn(JSON.parse(payload))!;
    expect(reread.shape).toBe('string');
    expect(nonPublicCircleFaceUrls(circlesOf(reread.config))).toEqual([]);
  });
});

describe('URL → storage key, the step that decides rewrite vs null', () => {
  it('recovers the avatar-circles key from the poisoned /local-storage/ URL', () => {
    expect(keyFromUrl(POISONED)).toBe(FACE_KEY);
  });
});
