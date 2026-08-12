/**
 * Why can this project not be duplicated? — a STRICTLY READ-ONLY diagnosis.
 *
 *   pnpm --filter backend-api duplication:diagnose -- --title "The Edge of Chaos"
 *   pnpm --filter backend-api duplication:diagnose -- --project 3f9c…-…-…
 *   pnpm --filter backend-api duplication:diagnose -- --title "The Edge of Chaos" --json
 *
 * WHY THIS EXISTS
 * A failing duplication tells the user "Duplication failed. Nothing was created; you can try
 * again." The real reason is logged server-side and stored nowhere, and the commit transaction —
 * whose LAST statement is the independence proof — rolls back, destroying the evidence it just
 * produced. So the only way to ask "why can't this project be duplicated?" is to attempt it, and
 * the attempt erases the answer. This asks the same questions WITHOUT attempting it, from the
 * user's own deployment, and prints the answer.
 *
 * ── STRICTLY READ-ONLY, STRUCTURALLY ─────────────────────────────────────────────────────────
 * No INSERT, UPDATE, DELETE. No storage write, no copy, no duplication row. Safe against
 * production. That is not a promise about the code below; it is three properties of it:
 *
 *  1. THE STORAGE HANDED TO THE SERVICE REFUSES TO WRITE. `readOnlyStorage` wraps the configured
 *     adapter in a proxy that passes through the eight read methods and throws on EVERY other
 *     method — `uploadFile`, `copyObject`, `copyPrefix`, `deleteFile`, `deleteWithPrefix`, the
 *     multipart calls. A future change inside the code paths this reuses that tried to write bytes
 *     would abort this diagnosis rather than write them.
 *  2. EVERY QUERY THIS SCRIPT ISSUES RUNS INSIDE `SET TRANSACTION READ ONLY`, which PostgreSQL
 *     enforces server-side. Not a convention — the server rejects a write in such a transaction.
 *     The transactions are also kept SHORT (title resolution; the jsonb sweep) and are never held
 *     open across the storage probes, because a diagnostic must not pin a production snapshot for
 *     the minutes a few hundred HEADs can take.
 *  3. THE ONLY `ProjectDuplicationService` METHODS CALLED ARE `loadSnapshot` (SELECTs only) and
 *     `buildPlan` (pure — the two halves `dryRun` is composed of; they are called separately only
 *     so a failure can be reported with the phase it happened in). `copyBytes`,
 *     `retargetCopiedPackages`, `commitRows` and `run` are never referenced.
 *
 * ── WHAT IT CHECKS, AND WHY EACH ONE ─────────────────────────────────────────────────────────
 *  1. PLAN — does the plan build at all? A throw here IS the answer, reported with its phase.
 *     Plus the two gates the POST handler applies before a job row exists: `duplicateMaxBytes`
 *     against `estimatedBytes`, and `ProjectDuplicationService.oversizeRefusal`.
 *  2. DEAD SOURCE KEYS — the highest-value check. `copyBytes` has NO per-object tolerance: one
 *     missing source object throws `NoSuchKey` and aborts the whole run, every time, forever. Old
 *     projects accumulate rows pointing at objects that were deleted or never uploaded. Every
 *     `kind:'object'` copy in the plan is HEADed and every missing key is named, with the row that
 *     names it. Prefix copies are listed too, but an EMPTY prefix is not a blocker —
 *     `verifyBytes` says "nothing to copy is not a failure" — so it is reported as a warning.
 *  3. THE ESCAPE SCAN, WITHOUT DUPLICATING. `assertNoEscapingReferences` is the last statement
 *     inside the commit transaction, and its jsonb section scans EVERY jsonb column of every table
 *     in `copyScopedTables` for `::text LIKE '%<sourceProjectId>%'`. The equivalent predicates are
 *     run here against the SOURCE — "if this project were copied, which jsonb documents would
 *     still name it?" — with the count and a short redacted excerpt per `table.column`. For the
 *     five columns the duplication rewrites IN PART, a second RESIDUAL predicate removes exactly
 *     the fields it rewrites: a hit that survives that is a hard block, and a hit that does not is
 *     expected and harmless. Without the residual this check would report a blocker for every
 *     project that has an avatar circle.
 *  4. CROSS-PROJECT REFERENCES — every id `commitRows` puts through `IdAllocator.requireInternal`,
 *     replayed against the real allocator the real plan built. A hit throws during the commit and
 *     no retry can pass it.
 *  5. STORAGE REACHABILITY — one cheap probe that the configured adapter can read at all, and that
 *     `getPublicUrl` → `keyFromPublicUrl` round-trips for a real key of this project. It runs
 *     BEFORE the dead-key sweep on purpose: an adapter that cannot read would make every key look
 *     dead, and a false "your rows point at deleted objects" is worse than no answer.
 *
 * ── WHAT THE EXIT CODE MEANS ─────────────────────────────────────────────────────────────────
 *   0  ran; no PERMANENT blocker found (a transient failure is the remaining explanation)
 *   1  at least one PERMANENT blocker — retry can never help until it is fixed
 *   2  the diagnosis did not happen: bad arguments, unknown project, an ambiguous --title, or the
 *      run itself failed (no database, bad credentials). Never 1, because 1 is a verdict ABOUT the
 *      project and a wrapper script has only the exit code to tell the two apart.
 *
 * Everything above `main()` is pure or dependency-injected, so it is unit-tested with no database
 * and no storage (src/scripts/__tests__/diagnoseDuplication.test.ts). The db / storage / service
 * imports are loaded lazily INSIDE `main()` so importing this module never opens a database client.
 */
