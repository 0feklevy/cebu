/**
 * Static migration audit. Schema migrations are applied by
 * backend-api/src/db/migrate.ts, which runs each .sql file as ONE multi-statement
 * simple query (an implicit transaction) and tracks filenames in schema_migrations.
 *
 * The audit reports, for the release plan:
 *   - new migration files since the base ref (previous release), with checksums;
 *   - ordering violations (numeric prefixes must stay monotonic);
 *   - history rewrites (a previously-released file whose checksum changed);
 *   - runner drift (file on disk missing from migrate.ts's hardcoded list, or vice versa);
 *   - per-statement classification: destructive / data-modifying / lock-risk /
 *     runner-incompatible / compat-risk / additive;
 *   - backward-compatibility concerns (the previous app image must keep working).
 *
 * NOTE: rollback restores code images only. There is NO automatic database rollback,
 * and this audit never claims one exists.
 */
import { createHash } from 'node:crypto';
import { finding, type Finding } from './severity.js';

export interface MigrationFile {
  name: string;
  content: string;
}

export type StatementClass =
  | 'destructive'
  | 'data-modifying'
  | 'lock-risk'
  | 'runner-incompatible'
  | 'compat-risk'
  | 'additive';

export interface ClassifiedStatement {
  class: StatementClass;
  /** First ~120 chars of the normalized statement (safe: DDL, not data). */
  excerpt: string;
  reason: string;
}

export interface AuditedMigration {
  name: string;
  checksum: string;
  statements: number;
  classes: ClassifiedStatement[];
  tables: string[];
  /** False when the file contains statements that cannot run inside a transaction. */
  transactional: boolean;
}

export interface MigrationAuditInput {
  diskFiles: MigrationFile[];
  /** Migration filenames present at the base ref (the previous release). */
  baseNames: string[];
  /** name -> sha256 at the base ref, for history-rewrite detection. */
  baseChecksums?: Record<string, string>;
  /** Contents of migrate.ts (the hardcoded ordered list lives there). */
  runnerSource: string;
  /** Directory entries that are intentionally not run (e.g. phase2-schema.sql). */
  excluded: readonly string[];
  filePattern: RegExp;
}

export interface MigrationAuditResult {
  newMigrations: AuditedMigration[];
  findings: Finding[];
  summary: {
    newCount: number;
    destructiveCount: number;
    runnerListCount: number;
    diskCount: number;
  };
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Strip SQL comments and split into statements on top-level semicolons. */
export function splitSqlStatements(sql: string): string[] {
  let s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Neutralize dollar-quoted bodies (function definitions) so inner semicolons don't split.
  s = s.replace(/\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$/g, ' $BODY$ ');
  return s
    .split(';')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 0);
}

const excerptOf = (stmt: string) => (stmt.length > 120 ? `${stmt.slice(0, 117)}…` : stmt);

