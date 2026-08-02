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
 *   Apply:   tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts --apply [--manifest <path>]
 *
 * --apply repairs ONLY the `safely-repairable` class and, before the FIRST database write, commits
 * a durable rollback manifest to disk (fsync'd and read back) naming every row it is about to
 * touch, its original `simulation_url`, the proposed one and the exact rollback UPDATE. Printing
 * those statements to stdout is not a rollback record: stdout is a pipe that `process.exit` can
 * truncate, and a run that dies on row 3 leaves rows 1-2 modified with nothing durable to undo
 * them from. The updates then run inside a transaction when the driver supports one; when it does
 * not, every successful row is checkpointed to the manifest as it lands.
 *
 * EXIT CODES:
 *   0  no `unresolved` row, and (with --apply) every planned repair committed.
 *   1  any row could not be classified at all, or the apply failed / partially applied / could not
 *      commit its rollback manifest.
 *
 * Everything above main() is pure or dependency-injected, so it is unit-tested with no database and
 * no filesystem; the db/storage imports load lazily INSIDE main().
 */
import {
  mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type Log = (line: string) => void;

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

/** Stored facts about one package, read once by the caller. */
export interface PackageFacts {
  name: string;
  prefix: string;
  bridge: boolean;
  entry: boolean;
  ids: string[];
}

export interface OrphanInput {
  rowId: string;
  projectId: string;
  label: string | null;
  simulationId: string | null;
  url: string;
}

export const sqlLit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** True when the URL already carries a `?section=` identity (such rows are not orphans). */
export function hasSectionKey(url: string): boolean {
  try { return !!new URL(url, 'http://x.invalid').searchParams.get('section'); }
  catch { return false; }
}

/** Pure classification of one orphan row against the stored package facts. */
export function classifyOrphanRow(input: OrphanInput, packages: PackageFacts[]): OrphanRow {
  const match = packages.find((p) => input.url.includes(p.prefix)) ?? null;
  const row: OrphanRow = {
    rowId: input.rowId,
    projectId: input.projectId,
    label: input.label,
    simulationId: input.simulationId,
    currentUrl: input.url,
    packageName: match?.name ?? null,
    storagePrefix: match?.prefix ?? null,
    bridgePresent: match?.bridge ?? false,
    entryPresent: match?.entry ?? false,
    bridgeSectionIds: match?.ids ?? [],
    classification: 'unresolved',
    reason: '',
  };

  if (!match) {
    row.classification = 'unresolved';
    row.reason = 'simulation_url does not match any known package storage prefix';
  } else if (!match.entry && !match.bridge) {
    row.classification = 'obsolete';
    row.reason = 'the package has neither entry HTML nor bridge.js in storage — nothing can render, with or without a section key';
  } else if (!match.bridge) {
    row.classification = 'requires-regeneration';
    row.reason = 'entry HTML exists but bridge.js is absent — there are no section bodies to point at; the simulation must be regenerated';
  } else if (match.ids.includes(input.rowId)) {
    // PROVABLE: the generator mints a section body under the timeline row's own id, so the
    // bridge itself carries the evidence. This is the only class that is repaired.
    row.classification = 'safely-repairable';
    row.reason = `the package bridge contains a section body keyed by this row's own id`;
    const u = new URL(input.url, 'http://x.invalid');
    u.searchParams.set('section', input.rowId);
    row.proposedUrl = input.url.startsWith('http') ? u.href : `${u.pathname}${u.search}${u.hash}`;
    row.rollbackSql =
      `UPDATE timeline_sections SET simulation_url = ${sqlLit(input.url)} WHERE id = ${sqlLit(input.rowId)};`;
  } else {
    row.classification = 'requires-author-review';
    row.reason = match.ids.length === 0
      ? 'bridge.js parses to zero section bodies (legacy/pre-combined) — no key exists to point at'
      : `bridge has ${match.ids.length} section(s) but none is keyed by this row's id; which variation was intended is not recorded anywhere in stored content`;
  }
  return row;
}

// ── Durable rollback manifest ─────────────────────────────────────────────────

export interface RepairPlanItem {
  rowId: string;
  projectId: string;
  originalUrl: string;
  proposedUrl: string;
  rollbackSql: string;
}

export const MANIFEST_VERSION = 1;

export interface RollbackManifestHeader {
  kind: 'manifest';
  version: number;
  tool: 'classify-orphan-sim-rows';
  at: string;
  rows: RepairPlanItem[];
}

export type CheckpointStatus = 'applied' | 'failed' | 'rolled-back' | 'committed';

export interface ManifestCheckpoint {
  kind: 'checkpoint' | 'result';
  at: string;
  status: CheckpointStatus;
  rowId?: string;
  from?: string;
  to?: string;
  rollbackSql?: string;
  error?: string;
  rows?: string[];
}

/** Only rows the tool will actually touch reach the plan — nothing is inferred here. */
export function buildRepairPlan(rows: OrphanRow[]): RepairPlanItem[] {
  return rows
    .filter((r) => r.classification === 'safely-repairable' && !!r.proposedUrl && !!r.rollbackSql)
    .map((r) => ({
      rowId: r.rowId,
      projectId: r.projectId,
      originalUrl: r.currentUrl,
      proposedUrl: r.proposedUrl!,
      rollbackSql: r.rollbackSql!,
    }));
}

/** Filesystem port. `writeSync`/`appendSync` MUST have durably flushed when they return. */
export interface ManifestFs {
  mkdirp(path: string): void;
  writeSync(path: string, data: string): void;
  appendSync(path: string, data: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
}

export const nodeManifestFs: ManifestFs = {
  mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
  writeSync: (p, data) => {
    // fsync, not just write(): a rollback record still sitting in the page cache when the box or
    // the container dies is exactly the record that is not there when it is needed.
    const fd = openSync(p, 'w');
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  },
  appendSync: (p, data) => {
    const fd = openSync(p, 'a');
    try { appendFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  },
  readFile: (p) => readFileSync(p, 'utf-8'),
  exists: (p) => existsSync(p),
};

export function renderManifestHeader(plan: RepairPlanItem[], at: string): string {
  const header: RollbackManifestHeader = {
    kind: 'manifest', version: MANIFEST_VERSION, tool: 'classify-orphan-sim-rows', at, rows: plan,
  };
  return JSON.stringify(header) + '\n';
}

/**
 * Read the manifest back off disk and prove it can actually undo the run — before the first UPDATE.
 * Returns a problem string, or null when the record is durable and complete.
 */
export function verifyManifestOnDisk(fs: ManifestFs, path: string, plan: RepairPlanItem[]): string | null {
  if (!fs.exists(path)) return `rollback manifest ${path} does not exist after writing it`;
  let raw: string;
  try { raw = fs.readFile(path); }
  catch (e) { return `rollback manifest ${path} is unreadable — ${(e as Error).message.slice(0, 120)}`; }
  const firstLine = raw.split('\n')[0];
  let header: RollbackManifestHeader;
  try { header = JSON.parse(firstLine) as RollbackManifestHeader; }
  catch (e) { return `rollback manifest ${path} did not read back as JSON — ${(e as Error).message.slice(0, 120)}`; }
  if (header.kind !== 'manifest') return `rollback manifest ${path}: first record is not a manifest header`;
  if (header.version !== MANIFEST_VERSION) return `rollback manifest ${path}: version ${String(header.version)} != ${MANIFEST_VERSION}`;
  const byId = new Map((header.rows ?? []).map((r) => [r.rowId, r]));
  if (byId.size !== plan.length) {
    return `rollback manifest ${path}: recorded ${byId.size} row(s), the plan has ${plan.length}`;
  }
  for (const item of plan) {
    const stored = byId.get(item.rowId);
    if (!stored) return `rollback manifest ${path}: row ${item.rowId} is missing`;
    if (stored.originalUrl !== item.originalUrl) return `rollback manifest ${path}: row ${item.rowId} recorded the wrong original URL`;
    if (stored.proposedUrl !== item.proposedUrl) return `rollback manifest ${path}: row ${item.rowId} recorded the wrong proposed URL`;
    if (!stored.rollbackSql || !stored.rollbackSql.includes(item.rowId)) return `rollback manifest ${path}: row ${item.rowId} has no usable rollback SQL`;
  }
  return null;
}

/** Every row id whose original value is recoverable from a manifest file on disk. */
export function recoverableRowsFromManifest(raw: string): RepairPlanItem[] {
  const first = raw.split('\n')[0];
  try {
    const header = JSON.parse(first) as RollbackManifestHeader;
    return header.kind === 'manifest' ? (header.rows ?? []) : [];
  } catch { return []; }
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export type UpdateFn = (rowId: string, url: string) => Promise<void>;

export interface ApplyDeps {
  plan: RepairPlanItem[];
  fs: ManifestFs;
  manifestPath: string;
  /** Applies one row outside a transaction. Throws to signal failure. */
  update: UpdateFn;
  /**
   * When supplied, every update runs inside it and a throw from the body MUST roll all of them
   * back. Omitted (driver without transactions) ⇒ per-row checkpointing is the durability story.
   */
  transaction?: (body: (update: UpdateFn) => Promise<void>) => Promise<void>;
  log: Log;
  err?: Log;
  now?: () => string;
}

export interface ApplyOutcome {
  manifestPath: string;
  manifestVerified: boolean;
  transactional: boolean;
  /** Rows whose UPDATE succeeded. Emptied by a rollback (the writes were undone). */
  applied: string[];
  failed: { rowId: string; reason: string }[];
  /** Rows whose UPDATE succeeded but were then rolled back with the transaction. */
  rolledBackRows: string[];
  rolledBack: boolean;
  committed: boolean;
  ok: boolean;
  problems: string[];
}

/** Sentinel used to abort a transaction after a row-level failure has already been recorded. */
class RowFailure extends Error {}

export async function applyRepairs(o: ApplyDeps): Promise<ApplyOutcome> {
  const err = o.err ?? o.log;
  const now = o.now ?? (() => new Date().toISOString());
  const outcome: ApplyOutcome = {
    manifestPath: o.manifestPath,
    manifestVerified: false,
    transactional: !!o.transaction,
    applied: [],
    failed: [],
    rolledBackRows: [],
    rolledBack: false,
    committed: false,
    ok: false,
    problems: [],
  };

  // ── 1. The rollback record lands BEFORE the first UPDATE, or nothing happens at all ──
  try {
    o.fs.mkdirp(dirname(o.manifestPath));
    o.fs.writeSync(o.manifestPath, renderManifestHeader(o.plan, now()));
  } catch (e) {
    outcome.problems.push(`could not write the rollback manifest ${o.manifestPath} — ${(e as Error).message.slice(0, 160)}; NOTHING was modified`);
    err(`❌ ${outcome.problems[0]}`);
    return outcome;
  }
  const problem = verifyManifestOnDisk(o.fs, o.manifestPath, o.plan);
  if (problem) {
    outcome.problems.push(`${problem}; NOTHING was modified`);
    err(`❌ ${outcome.problems[0]}`);
    return outcome;
  }
  outcome.manifestVerified = true;
  o.log(`rollback manifest committed to disk (${o.plan.length} row(s)): ${o.manifestPath}`);
  o.log(`   recover the original values with:  head -1 ${o.manifestPath} | jq -r '.rows[].rollbackSql'`);

  const checkpoint = (c: ManifestCheckpoint): void => {
    try { o.fs.appendSync(o.manifestPath, JSON.stringify(c) + '\n'); }
    catch (e) { err(`   ⚠️  checkpoint for ${c.rowId ?? '(run)'} could not be appended — ${(e as Error).message.slice(0, 120)}`); }
  };

  // ── 2. Apply, stopping at the FIRST failure ──────────────────────────────────────────
  const body = async (update: UpdateFn): Promise<void> => {
    for (const item of o.plan) {
      try {
        await update(item.rowId, item.proposedUrl);
      } catch (e) {
        const reason = (e as Error).message.slice(0, 160);
        outcome.failed.push({ rowId: item.rowId, reason });
        checkpoint({ kind: 'checkpoint', at: now(), status: 'failed', rowId: item.rowId, from: item.originalUrl, to: item.proposedUrl, rollbackSql: item.rollbackSql, error: reason });
        err(`  ❌ FAILED   ${item.rowId} — ${reason}`);
        // Stop here. Continuing past an unexplained database failure widens the blast radius of a
        // repair whose cause is not yet understood.
        throw new RowFailure(reason);
      }
      outcome.applied.push(item.rowId);
      // The per-row checkpoint repeats the rollback SQL so a single appended line is enough to undo
      // that row even if the header were lost — the manifest is append-only, never rewritten.
      checkpoint({ kind: 'checkpoint', at: now(), status: 'applied', rowId: item.rowId, from: item.originalUrl, to: item.proposedUrl, rollbackSql: item.rollbackSql });
      o.log(`  repaired ${item.rowId} → ?section=${item.rowId}`);
    }
  };

  if (o.transaction) {
    try {
      await o.transaction(body);
      outcome.committed = true;
      checkpoint({ kind: 'result', at: now(), status: 'committed', rows: [...outcome.applied] });
    } catch (e) {
      outcome.rolledBack = true;
      outcome.rolledBackRows = [...outcome.applied];
      outcome.applied = [];
      if (!(e instanceof RowFailure)) {
        const reason = (e as Error).message.slice(0, 160);
        outcome.failed.push({ rowId: '(transaction)', reason });
        err(`  ❌ TRANSACTION FAILED — ${reason}`);
      }
      checkpoint({ kind: 'result', at: now(), status: 'rolled-back', rows: outcome.rolledBackRows });
    }
  } else {
    try {
      await body(o.update);
      outcome.committed = true;
      checkpoint({ kind: 'result', at: now(), status: 'committed', rows: [...outcome.applied] });
    } catch (e) {
      if (!(e instanceof RowFailure)) {
        const reason = (e as Error).message.slice(0, 160);
        outcome.failed.push({ rowId: '(run)', reason });
        checkpoint({ kind: 'checkpoint', at: now(), status: 'failed', error: reason });
        err(`  ❌ FAILED — ${reason}`);
      }
    }
  }

  // ── 3. Accounting ────────────────────────────────────────────────────────────────────
  if (outcome.failed.length) {
    for (const f of outcome.failed) outcome.problems.push(`row ${f.rowId} was NOT repaired — ${f.reason}`);
  }
  if (outcome.rolledBack) {
    outcome.problems.push(
      `the transaction rolled back — ${outcome.rolledBackRows.length} row(s) were reverted, the database is unchanged. ` +
      `Rollback record: ${o.manifestPath}`,
    );
  } else if (outcome.applied.length !== o.plan.length) {
    outcome.problems.push(
      `PARTIALLY APPLIED — ${outcome.applied.length}/${o.plan.length} row(s) were modified and NOT rolled back. ` +
      `Undo them with the rollback SQL in ${o.manifestPath} (rows: ${outcome.applied.join(', ') || 'none'}).`,
    );
  }
  outcome.ok = outcome.manifestVerified && outcome.failed.length === 0
    && outcome.committed && outcome.applied.length === o.plan.length;

  if (!outcome.ok) {
    err(`\n❌ apply INCOMPLETE — ${outcome.problems.length} problem(s):`);
    for (const p of outcome.problems) err(`     ${p}`);
  } else {
    o.log(`\n✅ repaired ${outcome.applied.length} row(s); rollback record: ${o.manifestPath}`);
  }
  return outcome;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export interface ClassifyGate { ok: boolean; problems: string[] }

/**
 * `unresolved` means the tool could not classify the row at all — a URL pointing at no known
 * package. That is an unknown, not a clean report, so it fails the run whether or not --apply ran.
 */
export function gateClassification(rows: OrphanRow[], outcome: ApplyOutcome | null): ClassifyGate {
  const problems: string[] = [];
  for (const r of rows.filter((x) => x.classification === 'unresolved')) {
    problems.push(`row ${r.rowId} is UNRESOLVED — ${r.reason}`);
  }
  if (outcome && !outcome.ok) problems.push(...outcome.problems);
  return { ok: problems.length === 0, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export function defaultManifestPath(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `./orphan-repair-rollback-${stamp}.jsonl`;
}

async function main(): Promise<number> {
  const APPLY = process.argv.includes('--apply');
  const manIdx = process.argv.indexOf('--manifest');
  const manifestPath = (manIdx !== -1 && process.argv[manIdx + 1]) || defaultManifestPath(new Date());

  const { db } = await import('../db/index.js');
  const { timeline_sections } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const { deriveEntryRelPath, parseSectionEntries } = await import('../services/simulation/SimulationService.js');

  const storage = getStorageAdapter();
  const simRows = await db.query.simulations.findMany();
  const sectionRows = await db.query.timeline_sections.findMany();

  // Per-package stored facts, read once.
  const packages: PackageFacts[] = [];
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
    packages.push({
      name: sim.name, prefix: sim.storage_prefix,
      bridge: bridgeJs !== null, entry: entryHtml !== null, ids,
    });
  }

  const out: OrphanRow[] = [];
  for (const s of sectionRows) {
    const url = (s as { simulation_url?: string | null }).simulation_url ?? null;
    if (!url || hasSectionKey(url)) continue;
    out.push(classifyOrphanRow({
      rowId: s.id,
      projectId: (s as { project_id?: string }).project_id ?? '',
      label: (s as { label?: string | null }).label ?? null,
      simulationId: (s as { simulation_id?: string | null }).simulation_id ?? null,
      url,
    }, packages));
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

  // The JSON report is written BEFORE any database write, so it exists even if the apply dies.
  const jsonIdx = process.argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : undefined;
  const writeJson = (outcome: ApplyOutcome | null): void => {
    if (!jsonPath) return;
    writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), applied: APPLY, rows: out, outcome }, null, 2) + '\n');
    console.log(`\nJSON written to ${jsonPath}`);
  };
  writeJson(null);

  const plan = buildRepairPlan(out);
  let outcome: ApplyOutcome | null = null;

  if (!APPLY) {
    console.log(`DRY RUN. ${plan.length} row(s) would be repaired; ${out.length - plan.length} left untouched for review.`);
    console.log('Re-run with --apply to repair ONLY the safely-repairable rows.');
  } else if (plan.length === 0) {
    console.log('Nothing is provably repairable — no row was modified, no manifest written.');
  } else {
    console.log(`Applying ${plan.length} repair(s).\n`);
    const update = async (rowId: string, url: string): Promise<void> => {
      await db.update(timeline_sections).set({ simulation_url: url }).where(eq(timeline_sections.id, rowId));
    };
    // postgres-js drizzle exposes .transaction(); guard anyway so a driver swap degrades to
    // per-row checkpointing instead of silently losing the all-or-nothing property.
    const hasTx = typeof (db as unknown as { transaction?: unknown }).transaction === 'function';
    outcome = await applyRepairs({
      plan,
      fs: nodeManifestFs,
      manifestPath,
      update,
      transaction: hasTx
        ? (bodyFn) => db.transaction(async (tx) => {
          await bodyFn(async (rowId, url) => {
            await tx.update(timeline_sections).set({ simulation_url: url }).where(eq(timeline_sections.id, rowId));
          });
        })
        : undefined,
      log: (l) => console.log(l),
      err: (l) => console.error(l),
    });
    writeJson(outcome);
  }

  const gate = gateClassification(out, outcome);
  if (!gate.ok) {
    console.error(`\n❌ ${gate.problems.length} problem(s):`);
    for (const p of gate.problems) console.error(`     ${p}`);
  }
  return gate.ok ? 0 : 1;
}

/** process.exit() drops buffered stdout/stderr when they are pipes (`… | tee rollout.log`) — and
 *  the truncated line would be the one naming the rows that WERE modified. Drain both first. */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => { process.stdout.write('', () => r()); }),
    new Promise<void>((r) => { process.stderr.write('', () => r()); }),
  ]);
  process.exit(code);
}

if (process.argv[1] && process.argv[1].includes('classify-orphan-sim-rows')) {
  main()
    .then((code) => exitFlushed(code))
    .catch(async (e) => { console.error(e); await exitFlushed(1); });
}