import { and, getTableColumns, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

// TYPE-ONLY, therefore erased: importing any of these for their VALUES would open a database
// client at module scope, which is the one thing this module promises not to do.
import type { db as Database } from '../db/index.js';
import type { DuplicationPlan, StorageCopy } from '../services/project/duplicationPlan.js';
import type { StorageService } from '../services/storage/StorageService.js';

/**
 * The only database surface this script asks for: `select`, and nothing else.
 *
 * The same narrowing `assertNoEscapingReferences` uses for its own executor. It is what lets the
 * scan below be handed a transaction that PostgreSQL has already been told is READ ONLY — and it
 * means no part of this module can reach `insert`, `update` or `delete` even by accident.
 */
export type ReadOnlyExec = Pick<typeof Database, 'select'>;

// ── Arguments ─────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  projectId: string | null;
  title: string | null;
  json: boolean;
  help: boolean;
  /** Usage problems, collected so one run reports all of them instead of one per attempt. */
  errors: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--project <id>` / `--project=<id>` / a bare id, or `--title <text>` / `--title=<text>`.
 *
 * A title is accepted because that is how the user knows the project — they have a name, not a
 * uuid, and asking them to find one in a database they are being asked to diagnose is a dead end.
 * Exactly ONE of the two is required: given both, this refuses rather than silently preferring one,
 * because the two could name different projects and the whole report would be about the wrong one.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let projectId: string | null = null;
  let title: string | null = null;
  let json = false;
  let help = false;
  const errors: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }

    const flag = (['--project', '--title'] as const).find((f) => arg === f || arg.startsWith(`${f}=`));
    if (flag) {
      let value: string | null = null;
      if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1);
      } else if (i < argv.length && !argv[i].startsWith('--')) {
        value = argv[i];
        i += 1;
      }
      if (value === null || value.trim() === '') errors.push(`${flag} needs a value`);
      else if (flag === '--project') projectId = value.trim();
      else title = value.trim();
      continue;
    }

    if (!arg.startsWith('-')) { projectId = arg.trim(); continue; }
    errors.push(`unknown option ${arg}`);
  }

  if (!help) {
    if (projectId !== null && title !== null) {
      errors.push('give either --project or --title, not both — they could name different projects');
    } else if (projectId === null && title === null) {
      errors.push('nothing to diagnose: pass --project <id> or --title "<part of the title>"');
    } else if (projectId !== null && !UUID_RE.test(projectId)) {
      // Almost always a title typed without the flag. Say so, rather than "project not found".
      errors.push(`"${projectId}" is not a project id — did you mean --title "${projectId}"?`);
    }
  }
  return { projectId, title, json, help, errors };
}

export const USAGE = [
  'Diagnose why a project cannot be duplicated. STRICTLY READ-ONLY — it writes nothing, anywhere.',
  '',
  '  pnpm --filter backend-api duplication:diagnose -- --title "The Edge of Chaos"',
  '  pnpm --filter backend-api duplication:diagnose -- --project <project-id>',
  '',
  '  --title  <text>   match the project title, case-insensitively, on any part of it',
  '  --project <id>    the project id, when you have it',
  '  --json            machine-readable dump instead of the report',
  '',
  'Exit 0 = no permanent blocker found, 1 = permanent blocker, 2 = the diagnosis could not run.',
].join('\n');

// ── Resolving a project by title ──────────────────────────────────────────────

export interface TitleCandidate { id: string; title: string | null }

export type TitleResolution =
  | { kind: 'resolved'; project: TitleCandidate }
  | { kind: 'none'; needle: string }
  | { kind: 'ambiguous'; needle: string; matches: TitleCandidate[] };

/**
 * The one project whose title contains `needle`, case-insensitively — or a refusal.
 *
 * NEVER A GUESS WHEN THERE ARE SEVERAL. The obvious "prefer the exact match" or "prefer the newest"
 * rule is precisely how a user spends an afternoon reading a clean report about the wrong project:
 * duplication mints "<title> (copy)", so a project and its half-made copies all contain the same
 * text. Several matches are listed with their ids so the next run can name one with `--project`.
 */
export function resolveTitle(rows: readonly TitleCandidate[], needle: string): TitleResolution {
  const wanted = needle.trim().toLowerCase();
  const matches = rows
    .filter((r) => (r.title ?? '').toLowerCase().includes(wanted))
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '') || a.id.localeCompare(b.id));
  if (matches.length === 0) return { kind: 'none', needle };
  if (matches.length > 1) return { kind: 'ambiguous', needle, matches };
  return { kind: 'resolved', project: matches[0] };
}

// ── Findings, checks, verdict ─────────────────────────────────────────────────

export type CheckId = 'plan' | 'storage' | 'dead-keys' | 'escape-scan' | 'cross-project';

/**
 * PERMANENT means a retry can never help — the condition has to be fixed first. TRANSIENT means a
 * retry might well succeed. INFO is something the reader should see that blocks nothing.
 */
export type Severity = 'permanent' | 'transient' | 'info';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'inconclusive';

export interface Finding {
  check: CheckId;
  severity: Severity;
  title: string;
  /** The exact rows, keys or columns. One string per line of the report. */
  detail: string[];
}

export interface CheckReport {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** Always printed, pass or fail, so a clean run still proves the check ran. */
  line: string;
  findings: Finding[];
  data: Record<string, unknown>;
}

export interface Verdict {
  blocked: boolean;
  exitCode: number;
  headline: string;
  permanent: Finding[];
  transient: Finding[];
}

export const EXIT_OK = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_USAGE = 2;

export const NO_BLOCKER_HEADLINE =
  'no blocking condition found — the failure is most likely transient; re-run and capture the server log';

/**
 * The whole point of the report: one sentence that is either the reason or the absence of one.
 *
 * The exit code follows PERMANENT alone. A transient finding is deliberately exit 0: it means "this
 * run could not prove anything permanent", and a non-zero exit for that would train whoever wires
 * this into a script to ignore the code that matters.
 */
export function verdictOf(checks: readonly CheckReport[]): Verdict {
  const all = checks.flatMap((c) => c.findings);
  const permanent = all.filter((f) => f.severity === 'permanent');
  const transient = all.filter((f) => f.severity === 'transient');
  const blocked = permanent.length > 0;
  const headline = blocked
    ? `BLOCKED — ${permanent.length} permanent condition${permanent.length === 1 ? '' : 's'}: `
      + permanent.map((f) => f.title).join('; ')
    : NO_BLOCKER_HEADLINE;
  return { blocked, exitCode: blocked ? EXIT_BLOCKED : EXIT_OK, headline, permanent, transient };
}

// ── 1. The plan ───────────────────────────────────────────────────────────────

/** Which half of the dry run was running when it threw. `dryRun` is exactly these two, in order. */
export type PlanPhase = 'snapshot' | 'plan';

export interface PlanOutcome {
  phase: PlanPhase;
  /** null when the phase threw, or when the project does not exist. */
  plan: DuplicationPlan | null;
  error: string | null;
}

export interface PlanGates {
  /** `duplicateMaxBytes()` — the ceiling the POST handler compares `estimatedBytes` against. */
  maxBytes: number;
  /** `ProjectDuplicationService.oversizeRefusal(plan)`'s message, or null when the plan is copyable. */
  oversizeRefusal: string | null;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u += 1; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[u]}`;
}

/**
 * The plan, and the two refusals that are decided before a job row exists.
 *
 * A THROW HERE IS THE ANSWER, not a failure of the diagnosis: the same call the POST handler makes
 * threw, so the user's duplication never got past the front door. It is reported with the phase and
 * the message rather than being allowed to end the run.
 */
export function checkPlan(outcome: PlanOutcome, gates: PlanGates): CheckReport {
  const findings: Finding[] = [];
  if (!outcome.plan) {
    findings.push({
      check: 'plan',
      severity: 'permanent',
      title: `the duplication plan cannot be built (phase: ${outcome.phase})`,
      detail: [
        outcome.error ?? 'no plan and no error — the project does not exist',
        'This is the failure the user sees: the same call the duplicate endpoint makes, before any',
        'byte or row is written. Every check below it is reported as not-run.',
      ],
    });
    return {
      id: 'plan',
      label: 'Plan',
      status: 'fail',
      line: `FAIL — dry run threw in the ${outcome.phase} phase: ${outcome.error ?? 'project not found'}`,
      findings,
      data: { phase: outcome.phase, error: outcome.error },
    };
  }

  const plan = outcome.plan;
  const objects = plan.storage.filter((c) => c.kind === 'object').length;
  const prefixes = plan.storage.length - objects;
  const overCap = plan.estimatedBytes > gates.maxBytes;
  if (overCap) {
    findings.push({
      check: 'plan',
      severity: 'permanent',
      title: `the project is over the duplication size limit `
        + `(${formatBytes(plan.estimatedBytes)} > ${formatBytes(gates.maxBytes)})`,
      detail: [
        'The endpoint refuses this with a 413 before a job row exists. `estimatedBytes` is a FLOOR',
        '(it counts only sizes the database knows), so the real total is larger, not smaller.',
        'Raise PROJECT_DUPLICATE_MAX_BYTES, or remove media from the project.',
      ],
    });
  }
  if (gates.oversizeRefusal) {
    findings.push({
      check: 'plan',
      severity: 'permanent',
      title: 'the plan contains an object the storage layer cannot copy at all',
      detail: [gates.oversizeRefusal, ...plan.oversize.map((o) => `  ${formatBytes(o.bytes)}  ${o.what}  (${o.key})`)],
    });
  }
  if (plan.warnings.length > 0) {
    findings.push({
      check: 'plan',
      severity: 'info',
      title: `${plan.warnings.length} plan warning(s) — none of them block a duplication`,
      detail: plan.warnings.map((w) => `  ${w}`),
    });
  }

  const rows = Object.values(plan.rowCounts).reduce((a, b) => a + b, 0);
  const verdicts = [
    `size ${overCap ? 'FAIL' : 'PASS'} (${formatBytes(plan.estimatedBytes)} of ${formatBytes(gates.maxBytes)})`,
    `oversize ${gates.oversizeRefusal ? 'FAIL' : 'PASS'} (${plan.oversize.length} object(s) past the copy ceiling)`,
  ];
  return {
    id: 'plan',
    label: 'Plan',
    status: overCap || gates.oversizeRefusal ? 'fail' : 'pass',
    line: `${overCap || gates.oversizeRefusal ? 'FAIL' : 'PASS'} — plan builds: `
      + `${objects} object copies + ${prefixes} prefix copies, ${rows} rows; ${verdicts.join(', ')}`,
    findings,
    data: {
      objectCopies: objects,
      prefixCopies: prefixes,
      rowCounts: plan.rowCounts,
      estimatedBytes: plan.estimatedBytes,
      maxBytes: gates.maxBytes,
      sizeVerdict: overCap ? 'FAIL' : 'PASS',
      oversizeVerdict: gates.oversizeRefusal ? 'FAIL' : 'PASS',
      oversize: plan.oversize,
      warnings: plan.warnings,
    },
  };
}

