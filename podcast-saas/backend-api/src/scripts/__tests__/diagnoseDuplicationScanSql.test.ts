/**
 * The escape scan's SQL, against a real Postgres engine.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `diagnoseDuplication.test.ts` proves the script's judgement with
 * no engine at all — it is the suite the deliverable requires and it must stay instant. This one
 * proves the thing no fake can: that the predicates actually RUN, and that the residual expressions
 * subtract exactly the fields the duplication rewrites. A diagnostic whose central query is a
 * syntax error is worse than no diagnostic, and it is not something a stubbed executor can catch.
 *
 * PGlite, not a live database — the same in-process WASM Postgres `src/db/__tests__/migration0*.ts`
 * already use. It never imports `db/index.js`, so it cannot reach any real deployment. The DDL is
 * hand-written and minimal (the real table and column NAMES, the jsonb columns, and the columns the
 * scope predicates touch) rather than a replay of every migration: this is a test of expressions,
 * not of the schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../db/schema.js';
import {
  localJsonbScanExpression,
  residualExpression,
  scanJsonbColumns,
  type JsonbHit,
  type ReadOnlyExec,
  type ScanInternals,
} from '../diagnose-duplication.js';

const SRC = '11111111-1111-1111-1111-111111111111';
const SIM = '33333333-3333-3333-3333-333333333333';
const REV = '44444444-4444-4444-4444-444444444444';

const DDL = `
  CREATE TABLE projects           (id uuid PRIMARY KEY, avatar_config jsonb);
  CREATE TABLE timeline_sections  (id uuid PRIMARY KEY, project_id uuid, sim_meta jsonb);
  CREATE TABLE simulations        (id uuid PRIMARY KEY, project_id uuid, guidance jsonb,
                                   guidance_meta jsonb, bridge_functions jsonb, canary_report jsonb);
  CREATE TABLE sim_revisions      (id uuid PRIMARY KEY, simulation_id uuid, metadata jsonb, canary_report jsonb);
  CREATE TABLE sim_posters        (id uuid PRIMARY KEY, simulation_id uuid, variants jsonb);
  CREATE TABLE avatar_visuals     (id uuid PRIMARY KEY, project_id uuid, visual_spec jsonb);
`;

let pg: PGlite;
let exec: ReadOnlyExec;

/** The six tables that carry a jsonb column this test cares about, scoped the way the real list is. */
const internals: ScanInternals = {
  provenance: 'test',
  jsonbScanExpression: localJsonbScanExpression,
  copyScopedTables: (id: string): Array<[string, PgTable, SQL]> => {
    const ofACopiedSim = (column: PgColumn): SQL =>
      sql`${column} IN (SELECT ${schema.simulations.id} FROM ${schema.simulations} WHERE ${schema.simulations.project_id} = ${id})`;
    return [
      ['projects', schema.projects, eq(schema.projects.id, id)],
      ['timeline_sections', schema.timeline_sections, eq(schema.timeline_sections.project_id, id)],
      ['simulations', schema.simulations, eq(schema.simulations.project_id, id)],
      ['avatar_visuals', schema.avatar_visuals, eq(schema.avatar_visuals.project_id, id)],
      ['sim_revisions', schema.sim_revisions, ofACopiedSim(schema.sim_revisions.simulation_id)],
      ['sim_posters', schema.sim_posters, ofACopiedSim(schema.sim_posters.simulation_id)],
    ];
  },
};

const scan = async (): Promise<Map<string, JsonbHit>> => {
  const hits = await scanJsonbColumns(exec, internals, SRC);
  return new Map(hits.map((h) => [`${h.table}.${h.column}`, h]));
};

/** Replace every jsonb column of the fixture with nulls, so each test writes only what it means. */
async function reset(): Promise<void> {
  await pg.exec(`
    TRUNCATE projects, timeline_sections, simulations, sim_revisions, sim_posters, avatar_visuals;
    INSERT INTO projects (id) VALUES ('${SRC}');
    INSERT INTO simulations (id, project_id) VALUES ('${SIM}', '${SRC}');
    INSERT INTO sim_revisions (id, simulation_id) VALUES ('${REV}', '${SIM}');
  `);
}

const setJson = (table: string, column: string, id: string, value: unknown): Promise<unknown> =>
  pg.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [JSON.stringify(value), id]);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  exec = drizzle(pg, { schema }) as unknown as ReadOnlyExec;
});
afterAll(async () => { await pg.close(); });

