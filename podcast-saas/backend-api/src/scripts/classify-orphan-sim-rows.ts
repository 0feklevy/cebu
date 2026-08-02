/**
 * Classify every timeline row whose `simulation_url` has no `?section=` identity.
 *
 * Such a row cannot tell the player WHICH sub-simulation to run: the bridge dispatches on the
 * URL's `?section=` param, so without it the document falls back to `SCRIPTS.main` — the package's
 * default body — and the row silently renders a different variation than its author intended.
 *
 * This tool does NOT guess. A repair is emitted only when the intended key is PROVABLE from stored
 * content, which in practice means exactly one thing: the row's own id is itself a section id in
 * that package's bridge (that is how the generator mints them, so it is evidence, not inference).
 * Everything else is reported for a human, with the reason it could not be decided.
 *
 *   Report:  tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts [--json <out.json>]
 *   Apply:   tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts --apply
 *
 * --apply repairs ONLY the `safely-repairable` class, one row at a time, and prints the exact
 * rollback UPDATE (with the original value) for every row it touches before touching it.
 */
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

export type OrphanClass =
  | 'safely-repairable'    // the intended section key is provable from stored content
  | 'requires-regeneration' // the package has no usable bridge — the sim must be regenerated
  | 'requires-author-review' // a bridge exists but nothing proves which section this row meant
  | 'obsolete'             // the package's files are gone entirely; nothing can render
  | 'unresolved';          // none of the above fit

export interface OrphanRow {
  rowId: string;
  projectId: string;
  label: string | null;
  simulationId: string | null;
  currentUrl: string;
  packageName: string | null;
  storagePrefix: string | null;
  bridgePresent: boolean;
  entryPresent: boolean;
  bridgeSectionIds: string[];
  classification: OrphanClass;
  reason: string;
  /** Only for safely-repairable. */
  proposedUrl?: string;
  rollbackSql?: string;
}