// ── 2. Dead source keys ───────────────────────────────────────────────────────

/** Just enough of a `StorageCopy` to probe it — so tests need no plan. */
export type CopyLike = Pick<StorageCopy, 'kind' | 'from' | 'to' | 'reason'>;

export interface KeyProbe {
  /** True/false for exists; THROWS when the store could not answer (auth, network). */
  head: (key: string) => Promise<boolean>;
  list: (prefix: string) => Promise<string[]>;
}

export interface DeadKeyResult {
  missingObjects: Array<{ key: string; reason: string; namedBy: string[] }>;
  emptyPrefixes: Array<{ prefix: string; reason: string }>;
  objectsProbed: number;
  prefixesProbed: number;
  /** Probes the store refused to answer. Any of these makes the whole sweep inconclusive. */
  probeErrors: Array<{ key: string; error: string }>;
}

/**
 * HEAD every source object the plan would copy, and list every source prefix.
 *
 * WHY OBJECTS ARE FATAL AND PREFIXES ARE NOT. `copyBytes` calls `storage.copyObject(c.from, c.to)`
 * with no try, no per-object tolerance and no skip: one `NoSuchKey` throws out of the whole run,
 * and it will do so on every retry until the row is fixed. An empty PREFIX is the opposite —
 * `verifyBytes` says in as many words that "nothing to copy is not a failure", and the plan
 * unconditionally includes `avatar-circles/{projectId}`, which most projects have never written to.
 * Reporting an empty prefix as a blocker would make this tool cry wolf on a healthy project.
 *
 * `owners` maps a key to the rows that name it, so the report can point at what to fix rather than
 * only at what is missing.
 */
export async function checkDeadSourceKeys(
  copies: readonly CopyLike[],
  probe: KeyProbe,
  owners: ReadonlyMap<string, string[]> = new Map(),
  concurrency = 8,
): Promise<CheckReport> {
  const objects = copies.filter((c) => c.kind === 'object');
  const prefixes = copies.filter((c) => c.kind !== 'object');
  const result: DeadKeyResult = {
    missingObjects: [], emptyPrefixes: [], objectsProbed: 0, prefixesProbed: 0, probeErrors: [],
  };

  await mapPool(objects, concurrency, async (c) => {
    try {
      const exists = await probe.head(c.from);
      result.objectsProbed += 1;
      if (!exists) result.missingObjects.push({ key: c.from, reason: c.reason, namedBy: owners.get(c.from) ?? [] });
    } catch (err) {
      result.probeErrors.push({ key: c.from, error: errorText(err) });
    }
  });
  await mapPool(prefixes, Math.max(1, Math.floor(concurrency / 2)), async (c) => {
    try {
      const keys = await probe.list(c.from);
      result.prefixesProbed += 1;
      if (keys.length === 0) result.emptyPrefixes.push({ prefix: c.from, reason: c.reason });
    } catch (err) {
      result.probeErrors.push({ key: `${c.from}/*`, error: errorText(err) });
    }
  });

  // Stable output regardless of how the pool interleaved.
  result.missingObjects.sort((a, b) => a.key.localeCompare(b.key));
  result.emptyPrefixes.sort((a, b) => a.prefix.localeCompare(b.prefix));
  result.probeErrors.sort((a, b) => a.key.localeCompare(b.key));

  return deadKeyReport(result, objects.length, prefixes.length);
}

/** The report for a completed sweep. Split out so the classification is testable on its own. */
export function deadKeyReport(r: DeadKeyResult, totalObjects: number, totalPrefixes: number): CheckReport {
  const findings: Finding[] = [];
  if (r.missingObjects.length > 0) {
    findings.push({
      check: 'dead-keys',
      severity: 'permanent',
      title: `${r.missingObjects.length} source object(s) named by a row do not exist in storage`,
      detail: [
        '`copyBytes` copies object by object with no tolerance: the first of these throws NoSuchKey',
        'and aborts the whole duplication, on every attempt, until the row is fixed or removed.',
        ...r.missingObjects.flatMap((m) => [
          `  MISSING  ${m.key}`,
          `           plan reason : ${m.reason}`,
          ...(m.namedBy.length > 0
            ? m.namedBy.map((o, i) => `           ${i === 0 ? 'named by   ' : '           '} : ${o}`)
            : ['           named by    : (no key column in the snapshot holds this key — see the plan reason)']),
        ]),
      ],
    });
  }
  if (r.emptyPrefixes.length > 0) {
    findings.push({
      check: 'dead-keys',
      severity: 'info',
      title: `${r.emptyPrefixes.length} source prefix(es) list zero objects — not a blocker`,
      detail: [
        'A prefix copy over an empty source copies nothing and `verifyBytes` accepts it ("nothing to',
        'copy is not a failure"). Listed because an empty package or HLS prefix usually means the',
        'copy would be missing content the rows claim it has.',
        ...r.emptyPrefixes.map((p) => `  EMPTY    ${p.prefix}/   (${p.reason})`),
      ],
    });
  }
  if (r.probeErrors.length > 0) {
    findings.push({
      check: 'dead-keys',
      severity: 'transient',
      title: `${r.probeErrors.length} storage probe(s) could not be answered — this sweep is inconclusive`,
      detail: [
        'The adapter threw rather than answering "missing", which means credentials or the network,',
        'not a dead row. Nothing here can be called permanent until these are answered.',
        ...r.probeErrors.slice(0, 10).map((e) => `  ERROR    ${e.key} — ${e.error}`),
      ],
    });
  }

  const status: CheckStatus = r.probeErrors.length > 0
    ? 'inconclusive'
    : r.missingObjects.length > 0 ? 'fail' : r.emptyPrefixes.length > 0 ? 'warn' : 'pass';
  const verb = status === 'fail' ? 'FAIL' : status === 'inconclusive' ? 'INCONCLUSIVE' : status === 'warn' ? 'WARN' : 'PASS';
  return {
    id: 'dead-keys',
    label: 'Dead source keys',
    status,
    line: `${verb} — ${r.objectsProbed}/${totalObjects} objects HEADed (${r.missingObjects.length} missing), `
      + `${r.prefixesProbed}/${totalPrefixes} prefixes listed (${r.emptyPrefixes.length} empty)`
      + (r.probeErrors.length > 0 ? `, ${r.probeErrors.length} unanswered` : ''),
    findings,
    data: r as unknown as Record<string, unknown>,
  };
}

/** The check as it reads when the storage probe already proved the store cannot be read. */
export function deadKeysNotRun(why: string): CheckReport {
  return {
    id: 'dead-keys',
    label: 'Dead source keys',
    status: 'inconclusive',
    line: `NOT RUN — ${why}`,
    findings: [{
      check: 'dead-keys',
      severity: 'transient',
      title: 'the dead-key sweep did not run because storage could not be read',
      detail: [
        why,
        'Deliberate: an unreadable adapter would report every key as missing, and a false',
        '"your rows point at deleted objects" is worse than no answer at all.',
      ],
    }],
    data: { skipped: true, why },
  };
}

/**
 * key → the rows that name it, as `table.column  row <id>  ("label")`.
 *
 * Every storage key a project owns in a COLUMN. `corpora.storage_url` is deliberately absent: its
 * key is not stored, it is recovered from the URL by the adapter, so the plan's own `reason` is the
 * honest attribution there.
 */
export interface KeyOwnerSnapshot {
  project: { id: string; thumbnail_key: string | null };
  videoFiles: ReadonlyArray<{ id: string; filename: string; storage_key: string | null; crop_key: string | null; captions_vtt_key: string | null }>;
  imageFiles: ReadonlyArray<{ id: string; filename: string; storage_key: string }>;
  audioFiles: ReadonlyArray<{ id: string; filename: string; storage_key: string }>;
  avatarVisuals: ReadonlyArray<{ id: string; image_key: string | null }>;
}