export function classifyStatement(stmt: string): ClassifiedStatement | null {
  const s = stmt.toUpperCase();
  const mk = (cls: StatementClass, reason: string): ClassifiedStatement => ({ class: cls, excerpt: excerptOf(stmt), reason });

  if (/\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/.test(s) || /\bDROP\s+INDEX\s+CONCURRENTLY\b/.test(s)) {
    return mk('runner-incompatible', 'CONCURRENTLY cannot run inside a transaction; the runner executes each file as one implicit transaction — this statement would fail the migration.');
  }
  if (/\bVACUUM\b/.test(s) || /\bREINDEX\s+DATABASE\b/.test(s)) {
    return mk('runner-incompatible', 'Cannot run inside a transaction (the runner wraps each file in one).');
  }
  if (/\bDROP\s+TABLE\b/.test(s)) return mk('destructive', 'Drops a table — data loss; previous app image may still read it.');
  if (/\bDROP\s+COLUMN\b/.test(s)) return mk('destructive', 'Drops a column — data loss; previous app image may still read it.');
  if (/\bTRUNCATE\b/.test(s)) return mk('destructive', 'Truncates data.');
  if (/\bDELETE\s+FROM\b/.test(s) && !/\bWHERE\b/.test(s)) return mk('destructive', 'Unbounded DELETE (no WHERE clause).');
  if (/\bUPDATE\b/.test(s) && !/\bWHERE\b/.test(s)) return mk('data-modifying', 'Unbounded UPDATE (no WHERE clause) — affects every row.');
  if (/\bDELETE\s+FROM\b/.test(s) || /\bUPDATE\b/.test(s)) return mk('data-modifying', 'Modifies existing rows.');
  if (/\bRENAME\s+(TO|COLUMN)\b/.test(s)) {
    return mk('compat-risk', 'Rename breaks expand/contract: the previous app image still uses the old name.');
  }
  if (/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/.test(s)) {
    return mk('compat-risk', 'Column type change — potential table rewrite + previous-image compatibility risk.');
  }
  if (/\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/.test(s)) {
    return mk('compat-risk', 'SET NOT NULL — fails if the previous app image inserts NULLs.');
  }
  if (/\bADD\s+COLUMN\b/.test(s) && /\bNOT\s+NULL\b/.test(s) && !/\bDEFAULT\b/.test(s)) {
    return mk('compat-risk', 'NOT NULL column without DEFAULT — fails on non-empty tables and breaks previous-image inserts.');
  }
  if (/\bCREATE\s+(UNIQUE\s+)?INDEX\b/.test(s)) {
    return mk('lock-risk', 'Non-concurrent index build takes a write lock for its duration.');
  }
  if (/\bDROP\s+INDEX\b/.test(s)) return mk('lock-risk', 'Dropping an index can regress query plans.');
  return null; // additive / neutral (CREATE TABLE, ADD COLUMN with default, etc.)
}

/** Extract the hardcoded migration list from migrate.ts source (order preserved). */
export function runnerListFromSource(source: string): string[] {
  const m = source.match(/const\s+migrations\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+\.sql)'/g)].map((x) => x[1]);
}

const numericPrefix = (name: string): number | null => {
  const m = name.match(/^(\d+)_/);
  return m ? Number(m[1]) : null;
};