const sqlLit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function main(): Promise<number> {
  const { db } = await import('../db/index.js');
  const { timeline_sections } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const { deriveEntryRelPath, parseSectionEntries } = await import('../services/simulation/SimulationService.js');

  const storage = getStorageAdapter();
  const simRows = await db.query.simulations.findMany();
  const sectionRows = await db.query.timeline_sections.findMany();

  // Per-package stored facts, read once.
  const pkg = new Map<string, { name: string; prefix: string; bridge: boolean; entry: boolean; ids: string[] }>();
  for (const sim of simRows) {
    const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
    const read = async (key: string): Promise<string | null> => {
      try { return (await storage.readObject(key)).toString('utf-8'); }
      catch {
        try { const r = await fetch(storage.getSimPublicUrl(key)); return r.ok ? await r.text() : null; }
        catch { return null; }
      }
    };
    const bridgeJs = await read(`${sim.storage_prefix}/bridge.js`);
    const entryHtml = entryRel ? await read(`${sim.storage_prefix}/${entryRel}`) : null;
    let ids: string[];
    try { ids = bridgeJs ? [...parseSectionEntries(bridgeJs).keys()] : []; } catch { ids = []; }
    pkg.set(sim.storage_prefix, {
      name: sim.name, prefix: sim.storage_prefix,
      bridge: bridgeJs !== null, entry: entryHtml !== null, ids,
    });
  }

  const out: OrphanRow[] = [];
  for (const s of sectionRows) {
    const url = (s as { simulation_url?: string | null }).simulation_url ?? null;
    if (!url) continue;
    let hasSection: boolean;
    try { hasSection = !!new URL(url, 'http://x.invalid').searchParams.get('section'); } catch { hasSection = false; }
    if (hasSection) continue;

    const match = [...pkg.values()].find((p) => url.includes(p.prefix)) ?? null;
    const rowId = s.id;
    const base: OrphanRow = {
      rowId,
      projectId: (s as { project_id?: string }).project_id ?? '',
      label: (s as { label?: string | null }).label ?? null,
      simulationId: (s as { simulation_id?: string | null }).simulation_id ?? null,
      currentUrl: url,
      packageName: match?.name ?? null,
      storagePrefix: match?.prefix ?? null,
      bridgePresent: match?.bridge ?? false,
      entryPresent: match?.entry ?? false,
      bridgeSectionIds: match?.ids ?? [],
      classification: 'unresolved',
      reason: '',
    };

    if (!match) {
      base.classification = 'unresolved';
      base.reason = 'simulation_url does not match any known package storage prefix';
    } else if (!match.entry && !match.bridge) {
      base.classification = 'obsolete';
      base.reason = 'the package has neither entry HTML nor bridge.js in storage — nothing can render, with or without a section key';
    } else if (!match.bridge) {
      base.classification = 'requires-regeneration';
      base.reason = 'entry HTML exists but bridge.js is absent — there are no section bodies to point at; the simulation must be regenerated';
    } else if (match.ids.includes(rowId)) {
      // PROVABLE: the generator mints a section body under the timeline row's own id, so the
      // bridge itself carries the evidence. This is the only class that is repaired.
      base.classification = 'safely-repairable';
      base.reason = `the package bridge contains a section body keyed by this row's own id`;
      const u = new URL(url, 'http://x.invalid');
      u.searchParams.set('section', rowId);
      base.proposedUrl = url.startsWith('http') ? u.href : `${u.pathname}${u.search}${u.hash}`;
      base.rollbackSql =
        `UPDATE timeline_sections SET simulation_url = ${sqlLit(url)} WHERE id = ${sqlLit(rowId)};`;
    } else {
      base.classification = 'requires-author-review';
      base.reason = match.ids.length === 0
        ? 'bridge.js parses to zero section bodies (legacy/pre-combined) — no key exists to point at'
        : `bridge has ${match.ids.length} section(s) but none is keyed by this row's id; which variation was intended is not recorded anywhere in stored content`;
    }
    out.push(base);
  }

  console.log(`\n=== Timeline rows with no ?section= identity — ${out.length} row(s) ===\n`);
  const byClass = new Map<OrphanClass, OrphanRow[]>();
  for (const r of out) byClass.set(r.classification, [...(byClass.get(r.classification) ?? []), r]);
  for (const [cls, rows] of byClass) {
    console.log(`── ${cls}  (${rows.length})`);
    for (const r of rows) {
      console.log(`   row ${r.rowId}  project ${r.projectId}  package ${r.packageName ?? '—'}`);
      console.log(`      ${r.reason}`);
      if (r.proposedUrl) {
        console.log(`      current : ${r.currentUrl}`);
        console.log(`      proposed: ${r.proposedUrl}`);
        console.log(`      rollback: ${r.rollbackSql}`);
      }
    }
    console.log('');
  }

  const repairable = out.filter((r) => r.classification === 'safely-repairable');
  if (!APPLY) {
    console.log(`DRY RUN. ${repairable.length} row(s) would be repaired; ${out.length - repairable.length} left untouched for review.`);
    console.log('Re-run with --apply to repair ONLY the safely-repairable rows.');
  } else if (repairable.length === 0) {
    console.log('Nothing is provably repairable — no row was modified.');
  } else {
    console.log(`Applying ${repairable.length} repair(s). Rollback statements above.\n`);
    for (const r of repairable) {
      await db.update(timeline_sections)
        .set({ simulation_url: r.proposedUrl! })
        .where(eq(timeline_sections.id, r.rowId));
      console.log(`  repaired ${r.rowId} → ?section=${r.rowId}`);
    }
  }

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ at: new Date().toISOString(), applied: APPLY, rows: out }, null, 2) + '\n');
    console.log(`\nJSON written to ${process.argv[jsonIdx + 1]}`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].includes('classify-orphan-sim-rows')) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