export function keyOwners(snap: KeyOwnerSnapshot): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const add = (key: string | null | undefined, who: string): void => {
    if (!key) return;
    const list = owners.get(key);
    if (list) list.push(who);
    else owners.set(key, [who]);
  };
  add(snap.project.thumbnail_key, `projects.thumbnail_key  row ${snap.project.id}`);
  for (const v of snap.videoFiles) {
    add(v.storage_key, `video_files.storage_key  row ${v.id}  ("${v.filename}")`);
    add(v.crop_key, `video_files.crop_key  row ${v.id}  ("${v.filename}")`);
    add(v.captions_vtt_key, `video_files.captions_vtt_key  row ${v.id}  ("${v.filename}")`);
  }
  for (const i of snap.imageFiles) add(i.storage_key, `image_files.storage_key  row ${i.id}  ("${i.filename}")`);
  for (const a of snap.audioFiles) add(a.storage_key, `audio_files.storage_key  row ${a.id}  ("${a.filename}")`);
  for (const v of snap.avatarVisuals) add(v.image_key, `avatar_visuals.image_key  row ${v.id}`);
  return owners;
}

// ── 3. The escape scan, run against the source ────────────────────────────────

/** What `commitRows` does to one jsonb column when it copies it. */
export interface JsonbRewrite {
  /** `verbatim` — copied as it is, so ANY hit is a hard block. */
  kind: 'verbatim' | 'partial' | 'exempt';
  /** For `partial`: the paths the duplication rewrites, in the document's own words. */
  fields?: readonly string[];
  note: string;
}

const VERBATIM: JsonbRewrite = {
  kind: 'verbatim',
  note: 'copied verbatim by commitRows — any occurrence of the source project id is carried into the copy',
};

/**
 * The five columns a duplication rewrites, and the one it exempts. Everything else is verbatim.
 *
 * THE DEFAULT IS THE DANGEROUS ONE ON PURPOSE. A jsonb column added next year is unknown to this
 * table and is therefore reported as a hard block, which is the same direction
 * `assertNoEscapingReferences` errs in — it enumerates columns from the schema exactly so that a
 * new one is covered the day it exists. A default of "probably fine" would make this report agree
 * with a duplication that then fails.
 */
export const JSONB_REWRITES: Readonly<Record<string, JsonbRewrite>> = {
  'projects.avatar_config': {
    kind: 'partial',
    fields: ['avatarCircles.faces[].imageUrl'],
    note: 'rewriteAvatarConfig re-roots the face image URLs; the rest of the persona travels verbatim',
  },
  'simulations.guidance': {
    kind: 'partial',
    fields: ['[].audioUrl'],
    note: 'rewriteGuidanceAudioUrls re-roots each cue\'s audio URL; the rest of the cue travels verbatim',
  },
  'simulations.guidance_meta': {
    kind: 'partial',
    fields: ['mdUrl'],
    note: 'rewriteGuidanceMeta re-roots the understanding document URL; the rest describes the bytes and is carried',
  },
  'avatar_visuals.visual_spec': {
    kind: 'partial',
    fields: ['entryKey'],
    note: 'rewriteVisualSpec maps the zip-upload entry key through the plan',
  },
  'sim_posters.variants': {
    kind: 'partial',
    fields: ['[].path'],
    note: 'planPosters re-keys every variant path onto the copy\'s identity axis (and drops posters of retired revisions, which are counted here but never copied)',
  },
  'sim_revisions.metadata': {
    kind: 'exempt',
    fields: ['duplicatedFrom'],
    note: 'jsonbScanExpression exempts `duplicatedFrom` (provenance the copy is SUPPOSED to carry); anything else in this document — `migratedFromLegacyPrefix`, for one — is carried verbatim and does block',
  },
};

export function rewriteFor(table: string, column: string): JsonbRewrite {
  return JSONB_REWRITES[`${table}.${column}`] ?? VERBATIM;
}

export interface JsonbHit {
  table: string;
  column: string;
  /** Rows whose document names the source project id at all. */
  rows: number;
  /**
   * Rows that STILL name it after the fields the duplication rewrites are removed.
   *
   * null when the column is not a `partial` one, in which case `rows` is already the residual.
   */
  residualRows: number | null;
  /** A short window of the document around the first occurrence, whitespace collapsed. */
  excerpt: string | null;
  /** The residual excerpt, when there is a residual hit — this is the one that blocks. */
  residualExcerpt: string | null;
}

/**
 * One short, whitespace-collapsed window around the id — never the whole document.
 *
 * `projects.avatar_config` holds up to 40 kB of the author's knowledge base and `scripts.body_json`
 * holds the script. An operator diagnosing a copy needs to see WHERE the id sits, not to have the
 * customer's prose printed into a terminal they will paste into a support thread.
 */
