/**
 * The read-only duplication diagnostic — everything above its `main()`.
 *
 * WHAT THIS SUITE IS FOR. The script's whole value is that its verdict is TRUSTED: a user who
 * cannot duplicate a project runs it once, reads one sentence, and acts on it. So the assertions
 * here are about the two ways that trust breaks — calling something permanent that a retry would
 * have fixed, and calling something harmless that will fail the copy every single time. Both are
 * pure functions of injected inputs, so none of this needs a database, storage, or a project.
 *
 * The one thing deliberately not covered is `main()`'s plumbing, which is thin on purpose: it
 * resolves a project, calls `loadSnapshot`/`buildPlan`, issues the scans and hands the results to
 * the functions below.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  EXIT_BLOCKED,
  EXIT_OK,
  JSONB_REWRITES,
  NO_BLOCKER_HEADLINE,
  STORAGE_READ_METHODS,
  StorageWriteRefused,
  checkCrossProjectReferences,
  checkDeadSourceKeys,
  checkEscapeScan,
  checkPlan,
  checkStorage,
  deadKeysNotRun,
  formatBytes,
  formatReport,
  internalReferences,
  keyOwners,
  parseArgs,
  readOnlyStorage,
  redactExcerpt,
  resolveScanInternals,
  resolveTitle,
  rewriteFor,
  verdictOf,
  type CheckReport,
  type CopyLike,
  type DiagnosticReport,
  type JsonbHit,
  type PlanOutcome,
  type ReferenceSnapshot,
  type StorageProbe,
} from '../diagnose-duplication.js';
import { IdAllocator, type DuplicationPlan } from '../../services/project/duplicationPlan.js';

const SRC = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const plan = (over: Partial<DuplicationPlan> = {}): DuplicationPlan => ({
  sourceProjectId: SRC,
  targetProjectId: OTHER,
  idMap: {},
  rowCounts: { projects: 1, video_files: 2 },
  excluded: {},
  storage: [],
  estimatedBytes: 1_000_000,
  oversize: [],
  warnings: [],
  ...over,
});

const check = (over: Partial<CheckReport> = {}): CheckReport => ({
  id: 'plan', label: 'Plan', status: 'pass', line: 'PASS', findings: [], data: {}, ...over,
});

// ── Arguments ─────────────────────────────────────────────────────────────────

describe('parseArgs — one project, named either way, and never guessed', () => {
  it('takes --project as `--project <id>` and as `--project=<id>`', () => {
    expect(parseArgs(['--project', SRC])).toMatchObject({ projectId: SRC, title: null, errors: [] });
    expect(parseArgs([`--project=${SRC}`])).toMatchObject({ projectId: SRC, errors: [] });
    expect(parseArgs([SRC])).toMatchObject({ projectId: SRC, errors: [] });
  });

  it('takes a title the way the user knows the project, spaces and all', () => {
    expect(parseArgs(['--title', 'The Edge of Chaos'])).toMatchObject({
      title: 'The Edge of Chaos', projectId: null, errors: [],
    });
    expect(parseArgs(['--title=The Edge of Chaos'])).toMatchObject({ title: 'The Edge of Chaos', errors: [] });
  });

  it('reads --json alongside either selector', () => {
    expect(parseArgs(['--title', 'x', '--json'])).toMatchObject({ title: 'x', json: true, errors: [] });
  });

  it('refuses BOTH selectors rather than silently preferring one', () => {
    // They can name different projects, and a clean report about the wrong one is worse than an error.
    expect(parseArgs(['--project', SRC, '--title', 'x']).errors).toEqual([
      'give either --project or --title, not both — they could name different projects',
    ]);
  });

  it('refuses an empty invocation', () => {
    expect(parseArgs([]).errors[0]).toContain('nothing to diagnose');
  });

  it('tells a user who typed a title without the flag exactly that', () => {
    const { errors } = parseArgs(['The Edge of Chaos']);
    expect(errors[0]).toBe('"The Edge of Chaos" is not a project id — did you mean --title "The Edge of Chaos"?');
  });

  it('reports a flag with no value instead of swallowing the next flag as one', () => {
    expect(parseArgs(['--title', '--json']).errors).toContain('--title needs a value');
    expect(parseArgs(['--title', '--json']).json).toBe(true);
  });

  it('reports an unknown option', () => {
    expect(parseArgs(['--project', SRC, '--apply']).errors).toContain('unknown option --apply');
  });

  it('--help asks for nothing else', () => {
    expect(parseArgs(['--help'])).toMatchObject({ help: true, errors: [] });
  });
});

// ── Title resolution ──────────────────────────────────────────────────────────

describe('resolveTitle — case-insensitive, and it never picks for you', () => {
  const rows = [
    { id: 'a', title: 'The Edge of Chaos' },
    { id: 'b', title: 'Something else' },
    { id: 'c', title: null },
  ];

  it('matches any part of the title, ignoring case', () => {
    expect(resolveTitle(rows, 'edge of chaos')).toEqual({ kind: 'resolved', project: rows[0] });
    expect(resolveTitle(rows, 'THE EDGE')).toEqual({ kind: 'resolved', project: rows[0] });
    expect(resolveTitle(rows, '  chaos  ')).toEqual({ kind: 'resolved', project: rows[0] });
  });

  it('LISTS the matches and refuses when more than one title contains the text', () => {
    // THE CASE THIS EXISTS FOR. A duplication mints "<title> (copy)", so a project and the copies
    // of it that half-succeeded all contain the same text. Preferring the exact match, or the
    // newest, is how a user reads a clean report about the wrong project.
    const withCopy = [...rows, { id: 'd', title: 'The Edge of Chaos (copy)' }];
    const out = resolveTitle(withCopy, 'The Edge of Chaos');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') throw new Error('unreachable');
    expect(out.matches.map((m) => m.id)).toEqual(['a', 'd']);
  });

  it('an exact title that is also a prefix of another is STILL ambiguous', () => {
    const both = [{ id: 'a', title: 'Chaos' }, { id: 'b', title: 'Chaos II' }];
    expect(resolveTitle(both, 'Chaos').kind).toBe('ambiguous');
  });

  it('says none rather than resolving to an untitled project', () => {
    expect(resolveTitle(rows, 'nothing like this')).toEqual({ kind: 'none', needle: 'nothing like this' });
  });
});

// ── Verdict + exit codes ──────────────────────────────────────────────────────

describe('verdictOf — the exit code follows PERMANENT and nothing else', () => {
  const finding = (severity: 'permanent' | 'transient' | 'info', title: string) =>
    check({ findings: [{ check: 'plan' as const, severity, title, detail: [] }] });

  it('exits 0 with the re-run advice when nothing permanent was found', () => {
    const v = verdictOf([check(), check()]);
    expect(v).toMatchObject({ blocked: false, exitCode: EXIT_OK, headline: NO_BLOCKER_HEADLINE });
  });

  it('exits non-zero and names every permanent reason', () => {
    const v = verdictOf([finding('permanent', 'a dead key'), finding('permanent', 'an escaping reference')]);
    expect(v.blocked).toBe(true);
    expect(v.exitCode).toBe(EXIT_BLOCKED);
    expect(v.exitCode).not.toBe(0);
    expect(v.headline).toContain('a dead key');
    expect(v.headline).toContain('an escaping reference');
    expect(v.permanent).toHaveLength(2);
  });

  it('a TRANSIENT finding is exit 0 — it is the absence of a permanent answer, not a failure', () => {
    const v = verdictOf([finding('transient', 'storage could not be read')]);
    expect(v.exitCode).toBe(EXIT_OK);
    expect(v.headline).toBe(NO_BLOCKER_HEADLINE);
    expect(v.transient).toHaveLength(1);
  });

  it('INFO never blocks and never appears in either group', () => {
    const v = verdictOf([finding('info', '3 empty prefixes')]);
    expect(v.exitCode).toBe(EXIT_OK);
    expect(v.permanent).toHaveLength(0);
    expect(v.transient).toHaveLength(0);
  });
});

// ── 1. Plan ───────────────────────────────────────────────────────────────────

describe('checkPlan — a throw IS the answer, and both gates report their numbers', () => {
  const gates = { maxBytes: 50e9, oversizeRefusal: null };

  it('passes and reports the counts and both verdicts', () => {
    const r = checkPlan(
      { phase: 'plan', plan: plan({ storage: [
        { kind: 'object', from: 'a', to: 'b', reason: 'r' },
        { kind: 'prefix', from: 'p', to: 'q', reason: 'r' },
      ] }), error: null },
      gates,
    );
    expect(r.status).toBe('pass');
    expect(r.line).toContain('1 object copies + 1 prefix copies');
    expect(r.line).toContain('size PASS');
    expect(r.line).toContain('oversize PASS');
    expect(r.findings.filter((f) => f.severity === 'permanent')).toHaveLength(0);
  });

  it('reports a snapshot-phase throw as the permanent answer, with the phase', () => {
    const outcome: PlanOutcome = { phase: 'snapshot', plan: null, error: 'connection terminated' };
    const r = checkPlan(outcome, gates);
    expect(r.status).toBe('fail');
    expect(r.line).toContain('snapshot phase');
    expect(r.findings[0].severity).toBe('permanent');
    expect(r.findings[0].detail[0]).toBe('connection terminated');
  });

  it('reports a plan-phase throw with its own phase', () => {
    const r = checkPlan({ phase: 'plan', plan: null, error: 'boom' }, gates);
    expect(r.line).toContain('plan phase');
    expect(r.findings[0].title).toContain('phase: plan');
  });

  it('FAILS the size gate on the same comparison the endpoint makes (strictly greater)', () => {
    const over = checkPlan({ phase: 'plan', plan: plan({ estimatedBytes: 51e9 }), error: null }, gates);
    expect(over.status).toBe('fail');
    expect(over.line).toContain('size FAIL');
    expect(over.findings.some((f) => f.severity === 'permanent' && f.title.includes('size limit'))).toBe(true);

    // Exactly at the cap is allowed — `estimatedBytes > cap` is the endpoint's own test.
    const at = checkPlan({ phase: 'plan', plan: plan({ estimatedBytes: 50e9 }), error: null }, gates);
    expect(at.status).toBe('pass');
  });

  it('FAILS on an oversize refusal and prints the file that caused it', () => {
    const r = checkPlan(
      { phase: 'plan', plan: plan({ oversize: [{ key: 'videos/x.mp4', bytes: 3e12, what: 'huge.mp4' }] }), error: null },
      { maxBytes: 50e9, oversizeRefusal: '“huge.mp4” is 3.0 TB…' },
    );
    expect(r.status).toBe('fail');
    expect(r.line).toContain('oversize FAIL');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.detail.join('\n')).toContain('huge.mp4');
  });

  it('plan warnings are INFO — they never block a duplication', () => {
    const r = checkPlan({ phase: 'plan', plan: plan({ warnings: ['retired HLS run trees'] }), error: null }, gates);
    expect(r.status).toBe('pass');
    expect(r.findings.map((f) => f.severity)).toEqual(['info']);
  });
});

describe('formatBytes', () => {
  it('reads the way an operator expects', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(50 * 1024 * 1024 * 1024)).toBe('53.7 GB');
    expect(formatBytes(3.2e9)).toBe('3.20 GB');
  });
});

// ── 2. Dead source keys ───────────────────────────────────────────────────────

describe('checkDeadSourceKeys — one missing object is permanent; an empty prefix is not', () => {
  const copies: CopyLike[] = [
    { kind: 'object', from: 'videos/p/live.mp4', to: 'x', reason: 'video "intro.mp4" master' },
    { kind: 'object', from: 'videos/p/gone.mp4', to: 'y', reason: 'video "outro.mp4" master' },
    { kind: 'prefix', from: 'hls/v1', to: 'hls/v2', reason: 'video "intro.mp4" HLS ladder' },
    { kind: 'prefix', from: 'avatar-circles/p', to: 'avatar-circles/q', reason: 'avatar circle face images' },
  ];
  const probe = {
    head: async (k: string) => k !== 'videos/p/gone.mp4',
    list: async (p: string) => (p === 'hls/v1' ? ['hls/v1/master.m3u8'] : []),
  };

  it('names every missing object, with the plan reason and the row that names it', async () => {
    const owners = new Map([['videos/p/gone.mp4', ['video_files.storage_key  row 9f3a  ("outro.mp4")']]]);
    const r = await checkDeadSourceKeys(copies, probe, owners);
    expect(r.status).toBe('fail');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.title).toContain('1 source object(s)');
    const text = f.detail.join('\n');
    expect(text).toContain('videos/p/gone.mp4');
    expect(text).toContain('video "outro.mp4" master');
    expect(text).toContain('video_files.storage_key  row 9f3a  ("outro.mp4")');
    // …and never the object that IS there.
    expect(text).not.toContain('videos/p/live.mp4');
  });

  it('says so plainly when a key is named by no column it can index', async () => {
    const r = await checkDeadSourceKeys(copies, probe);
    expect(r.findings[0].detail.join('\n')).toContain('no key column in the snapshot holds this key');
  });

  it('an EMPTY PREFIX is INFO, never permanent — verifyBytes accepts it', async () => {
    // The plan unconditionally includes `avatar-circles/{projectId}`, which most projects have never
    // written to. Blocking on it would make this tool cry wolf on a completely healthy project.
    const onlyPrefixes = copies.filter((c) => c.kind !== 'object');
    const r = await checkDeadSourceKeys(onlyPrefixes, probe);
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.severity)).toEqual(['info']);
    expect(r.findings[0].detail.join('\n')).toContain('avatar-circles/p');
    expect(verdictOf([r]).blocked).toBe(false);
  });

  it('a store that THROWS makes the sweep inconclusive and TRANSIENT, never "missing"', async () => {
    // objectExists returns false only for a 404 and throws for auth/network on purpose. Reporting
    // an unanswered probe as a dead key would send the user deleting rows over a bad credential.
    const angry = { head: async () => { throw new Error('AccessDenied'); }, list: probe.list };
    const r = await checkDeadSourceKeys(copies, angry);
    expect(r.status).toBe('inconclusive');
    expect(r.findings.map((f) => f.severity)).toContain('transient');
    expect(r.findings.some((f) => f.severity === 'permanent')).toBe(false);
    expect(verdictOf([r]).exitCode).toBe(EXIT_OK);
  });

  it('a clean project passes and still proves both sweeps ran', async () => {
    const allThere = {
      head: async () => true,
      list: async () => ['something'],
    };
    const r = await checkDeadSourceKeys(copies, allThere);
    expect(r.status).toBe('pass');
    expect(r.line).toContain('2/2 objects HEADed (0 missing)');
    expect(r.line).toContain('2/2 prefixes listed (0 empty)');
  });

  it('probes every object even under concurrency, and reports them in a stable order', async () => {
    const many: CopyLike[] = Array.from({ length: 25 }, (_, i) => ({
      kind: 'object', from: `k${String(i).padStart(2, '0')}`, to: 't', reason: `row ${i}`,
    }));
    const head = vi.fn(async () => false);
    const r = await checkDeadSourceKeys(many, { head, list: async () => [] }, new Map(), 8);
    expect(head).toHaveBeenCalledTimes(25);
    const keys = (r.data as any).missingObjects.map((m: any) => m.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(25);
  });

  it('the not-run form is transient, and says why it did not run', () => {
    const r = deadKeysNotRun('Supabase could not be read: AccessDenied');
    expect(r.status).toBe('inconclusive');
    expect(r.findings[0].severity).toBe('transient');
    expect(verdictOf([r]).blocked).toBe(false);
  });
});

describe('keyOwners — every key column a project owns', () => {
  it('maps each key to the table.column and row that names it', () => {
    const owners = keyOwners({
      project: { id: 'p1', thumbnail_key: 'thumb.jpg' },
      videoFiles: [{ id: 'v1', filename: 'intro.mp4', storage_key: 'videos/a.mp4', crop_key: 'crop/v1.json', captions_vtt_key: null }],
      imageFiles: [{ id: 'i1', filename: 'shot.png', storage_key: 'images/a.png' }],
      audioFiles: [{ id: 'a1', filename: 'vo.mp3', storage_key: 'audio/a.mp3' }],
      avatarVisuals: [{ id: 'av1', image_key: 'avatars/a.png' }],
    });
    expect(owners.get('thumb.jpg')).toEqual(['projects.thumbnail_key  row p1']);
    expect(owners.get('videos/a.mp4')).toEqual(['video_files.storage_key  row v1  ("intro.mp4")']);
    expect(owners.get('crop/v1.json')).toEqual(['video_files.crop_key  row v1  ("intro.mp4")']);
    expect(owners.get('images/a.png')).toEqual(['image_files.storage_key  row i1  ("shot.png")']);
    expect(owners.get('audio/a.mp3')).toEqual(['audio_files.storage_key  row a1  ("vo.mp3")']);
    expect(owners.get('avatars/a.png')).toEqual(['avatar_visuals.image_key  row av1']);
  });

  it('collects EVERY row that names one key, rather than the last one', () => {
    const owners = keyOwners({
      project: { id: 'p1', thumbnail_key: null },
      videoFiles: [
        { id: 'v1', filename: 'a.mp4', storage_key: 'shared.mp4', crop_key: null, captions_vtt_key: null },
        { id: 'v2', filename: 'b.mp4', storage_key: 'shared.mp4', crop_key: null, captions_vtt_key: null },
      ],
      imageFiles: [], audioFiles: [], avatarVisuals: [],
    });
    expect(owners.get('shared.mp4')).toHaveLength(2);
  });

  it('ignores null keys rather than mapping "null"', () => {
    const owners = keyOwners({
      project: { id: 'p1', thumbnail_key: null },
      videoFiles: [], imageFiles: [], audioFiles: [], avatarVisuals: [{ id: 'av1', image_key: null }],
    });
    expect(owners.size).toBe(0);
  });
});

// ── 3. The escape scan ────────────────────────────────────────────────────────

describe('rewriteFor — the default is the dangerous one', () => {
  it('treats a column nobody annotated as copied VERBATIM', () => {
    // A jsonb column added next year must read as a hard block, not as "probably fine" — that is
    // the direction assertNoEscapingReferences errs in, and this report has to agree with it.
    expect(rewriteFor('some_new_table', 'some_new_column').kind).toBe('verbatim');
    expect(rewriteFor('timeline_sections', 'sim_meta').kind).toBe('verbatim');
    expect(rewriteFor('scripts', 'body_json').kind).toBe('verbatim');
  });

  it('knows the five columns the duplication rewrites and the one it exempts', () => {
    expect(rewriteFor('projects', 'avatar_config').kind).toBe('partial');
    expect(rewriteFor('simulations', 'guidance').kind).toBe('partial');
    expect(rewriteFor('simulations', 'guidance_meta').kind).toBe('partial');
    expect(rewriteFor('avatar_visuals', 'visual_spec').kind).toBe('partial');
    expect(rewriteFor('sim_posters', 'variants').kind).toBe('partial');
    expect(rewriteFor('sim_revisions', 'metadata').kind).toBe('exempt');
    expect(Object.keys(JSONB_REWRITES)).toHaveLength(6);
  });
});

describe('checkEscapeScan — the RESIDUAL decides, not the raw match', () => {
  const hit = (over: Partial<JsonbHit>): JsonbHit => ({
    table: 'timeline_sections', column: 'sim_meta', rows: 0, residualRows: null,
    excerpt: null, residualExcerpt: null, ...over,
  });

  it('a hit in a VERBATIM column is permanent, and says the commit rolls back', () => {
    const r = checkEscapeScan([hit({ rows: 3, excerpt: `…"url":"…/${SRC}/x"…` })], 'imported');
    expect(r.status).toBe('fail');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.title).toContain('1 jsonb column(s)');
    expect(f.detail.join('\n')).toContain('timeline_sections.sim_meta — 3 row(s) match');
    expect(f.detail.join('\n')).toContain('rolls it back');
  });

  it('a hit ONLY inside a field the duplication rewrites is expected, and blocks nothing', () => {
    // Every project with an avatar circle matches here: the face URLs contain the project id by
    // construction. Classifying on the raw count would report a permanent blocker for almost
    // everyone, which is the fastest way to make this tool ignorable.
    const r = checkEscapeScan([hit({ table: 'projects', column: 'avatar_config', rows: 1, residualRows: 0 })], 'imported');
    expect(r.status).toBe('pass');
    expect(r.findings.map((f) => f.severity)).toEqual(['info']);
    expect(verdictOf([r]).blocked).toBe(false);
    expect(r.findings[0].detail.join('\n')).toContain('avatarCircles.faces[].imageUrl');
  });

  it('a hit that SURVIVES the rewrite in the same column is permanent', () => {
    const r = checkEscapeScan(
      [hit({ table: 'projects', column: 'avatar_config', rows: 2, residualRows: 1, residualExcerpt: 'knowledge: …' })],
      'imported',
    );
    expect(r.status).toBe('fail');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.detail.join('\n')).toContain('2 row(s) match, 1 still match after the rewrite');
    expect(f.detail.join('\n')).toContain('knowledge: …');
  });

  it('a non-provenance hit in sim_revisions.metadata blocks — the exemption is only duplicatedFrom', () => {
    // `migratedFromLegacyPrefix` holds `simulations/{sourceProjectId}/{simId}` and is carried
    // verbatim, so it survives the scan's `- 'duplicatedFrom'` and fails the commit.
    const r = checkEscapeScan([hit({ table: 'sim_revisions', column: 'metadata', rows: 1 })], 'imported');
    expect(r.status).toBe('fail');
    expect(r.findings[0].detail.join('\n')).toContain('migratedFromLegacyPrefix');
  });

  it('a clean sweep passes and still reports how many columns it looked at', () => {
    const r = checkEscapeScan([hit({ rows: 0 }), hit({ column: 'other', rows: 0 })], 'imported');
    expect(r.status).toBe('pass');
    expect(r.line).toContain('2 jsonb column(s) scanned with imported');
    expect(r.line).toContain('0 would block');
    expect(r.line).toContain('2 clean');
  });

  it('names the predicate it scanned with, so a local mirror cannot pass for the real rule', () => {
    expect(checkEscapeScan([], 'a LOCAL MIRROR of jsonbScanExpression — MAY BE STALE').line)
      .toContain('MAY BE STALE');
    expect(checkEscapeScan([], "the duplication module's own predicates").line)
      .toContain("the duplication module's own predicates");
  });
});

describe('redactExcerpt — where the id is, never the whole document', () => {
  it('windows around the id and marks both truncations', () => {
    const raw = `${'a'.repeat(200)} ${SRC} ${'b'.repeat(200)}`;
    const out = redactExcerpt(raw, SRC, 10)!;
    expect(out).toContain(SRC);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(80);
  });

  it('collapses the whitespace a jsonb dump is full of', () => {
    expect(redactExcerpt(`{\n  "a":\t"${SRC}"\n}`, SRC)).toBe(`{ "a": "${SRC}" }`);
  });

  it('caps the text even when the id is not in the window SQL returned', () => {
    const out = redactExcerpt('x'.repeat(500), SRC, 20)!;
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is null-safe and empty-safe', () => {
    expect(redactExcerpt(null, SRC)).toBeNull();
    expect(redactExcerpt('   ', SRC)).toBeNull();
  });
});

// ── 4. Cross-project references ───────────────────────────────────────────────

describe('internalReferences — every id commitRows puts through requireInternal', () => {
  const snap: ReferenceSnapshot = {
    videoFiles: [{ id: 'v1', filename: 'a.mp4', sequence_id: 'seq1' }],
    sections: [{
      id: 's1', label: 'Intro', video_file_id: 'v1', simulation_id: 'sim1',
      clip_source_video_id: null, clip_source_image_id: 'img1', clip_source_audio_id: null,
    }],
    choicePoints: [{ id: 'cp1', sequence_id: 'seq1', default_edge_id: 'e1' }],
    edges: [{ id: 'e1', label: 'Left', choice_point_id: 'cp1', dest_sequence_id: 'seq1', dest_simulation_id: 'simX' }],
    activeRevisions: [{ id: 'r1', simulation_id: 'sim1' }],
  };

  it('covers all twelve columns, in commit order', () => {
    const whats = [...new Set(internalReferences(snap).map((r) => r.what))];
    expect(whats).toEqual([
      'sim_revisions.simulation_id',
      'video_files.sequence_id',
      'timeline_sections.video_file_id',
      'timeline_sections.simulation_id',
      'timeline_sections.clip_source_video_id',
      'timeline_sections.clip_source_image_id',
      'timeline_sections.clip_source_audio_id',
      'branch_choice_points.sequence_id',
      'branch_edges.choice_point_id',
      'branch_edges.dest_sequence_id',
      'branch_edges.dest_simulation_id',
      'branch_choice_points.default_edge_id',
    ]);
  });

  it('does NOT include dest_project_id — a link to another project is content, not a reference', () => {
    expect(internalReferences(snap).map((r) => r.what)).not.toContain('branch_edges.dest_project_id');
  });

  it('carries a label the reader can recognise the row by', () => {
    const ref = internalReferences(snap).find((r) => r.what === 'branch_edges.dest_simulation_id')!;
    expect(ref).toMatchObject({ rowId: 'e1', value: 'simX', label: 'edge "Left"' });
  });
});

describe('checkCrossProjectReferences — asked of the REAL allocator', () => {
  const snap: ReferenceSnapshot = {
    videoFiles: [{ id: 'v1', filename: 'a.mp4', sequence_id: null }],
    sections: [{
      id: 's1', label: 'Intro', video_file_id: 'v1', simulation_id: 'sim1',
      clip_source_video_id: null, clip_source_image_id: null, clip_source_audio_id: null,
    }],
    choicePoints: [],
    edges: [{ id: 'e1', label: 'Onward', choice_point_id: null, dest_sequence_id: null, dest_simulation_id: 'simX' }],
    activeRevisions: [],
  };

  /** The allocator, populated exactly as `buildPlan` populates it: one entry per snapshot row. */
  const allocatorFor = (ids: string[]): IdAllocator => {
    const a = new IdAllocator();
    for (const id of ids) a.next(id);
    return a;
  };

  it('finds `branch_edges.dest_simulation_id` pointing outside the project, permanently', async () => {
    const ids = allocatorFor(['v1', 's1', 'sim1', 'e1']);   // simX is not part of the copy
    const r = await checkCrossProjectReferences(
      internalReferences(snap),
      (v, w) => ids.requireInternal(v, w),
      async () => 'row exists in simulations, owned by project other-project',
    );
    expect(r.status).toBe('fail');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.title).toContain('1 reference(s)');
    expect(f.detail.join('\n')).toContain('branch_edges.dest_simulation_id = simX');
    expect(f.detail.join('\n')).toContain('edge "Onward"');
    expect(f.detail.join('\n')).toContain('owned by project other-project');
  });

  it('passes when every reference is inside the project, and says how many it checked', async () => {
    const ids = allocatorFor(['v1', 's1', 'sim1', 'e1', 'simX']);
    const r = await checkCrossProjectReferences(internalReferences(snap), (v, w) => ids.requireInternal(v, w));
    expect(r.status).toBe('pass');
    expect(r.line).toContain('3 non-null internal reference(s) checked');
    expect(verdictOf([r]).blocked).toBe(false);
  });

  it('never asks about a NULL — an absent reference is not an escaping one', async () => {
    const requireInternal = vi.fn();
    await checkCrossProjectReferences(internalReferences(snap), requireInternal);
    expect(requireInternal).toHaveBeenCalledTimes(3);   // video_file_id, simulation_id, dest_simulation_id
    for (const call of requireInternal.mock.calls) expect(call[0]).not.toBeNull();
  });

  it('reports the target as unlocatable rather than inventing one', async () => {
    const ids = allocatorFor(['v1', 's1', 'sim1', 'e1']);
    const r = await checkCrossProjectReferences(internalReferences(snap), (v, w) => ids.requireInternal(v, w));
    expect(r.findings[0].detail.join('\n')).toContain('deleted, or owned by another project');
  });
});