export function auditMigrations(input: MigrationAuditInput): MigrationAuditResult {
  const findings: Finding[] = [];
  const excluded = new Set(input.excluded);
  const allSql = input.diskFiles.filter((f) => !excluded.has(f.name));

  // Only canonical NNN_snake_case.sql files are runnable migrations. `.rollback.sql`
  // companions are manual, forward-only-runner rollback helpers by repo convention;
  // anything else unrecognized is a hazard (the runner would silently never apply it).
  const disk = allSql.filter((f) => input.filePattern.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const f of allSql.filter((x) => !input.filePattern.test(x.name))) {
    if (/\.rollback\.sql$/i.test(f.name)) {
      findings.push(
        finding('migrations.rollback-helper', 'INFO', 'migrations', `${f.name} is a manual rollback helper (not run by the migration runner).`),
      );
    } else {
      findings.push(
        finding('migrations.unrecognized-file', 'HIGH', 'migrations', `${f.name} is neither a canonical NNN_snake_case.sql migration nor a .rollback.sql helper — the runner will silently never apply it.`, {
          remediation: 'Rename it to the canonical pattern (and add it to migrate.ts) or remove it.',
        }),
      );
    }
  }
  const diskNames = disk.map((f) => f.name);
  const baseSet = new Set(input.baseNames.filter((n) => !excluded.has(n)));
  const newFiles = disk.filter((f) => !baseSet.has(f.name));
  const maxBase = Math.max(0, ...[...baseSet].map((n) => numericPrefix(n) ?? 0));
  for (const f of newFiles) {
    const n = numericPrefix(f.name);
    if (n !== null && n <= maxBase) {
      findings.push(
        finding('migrations.out-of-order', 'CRITICAL', 'migrations', `New migration ${f.name} sorts BEFORE already-released migration #${String(maxBase).padStart(3, '0')} — it would never run in order on existing databases.`),
      );
    }
  }
  const prefixes = diskNames.map(numericPrefix).filter((n): n is number => n !== null);
  const dupes = prefixes.filter((n, i) => prefixes.indexOf(n) !== i);
  for (const d of [...new Set(dupes)]) {
    findings.push(finding('migrations.duplicate-prefix', 'CRITICAL', 'migrations', `Two migration files share the numeric prefix ${d} — apply order is ambiguous.`));
  }

  // --- history rewrites ------------------------------------------------------------
  if (input.baseChecksums) {
    for (const f of disk) {
      const baseSum = input.baseChecksums[f.name];
      if (baseSum && baseSum !== sha256(f.content)) {
        findings.push(
          finding('migrations.history-rewrite', 'CRITICAL', 'migrations', `Already-released migration ${f.name} was modified — applied databases and source have diverged.`, {
            remediation: 'Revert the edit and add a NEW migration instead.',
          }),
        );
      }
    }
  }

  // --- runner drift ------------------------------------------------------------
  const runnerList = runnerListFromSource(input.runnerSource);
  if (runnerList.length === 0) {
    findings.push(finding('migrations.runner-list-missing', 'CRITICAL', 'migrations', 'Could not extract the migration list from migrate.ts — audit cannot prove the runner applies new files.'));
  } else {
    for (const name of diskNames) {
      if (!runnerList.includes(name)) {
        findings.push(
          finding('migrations.not-in-runner', 'CRITICAL', 'migrations', `Migration file ${name} exists on disk but is NOT in migrate.ts's list — it would silently never run.`),
        );
      }
    }
    for (const name of runnerList) {
      if (!diskNames.includes(name)) {
        findings.push(
          finding('migrations.missing-file', 'CRITICAL', 'migrations', `migrate.ts lists ${name} but the file does not exist — the migration run would crash.`),
        );
      }
    }
    const common = runnerList.filter((n) => diskNames.includes(n));
    const sortedCommon = [...common].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(common) !== JSON.stringify(sortedCommon)) {
      findings.push(finding('migrations.runner-order', 'CRITICAL', 'migrations', 'migrate.ts list order differs from filename order — apply order is ambiguous.'));
    }
  }

  // --- per-file classification ------------------------------------------------
  const newMigrations: AuditedMigration[] = newFiles.map((f) => {
    const statements = splitSqlStatements(f.content);
    const classes = statements.map(classifyStatement).filter((c): c is ClassifiedStatement => c !== null);
    const tables = [
      ...new Set(
        [...f.content.matchAll(/\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/gi)]
          .concat([...f.content.matchAll(/\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+"?([a-zA-Z0-9_]+)"?/gi)])
          .map((m) => m[1].toLowerCase()),
      ),
    ];
    return {
      name: f.name,
      checksum: sha256(f.content),
      statements: statements.length,
      classes,
      tables,
      transactional: !classes.some((c) => c.class === 'runner-incompatible'),
    };
  });

  for (const m of newMigrations) {
    for (const c of m.classes) {
      if (c.class === 'runner-incompatible') {
        findings.push(finding('migrations.runner-incompatible', 'CRITICAL', 'migrations', `${m.name}: ${c.reason}`, { detail: c.excerpt }));
      } else if (c.class === 'destructive') {
        findings.push(
          finding('migrations.destructive', 'HIGH', 'migrations', `${m.name} contains a likely-destructive statement.`, {
            detail: `${c.excerpt} — ${c.reason}`,
            remediation: 'Destructive DDL requires explicit approval (approveHigh) and an expand/contract plan.',
          }),
        );
      } else if (c.class === 'compat-risk') {
        findings.push(
          finding('migrations.compat-risk', 'HIGH', 'migrations', `${m.name} risks breaking the PREVIOUS app image (rollback target).`, {
            detail: `${c.excerpt} — ${c.reason}`,
          }),
        );
      } else if (c.class === 'data-modifying' || c.class === 'lock-risk') {
        findings.push(finding(`migrations.${c.class}`, 'WARNING', 'migrations', `${m.name}: ${c.reason}`, { detail: c.excerpt }));
      }
    }
  }

  return {
    newMigrations,
    findings,
    summary: {
      newCount: newFiles.length,
      destructiveCount: newMigrations.reduce((n, m) => n + m.classes.filter((c) => c.class === 'destructive').length, 0),
      runnerListCount: runnerList.length,
      diskCount: diskNames.length,
    },
  };
}