export function redactExcerpt(raw: string | null, id: string, window = 60): string | null {
  if (raw === null) return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const at = flat.toLowerCase().indexOf(id.toLowerCase());
  if (at < 0) return flat.length > window * 2 ? `${flat.slice(0, window * 2)}…` : flat;
  const start = Math.max(0, at - window);
  const end = Math.min(flat.length, at + id.length + window);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Turn the raw jsonb hits into the check — the part of the escape scan that has an opinion.
 *
 * A `partial` column's RESIDUAL is what decides. Scanning the source for its own id necessarily
 * matches every rewritten pointer — every avatar-circle face URL contains the project id, on every
 * healthy project — so classifying on `rows` alone would report a permanent blocker for almost
 * everyone. The residual removes exactly the fields `commitRows` rewrites and asks again.
 */
export function checkEscapeScan(hits: readonly JsonbHit[], scanSource: string): CheckReport {
  const findings: Finding[] = [];
  const blocking: JsonbHit[] = [];
  const expected: JsonbHit[] = [];

  for (const hit of hits) {
    if (hit.rows === 0) continue;
    // `residualRows` is null for every column the duplication carries verbatim — there is nothing to
    // subtract, so the raw count IS the residual and any hit blocks.
    if ((hit.residualRows ?? hit.rows) > 0) blocking.push(hit);
    else expected.push(hit);
  }

  if (blocking.length > 0) {
    findings.push({
      check: 'escape-scan',
      severity: 'permanent',
      title: `${blocking.length} jsonb column(s) would still name the source project after the copy`,
      detail: [
        '`assertNoEscapingReferences` is the LAST statement inside the commit transaction, so each of',
        'these fails the duplication and rolls it back — which is exactly why the user sees "nothing',
        'was created" and no reason. Every retry does the same thing.',
        ...blocking.flatMap((h) => {
          const rw = rewriteFor(h.table, h.column);
          return [
            `  BLOCKS   ${h.table}.${h.column} — ${h.rows} row(s) match`
              + (h.residualRows !== null ? `, ${h.residualRows} still match after the rewrite` : ''),
            `           duplication: ${rw.note}`,
            `           excerpt: ${h.residualExcerpt ?? h.excerpt ?? '(none)'}`,
          ];
        }),
      ],
    });
  }
  if (expected.length > 0) {
    findings.push({
      check: 'escape-scan',
      severity: 'info',
      title: `${expected.length} jsonb column(s) name the source project only where the duplication rewrites it`,
      detail: [
        'Expected and harmless: every one of these hits is inside a field `commitRows` re-roots, so',
        'the copy will not carry it.',
        ...expected.flatMap((h) => {
          const rw = rewriteFor(h.table, h.column);
          return [
            `  OK       ${h.table}.${h.column} — ${h.rows} row(s) match, 0 after removing ${(rw.fields ?? []).join(', ')}`,
            `           excerpt: ${h.excerpt ?? '(none)'}`,
          ];
        }),
      ],
    });
  }

  const scanned = hits.length;
  return {
    id: 'escape-scan',
    label: 'Escape scan (source jsonb)',
    status: blocking.length > 0 ? 'fail' : 'pass',
    line: `${blocking.length > 0 ? 'FAIL' : 'PASS'} — ${scanned} jsonb column(s) scanned with ${scanSource}: `
      + `${blocking.length} would block, ${expected.length} expected-and-rewritten, `
      + `${scanned - blocking.length - expected.length} clean`,
    findings,
    data: { scanSource, hits },
  };
}

// ── 4. Cross-project references ───────────────────────────────────────────────

export interface InternalReference {
  /** The `what` string `commitRows` passes to `requireInternal`, verbatim. */
  what: string;
  rowId: string;
  value: string | null;
  /** Something the reader can recognise the row by. */
  label: string;
}

/** The subset of a `DuplicationSnapshot` this scan reads. Structural, so a test can pass literals. */
export interface ReferenceSnapshot {
  videoFiles: ReadonlyArray<{ id: string; filename: string; sequence_id: string | null }>;
  sections: ReadonlyArray<{
    id: string; label: string | null; video_file_id: string; simulation_id: string | null;
    clip_source_video_id: string | null; clip_source_image_id: string | null; clip_source_audio_id: string | null;
  }>;
  choicePoints: ReadonlyArray<{ id: string; sequence_id: string; default_edge_id: string | null }>;
  edges: ReadonlyArray<{ id: string; label: string | null; choice_point_id: string | null; dest_sequence_id: string | null; dest_simulation_id: string | null }>;
  activeRevisions: ReadonlyArray<{ id: string; simulation_id: string }>;
}

/**
 * Every reference `commitRows` puts through `IdAllocator.requireInternal`, in commit order.
 *
 * The `what` strings are copied from the call sites so a finding here names the same thing the real
 * error message would. `branch_edges.dest_project_id` is deliberately absent: it is content (a link
 * to another project is allowed to stay pointed there), and `commitRows` maps it by hand.
 */
export function internalReferences(snap: ReferenceSnapshot): InternalReference[] {
  const refs: InternalReference[] = [];
  for (const r of snap.activeRevisions) {
    refs.push({ what: 'sim_revisions.simulation_id', rowId: r.id, value: r.simulation_id, label: `revision ${r.id}` });
  }
  for (const v of snap.videoFiles) {
    refs.push({ what: 'video_files.sequence_id', rowId: v.id, value: v.sequence_id, label: `video "${v.filename}"` });
  }
  for (const s of snap.sections) {
    const label = `section "${s.label ?? '(unnamed)'}"`;
    refs.push({ what: 'timeline_sections.video_file_id', rowId: s.id, value: s.video_file_id, label });
    refs.push({ what: 'timeline_sections.simulation_id', rowId: s.id, value: s.simulation_id, label });
    refs.push({ what: 'timeline_sections.clip_source_video_id', rowId: s.id, value: s.clip_source_video_id, label });
    refs.push({ what: 'timeline_sections.clip_source_image_id', rowId: s.id, value: s.clip_source_image_id, label });
    refs.push({ what: 'timeline_sections.clip_source_audio_id', rowId: s.id, value: s.clip_source_audio_id, label });
  }
  for (const c of snap.choicePoints) {
    refs.push({ what: 'branch_choice_points.sequence_id', rowId: c.id, value: c.sequence_id, label: `choice point ${c.id}` });
  }
  for (const e of snap.edges) {
    const label = `edge "${e.label ?? '(unnamed)'}"`;
    refs.push({ what: 'branch_edges.choice_point_id', rowId: e.id, value: e.choice_point_id, label });
    refs.push({ what: 'branch_edges.dest_sequence_id', rowId: e.id, value: e.dest_sequence_id, label });
    refs.push({ what: 'branch_edges.dest_simulation_id', rowId: e.id, value: e.dest_simulation_id, label });
  }
  for (const c of snap.choicePoints) {
    refs.push({ what: 'branch_choice_points.default_edge_id', rowId: c.id, value: c.default_edge_id, label: `choice point ${c.id}` });
  }
  return refs;
}

/**
 * Ask the REAL allocator, the one the real plan built, about every one of those references.
 *
 * `requireInternal` is injected rather than re-implemented, so this cannot drift from the rule that
 * actually throws: a null is fine, a mapped id is fine, and anything else — a row of another
 * project, or a row that no longer exists — throws. `describe` is an optional lookup that turns
 * "not part of the copy" into "belongs to project X", which is the difference between a finding the
 * user can act on and one they cannot.
 */
export async function checkCrossProjectReferences(
  refs: readonly InternalReference[],
  requireInternal: (value: string | null, what: string) => unknown,
  describe: (value: string) => Promise<string | null> = async () => null,
): Promise<CheckReport> {
  const escaping: Array<InternalReference & { where: string | null }> = [];
  let checked = 0;
  for (const ref of refs) {
    if (ref.value === null) continue;
    checked += 1;
    try {
      requireInternal(ref.value, ref.what);
    } catch {
      escaping.push({ ...ref, where: await describe(ref.value) });
    }
  }

  const findings: Finding[] = [];
  if (escaping.length > 0) {
    findings.push({
      check: 'cross-project',
      severity: 'permanent',
      title: `${escaping.length} reference(s) point outside the project and cannot be copied`,
      detail: [
        '`IdAllocator.requireInternal` throws rather than letting an unmapped id become a stored',
        'reference, so each of these ends the duplication. The fix is in the data: repoint the',
        'reference inside this project, or clear it.',
        // One array entry per LINE: the formatter indents entries, not embedded newlines.
        ...escaping.flatMap((e) => [
          `  ESCAPES  ${e.what} = ${e.value}`,
          `           on          : ${e.label} (row ${e.rowId})`,
          `           target      : ${e.where ?? 'not found in this project — deleted, or owned by another project'}`,
        ]),
      ],
    });
  }
  return {
    id: 'cross-project',
    label: 'Cross-project references',
    status: escaping.length > 0 ? 'fail' : 'pass',
    line: `${escaping.length > 0 ? 'FAIL' : 'PASS'} — ${checked} non-null internal reference(s) checked across `
      + `${new Set(refs.map((r) => r.what)).size} column(s), ${escaping.length} escaping`,
    findings,
    data: { checked, escaping },
  };
}

// ── 5. Storage reachability ───────────────────────────────────────────────────

export interface UrlRoundTrip {
  forward: 'getPublicUrl' | 'getSimPublicUrl';
  key: string;
  url: string;
  recovered: string | null;
  ok: boolean;
}

export interface StorageProbe {
  adapter: string;
  /** The key that was read back, or null when the plan named none to try. */
  probedKey: string | null;
  /** true = read; false = every candidate was absent; null = the store threw. */
  readable: boolean | null;
  readError: string | null;
  candidatesTried: number;
  roundTrips: UrlRoundTrip[];
}

/**
 * Can the configured adapter read at all, and does its public-URL inversion round-trip?
 *
 * THE INVERSION IS NOT A FORMALITY. `corpora.storage_url` stores a URL and no key, so the plan
 * recovers the key with `keyFromPublicUrl` — and when that returns the wrong thing (the documented
 * Supabase case, where a host-pattern heuristic recovered a "key" that still contained the source
 * project id) the plan commits to copying a key that does not exist and `copyObject` throws
 * `NoSuchKey`. Every project with a corpus file becomes un-duplicatable on that backend, for a
 * reason no message names. So the pair is exercised here on a real key of this project.
 */
export function checkStorage(probe: StorageProbe): CheckReport {
  const findings: Finding[] = [];
  const brokenTrips = probe.roundTrips.filter((t) => !t.ok);

  if (probe.candidatesTried === 0) {
    // Nothing to probe is not a failure of the store: a project with no media at all plans only
    // prefix copies. Saying "unreadable" here would skip the dead-key sweep over a healthy project.
    findings.push({
      check: 'storage',
      severity: 'info',
      title: 'the plan names no single object to probe, so reachability was not established',
      detail: [
        'This project copies only prefixes (no video master, image, audio, poster, crop, caption or',
        'corpus object), so there was no cheap key to read back. The prefix listings below still',
        'exercise the adapter.',
      ],
    });
  } else if (probe.readable === null) {
    findings.push({
      check: 'storage',
      severity: 'transient',
      title: `the configured storage adapter (${probe.adapter}) could not be read`,
      detail: [
        probe.readError ?? '(no error text)',
        'Credentials, endpoint or network — not the project. Nothing below this can be trusted, and',
        'the dead-key sweep is deliberately not run.',
      ],
    });
  } else if (probe.readable === false) {
    findings.push({
      check: 'storage',
      severity: 'transient',
      title: `none of the ${probe.candidatesTried} probed key(s) of this project exist in ${probe.adapter}`,
      detail: [
        'The store answered, so this is not a credential error — but a project whose every probed',
        'object is absent usually means the wrong bucket or a restored database, not N dead rows.',
        'Read the dead-key sweep below with that in mind.',
      ],
    });
  }
  if (brokenTrips.length > 0) {
    findings.push({
      check: 'storage',
      severity: 'permanent',
      title: `${probe.adapter} cannot recover a storage key from its own public URL`,
      detail: [
        'Several columns store a URL and no key (corpora.storage_url, avatar_config faces,',
        'guidance_meta.mdUrl). The plan recovers those keys with `keyFromPublicUrl`; when the',
        'inverse does not round-trip, the plan copies keys that do not exist and copyObject throws.',
        ...brokenTrips.flatMap((t) => [
          `  ${t.forward}("${t.key}")`,
          `           published  : ${t.url}`,
          `           recovered  : ${t.recovered ?? 'null'}`,
        ]),
      ],
    });
  }

  const status: CheckStatus = brokenTrips.length > 0 ? 'fail' : probe.readable === true ? 'pass' : 'inconclusive';
  const verb = status === 'fail' ? 'FAIL' : status === 'pass' ? 'PASS' : 'INCONCLUSIVE';
  const readWord = probe.candidatesTried === 0 ? 'no object to probe'
    : probe.readable === true ? `read ${probe.probedKey}`
      : probe.readable === false ? 'no probed key exists'
        : 'unreadable';
  return {
    id: 'storage',
    label: 'Storage reachability',
    status,
    line: `${verb} — adapter ${probe.adapter}: ${readWord}; `
      + `URL inversion ${probe.roundTrips.length - brokenTrips.length}/${probe.roundTrips.length} round-trip`,
    findings,
    data: probe as unknown as Record<string, unknown>,
  };
}

// ── The report ────────────────────────────────────────────────────────────────

export interface DiagnosticReport {
  generatedAt: string;
  readOnly: true;
  project: { id: string; title: string | null };
  adapter: string;
  checks: CheckReport[];
  verdict: Verdict;
}

const RULE = '═'.repeat(96);
const THIN = '─'.repeat(96);

export function formatReport(r: DiagnosticReport): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(' DUPLICATION DIAGNOSIS — READ-ONLY (nothing was written: no rows, no objects, no job)');
  out.push(`   project : ${r.project.id}`);
  out.push(`   title   : ${r.project.title === null ? '(untitled)' : `"${r.project.title}"`}`);
  out.push(`   storage : ${r.adapter}`);
  out.push(`   run at  : ${r.generatedAt}`);
  out.push(RULE);
  out.push('');

  r.checks.forEach((c, i) => {
    out.push(`  [${i + 1}/${r.checks.length}] ${c.label.padEnd(38)} ${c.line}`);
  });
  out.push('');

  for (const c of r.checks) {
    if (c.findings.length === 0) continue;
    out.push(`${THIN}`);
    out.push(`${c.label.toUpperCase()}`);
    for (const f of c.findings) {
      out.push('');
      out.push(`  ${f.severity.toUpperCase().padEnd(10)} ${f.title}`);
      for (const line of f.detail) out.push(`    ${line}`);
    }
    out.push('');
  }

  out.push(RULE);
  out.push(' VERDICT');
  out.push(RULE);
  out.push(` ${r.verdict.headline}`);
  out.push('');
  out.push(' PERMANENT — a retry can never help until these are fixed:');
  out.push(...(r.verdict.permanent.length > 0
    ? r.verdict.permanent.map((f) => `   • [${f.check}] ${f.title}`)
    : ['   (none)']));
  out.push('');
  out.push(' TRANSIENT — a retry may well succeed:');
  out.push(...(r.verdict.transient.length > 0
    ? r.verdict.transient.map((f) => `   • [${f.check}] ${f.title}`)
    : ['   (none)']));
  out.push('');
  out.push(` exit ${r.verdict.exitCode}`);
  out.push('');
  return out.join('\n');
}

