import { describe, expect, it } from 'vitest';
import { auditMigrations, classifyStatement, runnerListFromSource, sha256, splitSqlStatements } from '../migration-audit.js';

const PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/i;

const runnerSource = (names: string[]) => `const migrations = [${names.map((n) => `'${n}'`).join(', ')}];`;

function input(overrides: Partial<Parameters<typeof auditMigrations>[0]> = {}) {
  return {
    diskFiles: [
      { name: '046_token_usage_cost_precision.sql', content: 'ALTER TABLE token_usage ALTER COLUMN cost TYPE numeric(12,6);' },
      { name: '047_new_feature.sql', content: 'CREATE TABLE IF NOT EXISTS widgets (id uuid PRIMARY KEY);' },
    ],
    baseNames: ['046_token_usage_cost_precision.sql'],
    runnerSource: runnerSource(['046_token_usage_cost_precision.sql', '047_new_feature.sql']),
    excluded: ['phase2-schema.sql'],
    filePattern: PATTERN,
    ...overrides,
  };
}

describe('splitSqlStatements', () => {
  it('strips comments and splits on semicolons', () => {
    const sql = `-- add table\nCREATE TABLE a (id int); /* two */ ALTER TABLE a ADD COLUMN b int;`;
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('does not split inside dollar-quoted bodies', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT 1; SELECT 2; END $$ LANGUAGE plpgsql;`;
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });
});

describe('classifyStatement', () => {
  const cases: Array<[string, string | null]> = [
    ['CREATE TABLE x (id int)', null],
    ['ALTER TABLE x ADD COLUMN y text', null],
    ["ALTER TABLE x ADD COLUMN y text NOT NULL DEFAULT ''", null],
    ['ALTER TABLE x ADD COLUMN y text NOT NULL', 'compat-risk'],
    ['DROP TABLE x', 'destructive'],
    ['ALTER TABLE x DROP COLUMN y', 'destructive'],
    ['TRUNCATE x', 'destructive'],
    ['DELETE FROM x', 'destructive'],
    ['DELETE FROM x WHERE id = 1', 'data-modifying'],
    ['UPDATE x SET a = 1', 'data-modifying'],
    ['ALTER TABLE x RENAME COLUMN a TO b', 'compat-risk'],
    ['ALTER TABLE x ALTER COLUMN a TYPE bigint', 'compat-risk'],
    ['ALTER TABLE x ALTER COLUMN a SET NOT NULL', 'compat-risk'],
    ['CREATE INDEX idx ON x (a)', 'lock-risk'],
    ['CREATE INDEX CONCURRENTLY idx ON x (a)', 'runner-incompatible'],
  ];
  for (const [stmt, expected] of cases) {
    it(`${stmt} -> ${expected ?? 'additive'}`, () => {
      expect(classifyStatement(stmt)?.class ?? null).toBe(expected);
    });
  }
});

describe('runnerListFromSource', () => {
  it('extracts the ordered hardcoded list from migrate.ts', () => {
    expect(runnerListFromSource(runnerSource(['001_a.sql', '002_b.sql']))).toEqual(['001_a.sql', '002_b.sql']);
  });
});

describe('auditMigrations', () => {
  it('clean additive migration passes with no findings', () => {
    const res = auditMigrations(input());
    expect(res.findings).toEqual([]);
    expect(res.newMigrations).toHaveLength(1);
    expect(res.newMigrations[0].name).toBe('047_new_feature.sql');
    expect(res.newMigrations[0].transactional).toBe(true);
    expect(res.newMigrations[0].checksum).toBe(sha256('CREATE TABLE IF NOT EXISTS widgets (id uuid PRIMARY KEY);'));
  });

  it('flags a new migration missing from the runner list as CRITICAL', () => {
    const res = auditMigrations(input({ runnerSource: runnerSource(['046_token_usage_cost_precision.sql']) }));
    expect(res.findings.some((f) => f.id === 'migrations.not-in-runner' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('flags a runner entry with no file as CRITICAL', () => {
    const res = auditMigrations(
      input({ runnerSource: runnerSource(['046_token_usage_cost_precision.sql', '047_new_feature.sql', '048_ghost.sql']) }),
    );
    expect(res.findings.some((f) => f.id === 'migrations.missing-file')).toBe(true);
  });

  it('flags history rewrites of already-released files as CRITICAL', () => {
    const res = auditMigrations(
      input({ baseChecksums: { '046_token_usage_cost_precision.sql': sha256('original content') } }),
    );
    expect(res.findings.some((f) => f.id === 'migrations.history-rewrite')).toBe(true);
  });

  it('flags out-of-order new migrations as CRITICAL', () => {
    const res = auditMigrations(
      input({
        diskFiles: [
          { name: '045_existing.sql', content: 'CREATE TABLE a (id int);' },
          { name: '044_late_arrival.sql', content: 'CREATE TABLE b (id int);' },
        ],
        baseNames: ['045_existing.sql'],
        runnerSource: runnerSource(['044_late_arrival.sql', '045_existing.sql']),
      }),
    );
    expect(res.findings.some((f) => f.id === 'migrations.out-of-order')).toBe(true);
  });

  it('treats .rollback.sql companions as INFO helpers, not runner drift (repo convention)', () => {
    const res = auditMigrations(
      input({
        diskFiles: [
          { name: '046_token_usage_cost_precision.sql', content: 'ALTER TABLE token_usage ALTER COLUMN cost TYPE numeric(12,6);' },
          { name: '030_course_publishing.rollback.sql', content: 'DROP TABLE courses;' },
        ],
        runnerSource: runnerSource(['046_token_usage_cost_precision.sql']),
      }),
    );
    expect(res.findings.map((f) => `${f.severity}:${f.id}`)).toEqual(['INFO:migrations.rollback-helper']);
  });

  it('flags unrecognized sql files (typo’d names the runner would silently skip) as HIGH', () => {
    const res = auditMigrations(
      input({
        diskFiles: [
          { name: '046_token_usage_cost_precision.sql', content: 'ALTER TABLE token_usage ALTER COLUMN cost TYPE numeric(12,6);' },
          { name: '47-new-feature.sql', content: 'CREATE TABLE widgets (id int);' },
        ],
        runnerSource: runnerSource(['046_token_usage_cost_precision.sql']),
      }),
    );
    expect(res.findings.some((f) => f.id === 'migrations.unrecognized-file' && f.severity === 'HIGH')).toBe(true);
  });

  it('classifies destructive migrations as HIGH and CONCURRENTLY as CRITICAL', () => {
    const res = auditMigrations(
      input({
        diskFiles: [
          { name: '046_token_usage_cost_precision.sql', content: 'ALTER TABLE token_usage ALTER COLUMN cost TYPE numeric(12,6);' },
          { name: '047_cleanup.sql', content: 'DROP TABLE old_stuff; CREATE INDEX CONCURRENTLY idx ON x (a);' },
        ],
        runnerSource: runnerSource(['046_token_usage_cost_precision.sql', '047_cleanup.sql']),
      }),
    );
    const destructive = res.findings.find((f) => f.id === 'migrations.destructive');
    const incompatible = res.findings.find((f) => f.id === 'migrations.runner-incompatible');
    expect(destructive?.severity).toBe('HIGH');
    expect(incompatible?.severity).toBe('CRITICAL');
    expect(res.newMigrations[0].transactional).toBe(false);
    expect(res.newMigrations[0].tables).toContain('old_stuff');
  });
});