// ── 5. Storage ────────────────────────────────────────────────────────────────

describe('checkStorage — reachability, and the inversion that silently breaks corpora', () => {
  const probe = (over: Partial<StorageProbe> = {}): StorageProbe => ({
    adapter: 'SupabaseStorageAdapter', probedKey: 'videos/a.mp4', readable: true, readError: null,
    candidatesTried: 1,
    roundTrips: [{ forward: 'getPublicUrl', key: 'videos/a.mp4', url: 'https://x/videos/a.mp4', recovered: 'videos/a.mp4', ok: true }],
    ...over,
  });

  it('passes, naming the adapter and the key it actually read', () => {
    const r = checkStorage(probe());
    expect(r.status).toBe('pass');
    expect(r.line).toContain('SupabaseStorageAdapter');
    expect(r.line).toContain('read videos/a.mp4');
    expect(r.line).toContain('1/1 round-trip');
  });

  it('a broken public-URL inversion is PERMANENT — it is the Supabase corpora failure', () => {
    const r = checkStorage(probe({
      roundTrips: [{
        forward: 'getPublicUrl', key: 'videos/a.mp4',
        url: 'https://x/storage/v1/object/public/bucket/videos/a.mp4',
        recovered: 'bucket/videos/a.mp4', ok: false,
      }],
    }));
    expect(r.status).toBe('fail');
    const f = r.findings.find((x) => x.severity === 'permanent')!;
    expect(f.title).toContain('cannot recover a storage key from its own public URL');
    expect(f.detail.join('\n')).toContain('bucket/videos/a.mp4');
  });

  it('an unreadable store is TRANSIENT — credentials are not a project defect', () => {
    const r = checkStorage(probe({ readable: null, readError: 'AccessDenied', probedKey: null }));
    expect(r.status).toBe('inconclusive');
    expect(r.findings.map((f) => f.severity)).toEqual(['transient']);
    expect(verdictOf([r]).exitCode).toBe(EXIT_OK);
  });

  it('a project whose every probed key is absent is reported, but not as a blocker', () => {
    const r = checkStorage(probe({ readable: false, probedKey: null, candidatesTried: 5 }));
    expect(r.status).toBe('inconclusive');
    expect(r.findings[0].severity).toBe('transient');
    expect(r.findings[0].title).toContain('none of the 5 probed key(s)');
  });

  it('a project with NO object to probe is INFO — not an unreadable store', () => {
    // A project that copies only prefixes has no cheap key to read back. Calling that "unreadable"
    // would be a transient finding about a healthy adapter AND would skip the dead-key sweep.
    const r = checkStorage(probe({ readable: null, probedKey: null, candidatesTried: 0, roundTrips: [] }));
    expect(r.findings.map((f) => f.severity)).toEqual(['info']);
    expect(r.line).toContain('no object to probe');
    expect(verdictOf([r]).transient).toHaveLength(0);
  });
});