// ── Reaching into the duplication module without owning it ────────────────────

/** The two module-private helpers the escape scan is built from. */
export interface ScanInternals {
  copyScopedTables: (projectId: string) => Array<[string, PgTable, SQL]>;
  jsonbScanExpression: (table: string, col: PgColumn) => SQL;
  /** What the report says it scanned with, so a reader knows whether the real rule was used. */
  provenance: string;
}

/**
 * Prefer the duplication module's OWN `copyScopedTables` / `jsonbScanExpression`; fall back, loudly.
 *
 * WHY THIS IS SHAPED LIKE A NEGOTIATION. The scan's value comes from being the same predicate the
 * commit asserts — a second implementation of the exemption list is a report that agrees with a
 * duplication right up until the day it stops agreeing. But the two helpers are module-private
 * today and this script does not own that file, so it asks for them and adapts: an exported
 * function of the expected arity is used; an exported function taking only the column is called
 * that way; anything else falls back to the local mirror below and SAYS SO in the report, because a
 * scan run with a stale exemption list must not be mistaken for the real one.
 */
export function resolveScanInternals(
  mod: Record<string, unknown>,
  fallback: Omit<ScanInternals, 'provenance'>,
): ScanInternals {
  const mirrored: string[] = [];
  let adapted = '';

  const importedTables = mod.copyScopedTables;
  let tables: ScanInternals['copyScopedTables'];
  if (typeof importedTables === 'function' && importedTables.length >= 1) {
    tables = importedTables as ScanInternals['copyScopedTables'];
  } else {
    tables = fallback.copyScopedTables;
    mirrored.push('copyScopedTables');
  }

  const importedScan = mod.jsonbScanExpression;
  let scan: ScanInternals['jsonbScanExpression'];
  if (typeof importedScan === 'function' && importedScan.length >= 2) {
    scan = importedScan as ScanInternals['jsonbScanExpression'];
  } else if (typeof importedScan === 'function' && importedScan.length === 1) {
    // A plausible next shape: the table name folded into the column, or dropped. Called the way it
    // asks to be called rather than refused for not matching yesterday's signature.
    const oneArg = importedScan as (col: PgColumn) => SQL;
    scan = (_table, col) => oneArg(col);
    adapted = ' (jsonbScanExpression adapted to its single-argument form)';
  } else {
    scan = fallback.jsonbScanExpression;
    mirrored.push('jsonbScanExpression');
  }

  const provenance = mirrored.length === 0
    ? `the duplication module's own predicates${adapted}`
    : `a LOCAL MIRROR of ${mirrored.join(' + ')} — MAY BE STALE${adapted}`;
  return { copyScopedTables: tables, jsonbScanExpression: scan, provenance };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Bounded-concurrency map. Storage probes are network-bound and a project can have hundreds. */
export async function mapPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** The eight methods a diagnosis is allowed to call. Everything else on the adapter writes. */
export const STORAGE_READ_METHODS: readonly string[] = [
  'getPublicUrl', 'getSimPublicUrl', 'keyFromPublicUrl',
  'readObject', 'listObjects', 'objectExists', 'headObject', 'getPresignedDownloadUrl',
];

export class StorageWriteRefused extends Error {
  constructor(method: string) {
    super(`diagnose-duplication is read-only: refused storage.${method}()`);
    this.name = 'StorageWriteRefused';
  }
}

/**
 * The configured adapter with every writing method replaced by a throw.
 *
 * This is what makes "read-only" structural rather than a claim in a comment: the service is
 * constructed with THIS, so any path inside `loadSnapshot` or `buildPlan` that reached for
 * `copyObject`, `uploadFile` or `deleteWithPrefix` — today or after someone edits that file —
 * aborts the diagnosis instead of mutating the user's production storage.
 */
export function readOnlyStorage(real: StorageService): StorageService {
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Data properties (and `then`, which is absent — so awaiting the proxy stays safe) pass
      // through untouched; only callable members are gated.
      if (typeof value !== 'function') return value;
      if (typeof prop === 'string' && STORAGE_READ_METHODS.includes(prop)) {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return () => { throw new StorageWriteRefused(String(prop)); };
    },
    set(_target, prop) { throw new StorageWriteRefused(`set ${String(prop)}`); },
  });
}

