#!/usr/bin/env node
/**
 * fleet-guard.mjs — PreToolUse guard for the FlowVid agent fleet.  (v2)
 *
 * v1 was a denylist of command spellings. `fleet-maintainer` broke it 13 ways in its first run
 * (see .claude/review/FLEET-AUDIT.md §6): `sed -i`, `tee`, `>` redirect, `..` through the Write
 * allowlist, `Grep path=.env`, `.ENV` on a case-insensitive filesystem, `git -C … push`,
 * `pnpm -C … install`, `tsx migrate.ts`, bare `rm`, `scp .env vm:`, and more. Denylists of shell
 * syntax do not hold. v2 inverts the model:
 *
 *   readonly — Bash is an ALLOWLIST. Every segment of the command line must start with a verb a
 *              reviewer legitimately needs. Anything else is denied by default.
 *   writer   — review-fixer. Bash stays a denylist (it must be able to build and edit), but a
 *              hardened one; secrets and state mutation are still absolutely denied.
 *   secrets  — the fleet-wide floor wired from .claude/settings.json. Secrets only, so it can
 *              apply to every agent and the main session without getting in the way.
 *
 * Contract: exit 0 printing nothing → no opinion, normal permission flow applies.
 *           exit 0 printing deny JSON → blocked, with a reason the agent can read.
 * Fails OPEN on a parse error so a malformed payload can never brick a run.
 */

import { resolve, basename, sep } from 'node:path';

const MODE = ['writer', 'secrets', 'readonly'].includes(process.argv[2]) ? process.argv[2] : 'readonly';
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
  process.exit(0);
}

const readStdin = () =>
  new Promise((res) => {
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (b += c));
    process.stdin.on('end', () => res(b));
    process.stdin.on('error', () => res(''));
    setTimeout(() => res(b), 4000).unref?.();
  });

/* ---------------------------------------------------------------- secrets */

/** Case-folded and trimmed: APFS is case-insensitive, so `.ENV` opens `.env`. */
function isSecretPath(p) {
  const clean = String(p).trim().replace(/\/+$/, '');
  const f = basename(clean).toLowerCase();
  if (/^\.env\.(example|sample|template)$/.test(f)) return false;
  if (/^\.env(\..+)?$/.test(f)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(f)) return true;
  if (/^(credentials|secrets)(\.json|\.yaml|\.yml)?$/.test(f)) return true;
  return /\.(pem|p12|pfx|key|keystore)$/.test(f);
}

/**
 * Strip heredoc BODIES before scanning a command for secret filenames.
 *
 * A heredoc body is data, not command arguments — a commit message or a written file may
 * legitimately contain the text ".env". Without this, `git commit -F - <<'EOF' … .env … EOF`
 * is denied, which is a false positive that blocks ordinary work. (Found the hard way: this
 * guard blocked the very commit that introduced it.)
 *
 * Redirects and arguments live on the command line itself, before the delimiter, so
 * `cat <<EOF > .env` and `cat .env <<EOF` are both still caught.
 */
function stripHeredocBodies(cmd) {
  const out = [];
  let delim = null;
  for (const line of String(cmd).split('\n')) {
    if (delim === null) {
      out.push(line); // the opening line carries redirects and args — always scanned
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (m) delim = m[2];
    } else if (new RegExp(`^\\s*${delim}\\s*$`).test(line)) {
      delim = null; // body ended; resume scanning
    }
    // body lines are dropped
  }
  return out.join('\n');
}