// ── Read-only, structurally ───────────────────────────────────────────────────

describe('readOnlyStorage — the promise in the header, enforced', () => {
  const fake = () => ({
    getPublicUrl: (k: string) => `https://cdn/${k}`,
    getSimPublicUrl: (k: string) => `https://sim/${k}`,
    keyFromPublicUrl: (u: string) => u.replace(/^https:\/\/[^/]+\//, ''),
    readObject: async () => Buffer.from('hi'),
    listObjects: async () => ['a'],
    objectExists: async () => true,
    headObject: async () => null,
    getPresignedDownloadUrl: async () => 'url',
    uploadFile: async () => 'written',
    uploadStream: async () => 'written',
    copyObject: async () => undefined,
    copyPrefix: async () => 1,
    deleteFile: async () => undefined,
    deleteWithPrefix: async () => undefined,
    createMultipartUpload: async () => 'id',
    completeMultipartUpload: async () => 'url',
    abortMultipartUpload: async () => undefined,
    getPresignedUploadUrl: async () => 'url',
    getPresignedUploadPartUrl: async () => 'url',
  });

  it('passes every read through to the real adapter', async () => {
    const ro = readOnlyStorage(fake() as any);
    expect(ro.getPublicUrl('k')).toBe('https://cdn/k');
    expect(ro.keyFromPublicUrl('https://cdn/k')).toBe('k');
    expect(await ro.objectExists('k')).toBe(true);
    expect(await ro.listObjects('p')).toEqual(['a']);
    expect((await ro.readObject('k')).toString()).toBe('hi');
    expect(STORAGE_READ_METHODS).toHaveLength(8);
  });

  it('THROWS on every writing method, so the read-only claim is not a comment', async () => {
    const ro = readOnlyStorage(fake() as any);
    const writes: Array<() => unknown> = [
      () => ro.uploadFile('k', Buffer.from(''), 'text/plain'),
      () => ro.uploadStream('k', null as any, 'text/plain'),
      () => ro.copyObject('a', 'b'),
      () => ro.copyPrefix('a', 'b'),
      () => ro.deleteFile('k'),
      () => ro.deleteWithPrefix('p'),
      () => ro.createMultipartUpload('k', 'text/plain'),
      () => ro.completeMultipartUpload('k', 'u', []),
      () => ro.abortMultipartUpload('k', 'u'),
      () => ro.getPresignedUploadUrl('k', 'text/plain', 60),
      () => ro.getPresignedUploadPartUrl('k', 'u', 1, 60),
    ];
    for (const w of writes) expect(w).toThrow(StorageWriteRefused);
    expect(writes).toHaveLength(11);
  });

  it('refuses to be mutated, and stays safe to await', async () => {
    const ro = readOnlyStorage(fake() as any);
    expect(() => { (ro as any).copyObject = async () => undefined; }).toThrow(StorageWriteRefused);
    // `then` is absent on the target, so it must come back undefined rather than as a throwing stub
    // — otherwise `await`ing the proxy anywhere would blow up.
    expect((ro as any).then).toBeUndefined();
    await expect(Promise.resolve(ro as any)).resolves.toBeDefined();
  });
});

// ── Importing the duplication module's own predicates ─────────────────────────

describe('resolveScanInternals — use the real rule, or say loudly that you did not', () => {
  const localTables = () => [] as any;
  const localScan = () => ({} as any);
  const fallback = { copyScopedTables: localTables, jsonbScanExpression: localScan };

  it('prefers the module\'s own exported helpers', () => {
    const theirTables = (_id: string) => [] as any;
    const theirScan = (_t: string, _c: any) => ({ real: true } as any);
    const out = resolveScanInternals({ copyScopedTables: theirTables, jsonbScanExpression: theirScan }, fallback);
    expect(out.copyScopedTables).toBe(theirTables);
    expect(out.jsonbScanExpression).toBe(theirScan);
    expect(out.provenance).toBe("the duplication module's own predicates");
    expect(out.provenance).not.toContain('STALE');
  });

  it('adapts to a single-argument jsonbScanExpression rather than refusing it', () => {
    const theirScan = vi.fn((_col: any) => ({ adapted: true } as any));
    const out = resolveScanInternals({ jsonbScanExpression: theirScan }, fallback);
    expect(out.jsonbScanExpression('sim_revisions', { name: 'metadata' } as any)).toEqual({ adapted: true });
    expect(theirScan).toHaveBeenCalledWith({ name: 'metadata' });
    expect(out.provenance).toContain('single-argument form');
  });

  it('falls back when the helpers are private — and SAYS the exemptions may be stale', () => {
    // They are module-private today. A scan run with a local mirror of the exemption list must
    // never be mistaken in the report for one run with the real rule.
    const out = resolveScanInternals({ ProjectDuplicationService: class {} }, fallback);
    expect(out.copyScopedTables).toBe(localTables);
    expect(out.jsonbScanExpression).toBe(localScan);
    expect(out.provenance).toBe('a LOCAL MIRROR of copyScopedTables + jsonbScanExpression — MAY BE STALE');
  });

  it('names ONLY the half that fell back, when the other one imported', () => {
    const out = resolveScanInternals({ copyScopedTables: (_id: string) => [] as any }, fallback);
    expect(out.provenance).toBe('a LOCAL MIRROR of jsonbScanExpression — MAY BE STALE');
  });

  it('falls back for an export that is not callable at all', () => {
    const out = resolveScanInternals({ jsonbScanExpression: 'a string', copyScopedTables: 42 }, fallback);
    expect(out.jsonbScanExpression).toBe(localScan);
    expect(out.copyScopedTables).toBe(localTables);
  });
});

// ── The report ────────────────────────────────────────────────────────────────

describe('formatReport — one line per check, then the verdict', () => {
  const report = (checks: CheckReport[]): DiagnosticReport => ({
    generatedAt: '2026-08-12T00:00:00.000Z',
    readOnly: true,
    project: { id: SRC, title: 'The Edge of Chaos' },
    adapter: 'SupabaseStorageAdapter',
    checks,
    verdict: verdictOf(checks),
  });

  it('prints a summary line for EVERY check, including the ones that passed', () => {
    const out = formatReport(report([
      check({ id: 'plan', label: 'Plan', line: 'PASS — plan builds' }),
      check({ id: 'storage', label: 'Storage reachability', line: 'PASS — adapter ok' }),
      check({ id: 'dead-keys', label: 'Dead source keys', line: 'PASS — 10/10 objects HEADed' }),
      check({ id: 'escape-scan', label: 'Escape scan', line: 'PASS — 12 columns' }),
      check({ id: 'cross-project', label: 'Cross-project references', line: 'PASS — 40 checked' }),
    ]));
    for (const label of ['Plan', 'Storage reachability', 'Dead source keys', 'Escape scan', 'Cross-project references']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('[1/5]');
    expect(out).toContain('[5/5]');
  });

  it('says READ-ONLY at the top and names the project and the adapter', () => {
    const out = formatReport(report([check()]));
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('nothing was written');
    expect(out).toContain(SRC);
    expect(out).toContain('"The Edge of Chaos"');
    expect(out).toContain('SupabaseStorageAdapter');
  });

  it('a clean run ends in the re-run advice, with both groups printed empty', () => {
    const out = formatReport(report([check()]));
    expect(out).toContain(NO_BLOCKER_HEADLINE);
    expect(out).toContain('PERMANENT — a retry can never help until these are fixed:');
    expect(out).toContain('TRANSIENT — a retry may well succeed:');
    expect(out.match(/\(none\)/g)).toHaveLength(2);
    expect(out).toContain('exit 0');
  });

  it('groups a blocked run into PERMANENT and TRANSIENT, and prints the exit code', () => {
    const out = formatReport(report([
      check({ id: 'dead-keys', findings: [{ check: 'dead-keys', severity: 'permanent', title: '2 dead keys', detail: ['  MISSING videos/x'] }] }),
      check({ id: 'storage', findings: [{ check: 'storage', severity: 'transient', title: 'one probe unanswered', detail: [] }] }),
    ]));
    expect(out).toContain('BLOCKED — 1 permanent condition: 2 dead keys');
    expect(out).toContain('• [dead-keys] 2 dead keys');
    expect(out).toContain('• [storage] one probe unanswered');
    expect(out).toContain('MISSING videos/x');
    expect(out).toContain('exit 1');
  });

  it('renders an untitled project without printing empty quotes', () => {
    const out = formatReport({ ...report([check()]), project: { id: SRC, title: null } });
    expect(out).toContain('(untitled)');
  });
});