// ── The scan itself ───────────────────────────────────────────────────────────

/**
 * The local mirror of `jsonbScanExpression`, used only when the real one cannot be imported.
 *
 * It must stay identical to the private one in `ProjectDuplicationService`, exemption for
 * exemption — which is exactly why `resolveScanInternals` prefers the import and why a report
 * produced with this one says so on its own summary line.
 */
export function localJsonbScanExpression(table: string, col: PgColumn): SQL {
  return table === 'sim_revisions' && col.name === 'metadata'
    ? sql`(COALESCE(${col}, '{}'::jsonb) - 'duplicatedFrom')`
    : sql`COALESCE(${col}, '{}'::jsonb)`;
}

/**
 * The residual predicate for a column the duplication rewrites in part: the document MINUS exactly
 * the fields `commitRows` re-roots. See `checkEscapeScan` for why the raw count is not the verdict.
 *
 * EVERY CASE IS GUARDED ON `jsonb_typeof`, FOR TWO SEPARATE REASONS, both found by running these
 * against a real engine rather than by reading them:
 *
 *  • CORRECTNESS. Each of the rewriters this mirrors returns the document UNCHANGED when it is not
 *    the shape it expects — `rewriteGuidanceMeta` bails unless it is a plain object,
 *    `rewriteGuidanceAudioUrls` unless it is an array. So for any other shape the duplication
 *    rewrites NOTHING, and the residual is therefore the whole document, not an empty one.
 *    Subtracting anyway would report a document that really does escape as harmless.
 *  • SURVIVAL. `jsonb - text` and `jsonb #- path` raise `cannot delete from scalar` (SQLSTATE 22023)
 *    on a scalar or an array, which would take down the entire diagnosis — on the exact odd data
 *    that most deserves diagnosing.
 */
export function residualExpression(table: string, column: string, col: PgColumn): SQL | null {
  /** The document itself: what the duplication leaves alone when it does not recognise the shape. */
  const whole = sql`COALESCE(${col}, '{}'::jsonb)`;
  const object = (minus: SQL): SQL =>
    sql`(CASE WHEN jsonb_typeof(${col}) = 'object' THEN ${minus} ELSE ${whole} END)`;
  const array = (field: string): SQL => sql`(CASE WHEN jsonb_typeof(${col}) = 'array' THEN (
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - ${field} ELSE e END), '[]'::jsonb)
    FROM jsonb_array_elements(${col}) e
  ) ELSE ${whole} END)`;

  switch (`${table}.${column}`) {
    case 'projects.avatar_config':      return object(sql`${col} #- '{avatarCircles,faces}'`);
    case 'simulations.guidance':        return array('audioUrl');
    case 'simulations.guidance_meta':   return object(sql`${col} - 'mdUrl'`);
    case 'avatar_visuals.visual_spec':  return object(sql`${col} - 'entryKey'`);
    case 'sim_posters.variants':        return array('path');
    default:                            return null;
  }
}

/**
 * The escape scan's jsonb half, pointed at the SOURCE project instead of at a copy.
 *
 * `assertNoEscapingReferences` asks "does anything in the COPY still name the original?" after the
 * copy exists. The same question can be asked before one does — "if this project were copied, which
 * jsonb documents would still name it?" — by running the identical predicate over the source's own
 * rows. Same table list, same per-column expression, same `::text LIKE '%id%'`; only the scope moves.
 *
 * Two numbers come back per column, and the second is the one with an opinion. See `checkEscapeScan`.
 */
export async function scanJsonbColumns(
  exec: ReadOnlyExec,
  internals: ScanInternals,
  projectId: string,
): Promise<JsonbHit[]> {
  const needle = `%${projectId}%`;
  const found: JsonbHit[] = [];

  for (const [label, table, scope] of internals.copyScopedTables(projectId)) {
    for (const col of Object.values(getTableColumns(table)) as PgColumn[]) {
      if (col.columnType !== 'PgJsonb') continue;
      const count = async (body: SQL): Promise<{ rows: number; excerpt: string | null }> => {
        const text = sql`${body}::text`;
        const [row] = await exec.select({
          n: sql<number>`count(*)`.as('n'),
          // ONE WINDOW around the first occurrence, never the document: these columns hold the
          // author's knowledge base, script and captions, and this report gets pasted into support
          // threads.
          excerpt: sql<string | null>`min(substring(${text} from greatest(1, position(${projectId} in ${text}) - 60) for 180))`.as('excerpt'),
        }).from(table).where(and(scope, sql`${text} LIKE ${needle}`));
        return { rows: Number(row?.n ?? 0), excerpt: row?.excerpt ?? null };
      };

      const raw = await count(internals.jsonbScanExpression(label, col));
      // The residual is only worth a second query when there is something to subtract from.
      const residualBody = raw.rows > 0 ? residualExpression(label, col.name, col) : null;
      const residual = residualBody ? await count(residualBody) : null;
      found.push({
        table: label,
        column: col.name,
        rows: raw.rows,
        residualRows: residual ? residual.rows : null,
        excerpt: redactExcerpt(raw.excerpt, projectId),
        residualExcerpt: residual ? redactExcerpt(residual.excerpt, projectId) : null,
      });
    }
  }
  return found;
}

// ── The IO half ───────────────────────────────────────────────────────────────

/**
 * Could not run. Exits 2, never 1 — a script keying on this tool must be able to tell "this project
 * has a permanent blocker" from "the diagnosis itself did not happen".
 */