/** Any bare `.env` token anywhere in a command string, ignoring `.env.example` and friends. */
function commandTouchesSecret(cmd) {
  const tokens = stripHeredocBodies(cmd).match(/[^\s'"`;|&<>()]+/g) ?? [];
  return tokens.some((t) => /(^|\/)\.env($|[^.a-z])/i.test(t + ' ') && isSecretPath(t));
}

const PRINTS_ENV =
  /(^|[\s;|&(])(printenv|export\s+-p|set\s*$|set\s*\||env\s*($|[|>;&])|env\s+-0)/i.test.bind(
    /(^|[\s;|&(])(printenv|export\s+-p|set\s*$|set\s*\||env\s*($|[|>;&])|env\s+-0)/i,
  );

/** $VAR / ${VAR} expansion of anything that smells like a credential, incl. DATABASE_URL. */
const EXPANDS_SECRET_VAR =
  /\$\{?(DATABASE_URL|[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\b/;

/* ------------------------------------------------------- command splitting */

/** Split a command line into segments on shell operators, so each verb is checked. */
function segments(cmd) {
  return String(cmd)
    .split(/\|\||&&|[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** First real word of a segment, after stripping VAR=value prefixes and subshell punctuation. */
function verbOf(seg) {
  let s = seg.replace(/^[($\s]+/, '');
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  const w = s.split(/\s+/)[0] ?? '';
  return basename(w.replace(/^["']|["']$/g, '')).toLowerCase();
}

/* --------------------------------------------------- readonly Bash allowlist */

const READ_VERBS = new Set([
  // inspection
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'pwd', 'basename', 'dirname',
  'realpath', 'readlink', 'tree', 'echo', 'printf', 'date', 'true', 'false', 'test', 'which',
  'type', 'command', 'uname', 'whoami', 'sleep',
  // search & text (write-capable flags are rejected separately)
  'grep', 'rg', 'ag', 'find', 'fd', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff',
  'comm', 'jq', 'yq', 'xxd', 'strings', 'column', 'paste', 'tee',
  // vcs (verbs checked separately)
  'git',
  // toolchain (scripts checked separately)
  'pnpm', 'npm', 'yarn', 'npx', 'node', 'tsc', 'vitest', 'eslint',
]);

/** Verbs that are only safe in specific forms. */
function readonlySegmentProblem(seg) {
  const verb = verbOf(seg);
  if (!verb) return null;
  if (!READ_VERBS.has(verb)) {
    return `'${verb}' is not on the reviewer command allowlist`;
  }
  if (verb === 'sed' && /(^|\s)-[a-zA-Z]*i\b/.test(seg)) return 'sed -i edits files in place';
  if (verb === 'tee' && !/(^|\s)\/dev\/(null|stdout)/.test(seg)) return 'tee writes files';
  if (verb === 'find' && /-(delete|exec|execdir|ok|okdir|fprint|fls)\b/.test(seg)) {
    return 'find -delete/-exec can mutate or read anything';
  }
  if (verb === 'node' && /(^|\s)-(e|-eval|p|-print)\b/.test(seg)) {
    return 'node -e can read or write anything';
  }
  if (verb === 'node' && !/fleet-guard\.mjs|--version/.test(seg)) {
    return 'node may only run --version or the fleet guard self-test';
  }
  if (verb === 'git') {
    // Strip global options (`git -C dir`, `git -c k=v`) before reading the verb — that was bypass B8.
    const rest = seg.replace(/^\S*git\s+/, '');
    const gv = rest.replace(/^(-[cC]\s+\S+\s+|--\S+(=\S+)?\s+)*/, '').split(/\s+/)[0] ?? '';
    const OK = /^(diff|log|status|show|rev-parse|rev-list|ls-files|ls-tree|blame|cat-file|describe|shortlog|config|remote|branch|tag|stash|worktree|for-each-ref|count-objects|check-ignore|grep)$/;
    if (!OK.test(gv)) return `git ${gv} is not a read-only verb`;
    if (/^(branch|tag|stash|worktree|remote|config)$/.test(gv) && !/\s(-l|--list|-v|--verbose|--show-current|show|get|get-all|list)\b/.test(rest)) {
      return `git ${gv} is only allowed in its listing form`;
    }
  }
  if (/^(pnpm|npm|yarn|npx)$/.test(verb)) {
    // Strip -C/--dir/--filter/-w before reading the script — that was bypass B9.
    const rest = seg
      .replace(/^\S*(pnpm|npm|yarn|npx)\s+/, '')
      .replace(/^(-C\s+\S+\s+|--dir\s+\S+\s+|--filter(=|\s+)\S+\s+|-w\s+|--workspace-root\s+|-r\s+|--recursive\s+|--parallel\s+)*/g, '');
    const script = rest.split(/\s+/)[0] ?? '';
    if (!/^(typecheck|test|test:coverage|lint|list|ls|why|licenses|outdated|view|info|--version|-v)$/.test(script)) {
      return `pnpm/npm script '${script}' is not read-only (only typecheck, test, lint, list, why, outdated, view)`;
    }
  }
  return null;
}

/* ----------------------------------------------------- writer denylist (v2) */

const WRITER_DENY = [
  [/(^|[\s;|&(])git(\s+-[cC]\s+\S+|\s+--\S+)*\s+(push|commit|tag|rebase|cherry-pick|stash|restore|reset|clean|filter-branch)\b/,
   'no commit/push/tag/reset/clean/stash/restore — the fleet leaves changes uncommitted for human review'],
  [/(^|[\s;|&(])git(\s+-[cC]\s+\S+)*\s+checkout\s+--/, 'git checkout -- discards uncommitted work'],
  [/(^|[\s;|&(])git(\s+-[cC]\s+\S+)*\s+branch\s+-[dD]\b/, 'no branch deletion'],
  [/(^|[\s;|&(])git(\s+-[cC]\s+\S+)*\s+worktree\s+remove/, 'no worktree removal'],
  [/db:migrate|db:studio|drizzle-kit\s+(push|migrate|generate)|migrate\.ts|(^|[\s;|&(])psql\b|pg_dump|pg_restore|\bDROP\s+(TABLE|SCHEMA|DATABASE)\b|\bTRUNCATE\b/i,
   'no migrations, DB shells, or schema mutation — describe it and hand it to a human'],
  [/(^|[\s;|&(])(pnpm|npm|yarn)(\s+-C\s+\S+|\s+--dir\s+\S+|\s+--filter(=|\s+)\S+|\s+-w|\s+-r)*\s+(install|i|add|remove|rm|un|uninstall|up|update|upgrade|link|dlx|generate)\b/,
   'no dependency installs, removals, or codegen — they mutate tracked files and the lockfile'],
  [/(^|[\s;|&(])(rm|unlink|rmdir|shred|srm)\s/, 'no filesystem deletion'],
  [/-delete\b|-exec\s+rm\b/, 'no find -delete'],
  [/(^|[\s;|&(])mv\s+\S+\s+\/(tmp|var|dev)/, 'no moving files out of the repo'],
  [/(^|[\s;|&(])(kill|pkill|killall)\s|docker[-\s]compose\s+(up|down|restart|rm|stop)|docker\s+(stop|kill|rm|exec|run)\b|systemctl|launchctl/,
   'no process or container control — the fleet never touches running services'],
  [/(^|[\s;|&(])(ssh|scp|rsync|sftp)\s/, 'no remote access or file transfer'],
  [/(^|[\s;|&(])(curl|wget)\s+[^|;&]*(file:\/\/|--upload-file|-T\s|-d\s|--data)/, 'no local-file reads or uploads via curl/wget'],
];

/* -------------------------------------------------------------------- main */

const main = async () => {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const tool = payload?.tool_name;
  if (!tool) process.exit(0);
  const input = payload.tool_input ?? {};

  // Every field any tool uses to name a file — `path` and `url` were missed in v1 (bypass B5/B12).
  const paths = [input.file_path, input.notebook_path, input.path, input.url, input.pattern]
    .filter((v) => typeof v === 'string' && v.length);
  const command = typeof input.command === 'string' ? input.command : '';

  /* --- Rule 1: secrets stay sealed (all modes) --- */
  for (const p of paths) {
    if (isSecretPath(p)) {
      deny(`fleet-guard: '${p}' is secret material. The fleet never opens .env/.env.* or credential files — read .env.example instead (PROTOCOL.md rule 1).`);
    }
  }
  if (command) {
    if (commandTouchesSecret(command)) {
      deny('fleet-guard: this command names a .env or credential file. Secrets stay sealed — use .env.example (PROTOCOL.md rule 1).');
    }
    if (PRINTS_ENV(command) || EXPANDS_SECRET_VAR.test(command)) {
      deny('fleet-guard: this command would print or expand an environment secret. Reference secrets by file:line, never by value (PROTOCOL.md rule 1).');
    }
  }

  if (MODE === 'secrets') process.exit(0); // fleet-wide floor stops here

  /* --- Rule 2: reviewers have no source-edit path --- */
  if (MODE === 'readonly') {
    if (tool === 'Edit' || tool === 'NotebookEdit') {
      deny('fleet-guard: reviewers are read-only. Record the problem as a finding; review-fixer applies changes (PROTOCOL.md rule 2).');
    }
    if (tool === 'Write') {
      // resolve() first — v1 substring-matched, so `runs/x/../../src/server.ts` passed (bypass B1).
      const abs = resolve(REPO, String(input.file_path ?? ''));
      const ok = [
        resolve(REPO, '.claude/review/runs') + sep,
        resolve(REPO, '.claude/review') + sep,
        resolve(REPO, '.claude/reference/solutions') + sep,
        resolve(REPO, '.claude/agent-memory') + sep,
        resolve(REPO, '.claude/agent-memory-local') + sep,
      ].some((prefix) => abs.startsWith(prefix));
      if (!ok) {
        deny(`fleet-guard: reviewers may only Write inside .claude/review/ (run dirs and audits), .claude/reference/solutions/, or agent memory. Resolved target was '${abs}' (PROTOCOL.md rule 2).`);
      }
    }
    /* --- Rule 3: Bash is an allowlist in readonly mode --- */
    if (command) {
      if (/(^|[^0-9<>&])>>?\s*[^&\s]/.test(command) && !/>\s*\/dev\/null/.test(command)) {
        deny('fleet-guard: output redirection to a file is a write channel and is not permitted for reviewers (PROTOCOL.md rule 2).');
      }
      if (/<\s*\S*\.env/i.test(command)) {
        deny('fleet-guard: input redirection from a .env file is still a secret read (PROTOCOL.md rule 1).');
      }
      for (const seg of segments(command)) {
        const problem = readonlySegmentProblem(seg);
        if (problem) {
          deny(`fleet-guard: ${problem}. Reviewers may run only read-only inspection (ls/cat/grep/find/git diff|log|status, pnpm typecheck|test|lint). Record what you wanted to run as a finding (PROTOCOL.md rule 3).`);
        }
      }
    }
    process.exit(0);
  }

  /* --- writer mode: hardened denylist --- */
  if (command) {
    for (const [re, why] of WRITER_DENY) {
      if (re.test(command)) deny(`fleet-guard: ${why} (PROTOCOL.md rule 3).`);
    }
  }
  process.exit(0);
};

main().catch(() => process.exit(0));