describe('scanJsonbColumns — the predicates run, and they find what the commit would find', () => {
  it('scans every jsonb column of every scoped table, and reports the clean ones as zero', async () => {
    await reset();
    const hits = await scan();
    // Ten jsonb columns across the six tables: avatar_config, sim_meta, the four on simulations,
    // visual_spec, the two on sim_revisions, and variants.
    expect(hits.size).toBe(10);
    expect([...hits.keys()]).toContain('simulations.bridge_functions');
    expect([...hits.keys()]).toContain('sim_revisions.canary_report');
    for (const [, hit] of hits) {
      expect(hit.rows).toBe(0);
      expect(hit.residualRows).toBeNull();
      expect(hit.excerpt).toBeNull();
    }
  });

  it('finds the source id in a VERBATIM column, with a windowed excerpt', async () => {
    await reset();
    await pg.query(
      `INSERT INTO timeline_sections (id, project_id, sim_meta) VALUES ('55555555-5555-5555-5555-555555555555', $1, $2)`,
      [SRC, JSON.stringify({ padding: 'z'.repeat(400), simUrl: `https://cdn/sim-public/simulations/${SRC}/${SIM}/index.html` })],
    );
    const hit = (await scan()).get('timeline_sections.sim_meta')!;
    expect(hit.rows).toBe(1);
    expect(hit.residualRows).toBeNull();          // nothing to subtract — the column is carried verbatim
    expect(hit.excerpt).toContain(SRC);
    expect(hit.excerpt!.length).toBeLessThan(200); // a window, not the 400-character document
    expect(hit.excerpt).not.toContain('z'.repeat(200));
  });
});

describe('the residual expressions — subtract exactly what commitRows rewrites', () => {
  it('projects.avatar_config: a face URL is expected; the same id in `knowledge` is not', async () => {
    await reset();
    await setJson('projects', 'avatar_config', SRC, {
      greeting: 'hello',
      avatarCircles: { faces: [{ imageUrl: `https://cdn/avatar-circles/${SRC}/a.png` }] },
    });
    const onlyFaces = (await scan()).get('projects.avatar_config')!;
    expect(onlyFaces.rows).toBe(1);
    expect(onlyFaces.residualRows).toBe(0);

    await setJson('projects', 'avatar_config', SRC, {
      knowledge: `the source project is ${SRC}`,
      avatarCircles: { faces: [{ imageUrl: `https://cdn/avatar-circles/${SRC}/a.png` }] },
    });
    const alsoKnowledge = (await scan()).get('projects.avatar_config')!;
    expect(alsoKnowledge.rows).toBe(1);
    expect(alsoKnowledge.residualRows).toBe(1);
    expect(alsoKnowledge.residualExcerpt).toContain('knowledge');
  });

  it('simulations.guidance: an audioUrl is expected; the id anywhere else in the cue is not', async () => {
    await reset();
    await setJson('simulations', 'guidance', SIM, [
      { at: 1, audioUrl: `https://cdn/simulations/${SRC}/${SIM}/guidance/a.mp3` },
    ]);
    const onlyAudio = (await scan()).get('simulations.guidance')!;
    expect(onlyAudio.rows).toBe(1);
    expect(onlyAudio.residualRows).toBe(0);

    await setJson('simulations', 'guidance', SIM, [
      { at: 1, audioUrl: `https://cdn/simulations/${SRC}/x.mp3`, text: `see ${SRC}` },
    ]);
    expect((await scan()).get('simulations.guidance')!.residualRows).toBe(1);
  });

  it('simulations.guidance_meta: mdUrl is expected; a sibling field naming the id is not', async () => {
    await reset();
    await setJson('simulations', 'guidance_meta', SIM, { model: 'x', mdUrl: `https://cdn/${SRC}/u.md` });
    expect((await scan()).get('simulations.guidance_meta')!.residualRows).toBe(0);

    await setJson('simulations', 'guidance_meta', SIM, { sourcePrefix: `simulations/${SRC}`, mdUrl: `https://cdn/${SRC}/u.md` });
    expect((await scan()).get('simulations.guidance_meta')!.residualRows).toBe(1);
  });

  it('avatar_visuals.visual_spec: entryKey is expected; anything else is not', async () => {
    await reset();
    const id = '66666666-6666-6666-6666-666666666666';
    await pg.query(
      `INSERT INTO avatar_visuals (id, project_id, visual_spec) VALUES ($1, $2, $3)`,
      [id, SRC, JSON.stringify({ source: 'zip-upload', entryKey: `simulations/${SRC}/${SIM}/index.html` })],
    );
    expect((await scan()).get('avatar_visuals.visual_spec')!.residualRows).toBe(0);

    await setJson('avatar_visuals', 'visual_spec', id, { source: 'zip-upload', caption: `from ${SRC}` });
    expect((await scan()).get('avatar_visuals.visual_spec')!.residualRows).toBe(1);
  });

  it('sim_posters.variants: every variant path is re-keyed, so paths alone are expected', async () => {
    await reset();
    const id = '77777777-7777-7777-7777-777777777777';
    await pg.query(
      `INSERT INTO sim_posters (id, simulation_id, variants) VALUES ($1, $2, $3)`,
      [id, SIM, JSON.stringify([
        { size: 1024, format: 'webp', path: `simulations/${SRC}/${SIM}/posters/a.webp` },
        { size: 512, format: 'webp', path: `simulations/${SRC}/${SIM}/posters/b.webp` },
      ])],
    );
    const hit = (await scan()).get('sim_posters.variants')!;
    expect(hit.rows).toBe(1);
    expect(hit.residualRows).toBe(0);
  });

  it('sim_revisions.metadata: `duplicatedFrom` is exempt, `migratedFromLegacyPrefix` is not', async () => {
    await reset();
    // Provenance the copy is SUPPOSED to carry — the one documented exemption. It must not register
    // at all, or every duplication of an already-duplicated project would look blocked.
    await setJson('sim_revisions', 'metadata', REV, {
      duplicatedFrom: { projectId: SRC, simulationId: SIM, revisionId: REV },
    });
    expect((await scan()).get('sim_revisions.metadata')!.rows).toBe(0);

    // …and the one that really does block: the migration's record of where the bytes came from,
    // carried verbatim into the copy.
    await setJson('sim_revisions', 'metadata', REV, {
      duplicatedFrom: { projectId: SRC },
      migratedFromLegacyPrefix: `simulations/${SRC}/${SIM}`,
    });
    const blocked = (await scan()).get('sim_revisions.metadata')!;
    expect(blocked.rows).toBe(1);
    expect(blocked.excerpt).toContain('migratedFromLegacyPrefix');
  });
});