function cannotRun(asJson: boolean, reason: string, extra: Record<string, unknown> = {}): never {
  if (asJson) console.log(JSON.stringify({ readOnly: true, ok: false, reason, ...extra }, null, 2));
  else {
    console.error(`error: ${reason}`);
    for (const line of Object.values(extra).flatMap((v) => Array.isArray(v) ? v : [])) console.error(`  ${line}`);
  }
  process.exit(EXIT_USAGE);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(EXIT_OK); }
  if (args.errors.length > 0) {
    if (args.json) cannotRun(true, 'bad arguments', { errors: args.errors });
    for (const e of args.errors) console.error(`error: ${e}`);
    console.error(`\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  // Lazily, with the rest of the IO: importing any of these at module scope opens a database
  // client, which would make the unit suite need one.
  const [{ db }, schema, { getStorageAdapter }, dupModule, drizzle] = await Promise.all([
    import('../db/index.js'),
    import('../db/schema.js'),
    import('../services/storage/getStorageAdapter.js'),
    import('../services/project/ProjectDuplicationService.js') as Promise<Record<string, unknown>>,
    import('drizzle-orm'),
  ]);
  const { eq } = drizzle;
  const { ProjectDuplicationService, duplicateMaxBytes } = dupModule as unknown as
    typeof import('../services/project/ProjectDuplicationService.js');

  const realStorage = getStorageAdapter();
  const adapterName = realStorage.constructor.name;
  const storage = readOnlyStorage(realStorage);
  const service = new ProjectDuplicationService(storage);

  /** Every statement this script issues, inside a transaction PostgreSQL will not let write. */
  const readOnly = async <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return fn(tx);
    });

  // ── Resolve the project ──
  const target = await readOnly(async (tx) => {
    if (args.projectId) {
      const [row] = await tx.select({ id: schema.projects.id, title: schema.projects.title })
        .from(schema.projects).where(eq(schema.projects.id, args.projectId));
      return row ? { kind: 'resolved' as const, project: row } : { kind: 'none' as const, needle: args.projectId };
    }
    const rows = await tx.select({ id: schema.projects.id, title: schema.projects.title }).from(schema.projects);
    return resolveTitle(rows, args.title!);
  });

  if (target.kind === 'none') {
    cannotRun(args.json, args.projectId
      ? `no project with id ${args.projectId}`
      : `no project whose title contains "${target.needle}"`);
  }
  if (target.kind === 'ambiguous') {
    cannotRun(
      args.json,
      `"${target.needle}" matches ${target.matches.length} projects — nothing was diagnosed; name one of them and re-run`,
      { matches: target.matches.map((m) => `--project ${m.id}   "${m.title ?? '(untitled)'}"`) },
    );
  }
  const project = target.project;

  // ── 1. Plan ──
  // `dryRun` is exactly `loadSnapshot` then `buildPlan`; they are called separately ONLY so a throw
  // can be reported with the phase it happened in, which is half the diagnosis when it throws.
  let snapshot: Awaited<ReturnType<typeof service.loadSnapshot>> = null;
  let planned: ReturnType<typeof service.buildPlan> | null = null;
  const outcome: PlanOutcome = { phase: 'snapshot', plan: null, error: null };
  try {
    snapshot = await service.loadSnapshot(project.id);
    if (!snapshot) {
      outcome.error = 'the project row disappeared between resolving it and reading it';
    } else {
      outcome.phase = 'plan';
      planned = service.buildPlan(snapshot);
      outcome.plan = planned.plan;
    }
  } catch (err) {
    outcome.error = errorText(err);
  }

  const plan = outcome.plan;
  const planCheck = checkPlan(outcome, {
    maxBytes: duplicateMaxBytes(),
    oversizeRefusal: plan ? (ProjectDuplicationService.oversizeRefusal(plan)?.message ?? null) : null,
  });

  const checks: CheckReport[] = [planCheck];

  if (!plan || !snapshot || !planned) {
    for (const [id, label] of [
      ['storage', 'Storage reachability'], ['dead-keys', 'Dead source keys'],
      ['escape-scan', 'Escape scan (source jsonb)'], ['cross-project', 'Cross-project references'],
    ] as const) {
      checks.push({ id, label, status: 'inconclusive', line: 'NOT RUN — there is no plan to check', findings: [], data: {} });
    }
    finish(project, adapterName, checks, args.json);
    return;
  }

  // ── 5. Storage reachability (run BEFORE the dead-key sweep — see the header) ──
  // A CORPUS KEY FIRST, when the plan has one. `corpora.storage_url` is the column whose key is
  // recovered from a URL rather than stored, so it is the one the inversion actually decides — and
  // it is the exact shape that made every project with a corpus file un-duplicatable on Supabase.
  const candidates = plan.storage
    .filter((c) => c.kind === 'object')
    .sort((a, b) => Number(b.reason.startsWith('corpus')) - Number(a.reason.startsWith('corpus')))
    .slice(0, 5).map((c) => c.from);
  const probe: StorageProbe = {
    adapter: adapterName, probedKey: null, readable: null,
    readError: null, candidatesTried: candidates.length, roundTrips: [],
  };
  for (const key of candidates) {
    try {
      if (await storage.objectExists(key)) { probe.probedKey = key; probe.readable = true; break; }
      probe.readable = false;
    } catch (err) {
      probe.readable = null;
      probe.readError = errorText(err);
      break;
    }
  }
  const roundTripKey = probe.probedKey ?? candidates[0] ?? null;
  if (roundTripKey) {
    for (const forward of ['getPublicUrl', 'getSimPublicUrl'] as const) {
      const url = storage[forward](roundTripKey);
      const recovered = storage.keyFromPublicUrl(url);
      probe.roundTrips.push({ forward, key: roundTripKey, url, recovered, ok: recovered === roundTripKey });
    }
  }
  checks.push(checkStorage(probe));

  // ── 2. Dead source keys ──
  // Skipped ONLY when the store refused to answer. "Nothing to probe" and "the probed keys are
  // absent" are both answers, and the sweep is exactly what should look into them.
  checks.push(probe.readError !== null
    ? deadKeysNotRun(`${adapterName} could not be read: ${probe.readError}`)
    : await checkDeadSourceKeys(
      plan.storage,
      { head: (k) => storage.objectExists(k), list: (p) => storage.listObjects(p) },
      keyOwners(snapshot),
    ));

  // ── 3. Escape scan against the source ──
  const localTables = (id: string): Array<[string, PgTable, SQL]> => {
    const ofACopiedSim = (column: PgColumn): SQL =>
      sql`${column} IN (SELECT ${schema.simulations.id} FROM ${schema.simulations} WHERE ${schema.simulations.project_id} = ${id})`;
    return [
      ['projects', schema.projects, eq(schema.projects.id, id)],
      ['video_files', schema.video_files, eq(schema.video_files.project_id, id)],
      ['image_files', schema.image_files, eq(schema.image_files.project_id, id)],
      ['audio_files', schema.audio_files, eq(schema.audio_files.project_id, id)],
      ['timeline_sections', schema.timeline_sections, eq(schema.timeline_sections.project_id, id)],
      ['timeline_markers', schema.timeline_markers, eq(schema.timeline_markers.project_id, id)],
      ['branch_sequences', schema.branch_sequences, eq(schema.branch_sequences.project_id, id)],
      ['branch_choice_points', schema.branch_choice_points, eq(schema.branch_choice_points.project_id, id)],
      ['branch_edges', schema.branch_edges, eq(schema.branch_edges.project_id, id)],
      ['simulations', schema.simulations, eq(schema.simulations.project_id, id)],
      ['scripts', schema.scripts, eq(schema.scripts.project_id, id)],
      ['scenes', schema.scenes, eq(schema.scenes.project_id, id)],
      ['camera_plans', schema.camera_plans, eq(schema.camera_plans.project_id, id)],
      ['corpora', schema.corpora, eq(schema.corpora.project_id, id)],
      ['avatar_visuals', schema.avatar_visuals, eq(schema.avatar_visuals.project_id, id)],
      ['sim_revisions', schema.sim_revisions, ofACopiedSim(schema.sim_revisions.simulation_id)],
      ['sim_posters', schema.sim_posters, ofACopiedSim(schema.sim_posters.simulation_id)],
    ];
  };
  const internals = resolveScanInternals(dupModule, {
    copyScopedTables: localTables, jsonbScanExpression: localJsonbScanExpression,
  });

  const hits = await readOnly((tx) => scanJsonbColumns(tx, internals, project.id));
  checks.push(checkEscapeScan(hits, internals.provenance));

  // ── 4. Cross-project references ──
  const describe = async (value: string): Promise<string | null> => readOnly(async (tx) => {
    for (const [table, column] of [
      [schema.simulations, 'simulations'], [schema.branch_sequences, 'branch_sequences'],
      [schema.video_files, 'video_files'], [schema.image_files, 'image_files'],
      [schema.audio_files, 'audio_files'], [schema.branch_choice_points, 'branch_choice_points'],
      [schema.branch_edges, 'branch_edges'],
    ] as const) {
      const cols = getTableColumns(table) as Record<string, PgColumn>;
      const [row] = await tx.select({ p: cols.project_id }).from(table).where(eq(cols.id, value));
      if (row) return `row exists in ${column}, owned by project ${row.p ?? '(none)'}`;
    }
    return null;
  });
  checks.push(await checkCrossProjectReferences(
    internalReferences(snapshot),
    (value, what) => planned.ids.requireInternal(value, what),
    describe,
  ));

  finish(project, adapterName, checks, args.json);
}

function finish(
  project: { id: string; title: string | null },
  adapter: string,
  checks: CheckReport[],
  asJson: boolean,
): void {
  const report: DiagnosticReport = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    project,
    adapter,
    checks,
    verdict: verdictOf(checks),
  };
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.verdict.exitCode);
}

// Only when executed directly — importing this module for its pure half must not run a diagnosis.
if (process.argv[1] && /diagnose-duplication\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    // EXIT 2, not 1. A diagnosis that could not connect, could not authenticate or crashed has NOT
    // found a permanent blocker, and the exit code is the only thing a wrapper script reads.
    console.error(`\nThe diagnosis itself failed — this is not a verdict about the project:\n`);
    console.error(e);
    process.exit(EXIT_USAGE);
  });
}