describe('the residual expressions — a shape the duplication does not rewrite is NOT subtracted', () => {
  // Every rewriter returns the document untouched when it is not the shape it expects, so for any
  // other shape the residual is the WHOLE document. Both halves of that are load-bearing: the
  // subtraction must not silently absolve a document nothing rewrites, and the SQL must not raise
  // (`jsonb - text` and `#-` are `cannot delete from scalar` on anything but an object).

  it('an array holding a scalar element neither raises nor loses the hit', async () => {
    await reset();
    await setJson('simulations', 'guidance', SIM, [`a bare string mentioning ${SRC}`, 42, null]);
    const hit = (await scan()).get('simulations.guidance')!;
    expect(hit.rows).toBe(1);
    expect(hit.residualRows).toBe(1);
  });

  it('a NON-array in an array column keeps its hit — rewriteGuidanceAudioUrls would skip it', async () => {
    await reset();
    await pg.query(`INSERT INTO sim_posters (id, simulation_id, variants) VALUES ($1, $2, $3)`,
      ['88888888-8888-8888-8888-888888888888', SIM, JSON.stringify({ path: `simulations/${SRC}/a.webp` })]);
    const hit = (await scan()).get('sim_posters.variants')!;
    expect(hit.rows).toBe(1);
    // planPosters only re-keys the entries of an ARRAY. An object here is rewritten by nothing, so
    // absolving it would be the exact false negative this tool exists to avoid.
    expect(hit.residualRows).toBe(1);
  });

  it('a jsonb SCALAR in an object-minus column neither raises nor loses the hit', async () => {
    await reset();
    await setJson('simulations', 'guidance_meta', SIM, `just a string with ${SRC}`);
    const hit = (await scan()).get('simulations.guidance_meta')!;
    expect(hit.rows).toBe(1);
    expect(hit.residualRows).toBe(1);
  });

  it('a jsonb ARRAY in the `#-` column neither raises nor loses the hit', async () => {
    await reset();
    await setJson('projects', 'avatar_config', SRC, [{ imageUrl: `https://cdn/avatar-circles/${SRC}/a.png` }]);
    const hit = (await scan()).get('projects.avatar_config')!;
    expect(hit.rows).toBe(1);
    expect(hit.residualRows).toBe(1);
  });

  it('a NULL column is simply not a hit', async () => {
    await reset();
    expect((await scan()).get('projects.avatar_config')!.rows).toBe(0);
  });
});

describe('residualExpression — only the five columns the duplication rewrites have one', () => {
  const col = { name: 'x' } as unknown as PgColumn;

  it('returns null for a column carried verbatim, so its raw count IS the verdict', () => {
    expect(residualExpression('timeline_sections', 'sim_meta', col)).toBeNull();
    expect(residualExpression('scripts', 'body_json', col)).toBeNull();
    expect(residualExpression('sim_revisions', 'metadata', col)).toBeNull();
    expect(residualExpression('anything', 'new', col)).toBeNull();
  });

  it('returns one for each of the five partially-rewritten columns', () => {
    for (const [table, column] of [
      ['projects', 'avatar_config'], ['simulations', 'guidance'], ['simulations', 'guidance_meta'],
      ['avatar_visuals', 'visual_spec'], ['sim_posters', 'variants'],
    ]) {
      expect(residualExpression(table, column, col)).not.toBeNull();
    }
  });
});
