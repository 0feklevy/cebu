#!/usr/bin/env node
/**
 * fleet-guard.mjs — PreToolUse guard for the FlowVid agent fleet.  (v3)
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
 * v3 fixes the six bypasses in FLEET-AUDIT.md §7. Every one of them came from the same mistake:
 * v2 read the command as a FLAT STRING, but the shell rewrites that string before any program
 * runs. It splits on `&`, runs `$(…)`, `` `…` `` and `<(…)` as commands of their own, and expands
 * `*`, `?`, `[…]`, `{a,b}` and `$'\x2e…'` into filenames that were never typed — which is how
 * `cat podcast-saas/.en*` walked straight through the secrets floor in every mode. So v3 reads
 * the command the way the shell will run it: lexCommand() produces the real command segments and
 * the real words, and a pattern is judged by whether it CAN expand onto a secret (globsIntersect),
 * decided on the pattern itself so the answer never depends on which files happen to exist.
 *
 * The two remaining audit items, `awk` and `sed`, were allowlisted verbs with unguarded write and
 * exec channels (`system()`, `getline <`, `|"cmd"`, `--in-place`, `w file`). They are narrowed by
 * parsing flags against an allowlist, not by adding the spellings that got through: enumerating
 * spellings is what failed in v1, and `--in-place` vs `-i` is the same failure repeated.
 *
 * Contract: exit 0 printing nothing → no opinion, normal permission flow applies.
 *           exit 0 printing deny JSON → blocked, with a reason the agent can read.
 * Fails OPEN on a parse error so a malformed payload can never brick a run.
 *
 * Every rule here has a case in fleet-guard.test.mjs — run `node .claude/hooks/fleet-guard.test.mjs`
 * after any edit. A change that does not break a test is not thereby safe; add the case first.
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
function splitHeredocs(cmd) {
  const out = [];
  const expandable = []; // bodies of UNQUOTED heredocs, where $(…) and `…` still run
  let delim = null;
  let quoted = false;
  let body = [];
  for (const line of String(cmd).split('\n')) {
    if (delim === null) {
      out.push(line); // the opening line carries redirects and args — always scanned
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (m) {
        delim = m[2];
        quoted = Boolean(m[1]); // <<'EOF' is inert; <<EOF still expands
        body = [];
      }
    } else if (new RegExp(`^\\s*${delim}\\s*$`).test(line)) {
      if (!quoted) expandable.push(body.join('\n'));
      delim = null; // body ended; resume scanning
    } else {
      body.push(line); // body lines are dropped from the scanned text
    }
  }
  if (delim !== null && !quoted) expandable.push(body.join('\n'));
  return { code: out.join('\n'), expandable };
}

const stripHeredocBodies = (cmd) => splitHeredocs(cmd).code;

/** Does this token name a file in the .env family? `.env.local` is one; `.env.example` is not. */
const namesSecret = (t) => /(^|\/)\.env($|\.)/i.test(t) && isSecretPath(t);

/** Any bare `.env` token anywhere in a command string, ignoring `.env.example` and friends. */
function commandTouchesSecret(cmd) {
  const tokens = stripHeredocBodies(cmd).match(/[^\s'"`;|&<>()]+/g) ?? [];
  return tokens.some(namesSecret);
}

const PRINTS_ENV =
  /(^|[\s;|&(])(printenv|export\s+-p|set\s*$|set\s*\||env\s*($|[|>;&])|env\s+-0)/i.test.bind(
    /(^|[\s;|&(])(printenv|export\s+-p|set\s*$|set\s*\||env\s*($|[|>;&])|env\s+-0)/i,
  );

/** $VAR / ${VAR} expansion of anything that smells like a credential, incl. DATABASE_URL. */
const EXPANDS_SECRET_VAR =
  /\$\{?(DATABASE_URL|[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\b/;

/* ------------------------------------------------------- command splitting */

const SUB = '\u0001'; // stands in for the unknown result of an expansion
const EXPANDS = '*?[]{},'; // characters the shell acts on unless they are quoted

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/** Decode the escapes inside `$'…'`, which is how `$'\x2eenv'` becomes the filename `.env`. */
function decodeAnsiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\' || i + 1 >= body.length) {
      out += body[i];
      continue;
    }
    const c = body[++i];
    let m;
    if (c in ANSI_C) out += ANSI_C[c];
    else if ((m = /^[0-7]{1,3}/.exec(body.slice(i)))) {
      out += String.fromCharCode(parseInt(m[0], 8));
      i += m[0].length - 1;
    } else if ((c === 'x' || c === 'u' || c === 'U') && (m = /^[0-9a-fA-F]{1,8}/.exec(body.slice(i + 1)))) {
      const hex = m[0].slice(0, c === 'x' ? 2 : c === 'u' ? 4 : 8);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += hex.length;
    } else out += c; // \\ \' \" and anything unrecognised stand for themselves
  }
  return out;
}

/**
 * A small POSIX-shell lexer.
 *
 * v2 split the command with one regex over the flat string, which is precisely how audit
 * bypasses G1–G3 and G6 worked: `&`, `$(…)`, `` `…` `` and `<(…)` all begin a new command, and
 * `*`, `?`, `[…]` and `{a,b}` are expanded by the shell before the program ever sees the
 * argument. A guard that reads the string instead of the command it will become is guessing.
 *
 * Returns { segments, subs, words }:
 *   segments — raw text of each simple command, so every verb gets verb-checked
 *   subs     — text inside $(…) / `…` / <(…) / >(…); each is a command in its own right
 *   words    — each word as ordered {text, quoted} parts, so expansion can be modelled.
 *              Quoting is tracked because it decides expansion: `cat ".en*"` is one literal
 *              filename, `cat .en*` is a pattern that opens whatever it matches.
 *
 * Unbalanced quotes or brackets simply end the scan — this runs on every tool call and must
 * never throw.
 */
function lexCommand(src) {
  const s = String(src);
  const n = s.length;
  const segments = [];
  const subs = [];
  const words = [];
  let seg = '';
  let word = null;

  const put = (text, quoted) => {
    if (!text) return;
    word ??= { parts: [] };
    const last = word.parts[word.parts.length - 1];
    if (last && last.quoted === quoted) last.text += text;
    else word.parts.push({ text, quoted });
  };
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (seg.trim()) segments.push(seg.trim());
    seg = '';
  };
  /** Index of the bracket that balances `depth` open ones, skipping quoted text; n if unbalanced. */
  const close = (from, open, shut, depth) => {
    let i = from;
    let q = null;
    while (i < n) {
      const c = s[i];
      if (q) {
        if (c === '\\' && q === '"') i++;
        else if (c === q) q = null;
      } else if (c === '\\') i++;
      else if (c === "'" || c === '"') q = c;
      else if (c === open) depth++;
      else if (c === shut && --depth === 0) return i;
      i++;
    }
    return n;
  };

  let i = 0;
  let quote = null;
  while (i < n) {
    const c = s[i];

    if (quote === "'") {
      if (c === "'") quote = null; // single quotes: every character is literal
      else put(c, true);
      seg += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      put(s[i + 1], true); // a backslash makes the next character literal
      seg += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      const end = close(i + 3, '(', ')', 2); // $((…)) is arithmetic — a value, not a command
      put(SUB, false);
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const end = close(i + 2, '(', ')', 1); // G2: $(…) runs, inside double quotes as well
      subs.push(s.slice(i + 2, end));
      put(SUB, false);
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '`') {
      let end = i + 1; // G3: backticks are the older spelling of $(…)
      while (end < n && s[end] !== '`') end += s[end] === '\\' ? 2 : 1;
      subs.push(s.slice(i + 1, Math.min(end, n)));
      put(SUB, false);
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = close(i + 2, '{', '}', 1); // ${VAR…}: a value whose content we cannot know
      put(SUB, false);
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // $'…' is ANSI-C quoting: the shell decodes the escapes, so `$'\x2eenv'` opens .env. Same
      // root cause as G6 — read the name the shell will build, not the one that was typed.
      let end = i + 2;
      while (end < n && s[end] !== "'") end += s[end] === '\\' ? 2 : 1;
      put(decodeAnsiC(s.slice(i + 2, Math.min(end, n))), true);
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '"') {
      seg += c; // $"…" is a locale lookup of an ordinary double-quoted string
      i++;
      continue;
    }
    if (c === '$' && i + 1 < n) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*?#!$-])/.exec(s.slice(i));
      if (m) {
        put(SUB, false); // $VAR: a value whose content we cannot know, and it may hold a path
        seg += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else put(c, true);
      seg += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      seg += c;
      i++;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const end = close(i + 2, '(', ')', 1); // process substitution runs a command too
      subs.push(s.slice(i + 2, end));
      endWord();
      seg += s.slice(i, Math.min(end + 1, n));
      i = end + 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      endSegment();
      i++;
      continue;
    }
    if (c === '|') {
      endSegment();
      i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') {
        endSegment();
        i += 2;
        continue;
      }
      if (s[i + 1] === '>') {
        endWord(); // `&>` redirects both streams to a file — a redirect, not a separator
        seg += '&>';
        i += 2;
        continue;
      }
      if (/[<>]\s*$/.test(seg)) {
        seg += c; // `2>&1` duplicates a file descriptor — also not a separator
        i++;
        continue;
      }
      endSegment(); // G1: a bare `&` backgrounds the command and starts the next one
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      endSegment(); // a subshell is its own command
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      endWord();
      seg += c;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      seg += c;
      i++;
      continue;
    }
    put(c, false);
    seg += c;
    i++;
  }
  endSegment();
  return { segments, subs, words };
}

/**
 * Everything the shell will actually run for this command line: every simple command (including
 * the ones hidden inside substitutions, at any nesting depth) and every word.
 */
function shellView(cmd) {
  const { code, expandable } = splitHeredocs(cmd);
  const segments = [];
  const words = [];
  const walk = (text, depth) => {
    if (depth > 6) return; // substitutions can nest; the guard's patience cannot
    const lexed = lexCommand(text);
    segments.push(...lexed.segments);
    words.push(...lexed.words);
    for (const sub of lexed.subs) walk(sub, depth + 1);
  };
  walk(code, 0);
  // A heredoc body is data, but an UNQUOTED delimiter still expands $(…) and `…` inside it.
  for (const body of expandable) for (const sub of lexCommand(body).subs) walk(sub, 1);
  return { segments, words };
}

/** First real word of a segment, after stripping VAR=value prefixes and grouping punctuation. */
function verbOf(seg) {
  let s = seg.replace(/^[({$\s]+/, '');
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  const w = s.split(/\s+/)[0] ?? '';
  return basename(w.replace(/^["']|["']$/g, '')).toLowerCase();
}

/** Words of a segment, quotes kept, for flag inspection. */
const argsOf = (seg) => seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
const unquote = (a) => a.replace(/^(['"])([\s\S]*)\1$/, '$2');

/* --------------------------------------------------- glob and brace expansion */

/**
 * Render a word as a glob pattern. Quoted characters are backslash-escaped so they stay literal,
 * which is what keeps `cat ".en*"` (a filename) apart from `cat .en*` (a pattern).
 */
function wordPattern(word) {
  let out = '';
  for (const { text, quoted } of word.parts) {
    for (const ch of text) {
      if (ch === SUB) out += SUB;
      else if (!quoted && EXPANDS.includes(ch)) out += ch;
      else if (ch === '\\' || EXPANDS.includes(ch)) out += '\\' + ch;
      else out += ch;
    }
  }
  return out;
}

const indexOfUnescaped = (p, ch, from = 0) => {
  for (let i = from; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === ch) return i;
  }
  return -1;
};

const matchBrace = (p, open) => {
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) return i;
  }
  return -1;
};

/** Top-level comma-separated alternatives of a brace body, or null if there are none. */
function braceAlternatives(body) {
  const alts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) {
      alts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (!alts.length) return null;
  alts.push(body.slice(start));
  return alts;
}

/** Every string `{a,b}` expansion can produce. Ranges and runaway products fall back to `*`. */
function expandBraces(pattern, budget = { left: 64 }) {
  const open = indexOfUnescaped(pattern, '{');
  if (open === -1) return [pattern];
  const shut = matchBrace(pattern, open);
  if (shut === -1) return [pattern];
  const head = pattern.slice(0, open);
  const body = pattern.slice(open + 1, shut);
  const tail = pattern.slice(shut + 1);
  const alts = braceAlternatives(body) ?? (/^[^,]*\.\.[^,]*$/.test(body) ? ['*'] : null);
  if (!alts) {
    // Not an expansion (`${VAR}`, an awk block): keep the brace literal and look further right.
    return expandBraces(`${head}\\{${body}}${tail}`, budget);
  }
  const out = [];
  for (const alt of alts) {
    if (budget.left <= 0) return [`${head}*${tail}`]; // pathological product: over-approximate
    budget.left--;
    out.push(...expandBraces(head + alt + tail, budget));
  }
  return out;
}

/** Split a pattern on path separators and on unknown expansions, which may hide a separator. */
function patternChunks(pattern) {
  const chunks = [];
  let cur = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) cur += c + pattern[++i];
    else if (c === '/' || c === SUB) {
      chunks.push(cur);
      cur = '';
    } else cur += c;
  }
  chunks.push(cur);
  return chunks;
}

/** The pattern as a plain string, or null when it still contains wildcards. */
function literalOf(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) out += pattern[++i];
    else if (c === '*' || c === '?' || c === '[') return null;
    else if (c !== SUB) out += c;
  }
  return out;
}

/** Parse a glob into atoms: literal, `?`, `*`, or a bracket class. */
function parseGlob(p) {
  const atoms = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) atoms.push({ t: 'lit', c: p[++i] });
    else if (c === '*') {
      if (atoms[atoms.length - 1]?.t !== 'star') atoms.push({ t: 'star' });
    } else if (c === '?') atoms.push({ t: 'any' });
    else if (c === '[') {
      let j = i + 1;
      const neg = p[j] === '!' || p[j] === '^';
      if (neg) j++;
      const start = j;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') j++;
      if (j >= p.length) atoms.push({ t: 'lit', c: '[' }); // unterminated: bash treats it literally
      else {
        atoms.push({ t: 'class', neg, body: p.slice(start, j) });
        i = j;
      }
    } else atoms.push({ t: 'lit', c });
  }
  return atoms;
}

function atomMatches(atom, ch) {
  if (ch === '/') return false; // no wildcard crosses a path separator
  if (atom.t === 'lit') return atom.c === ch;
  if (atom.t === 'any') return true;
  let hit = false;
  for (let i = 0; i < atom.body.length; i++) {
    if (atom.body[i + 1] === '-' && i + 2 < atom.body.length) {
      if (ch >= atom.body[i] && ch <= atom.body[i + 2]) hit = true;
      i += 2;
    } else if (atom.body[i] === ch) hit = true;
  }
  return atom.neg ? !hit : hit;
}

function atomsOverlap(x, y) {
  if (x.t === 'lit') return atomMatches(y, x.c);
  if (y.t === 'lit') return atomMatches(x, y.c);
  for (let code = 32; code < 127; code++) {
    const ch = String.fromCharCode(code);
    if (atomMatches(x, ch) && atomMatches(y, ch)) return true;
  }
  return false;
}

/**
 * Do two globs have any filename in common? Deciding this on the patterns keeps the guard a pure
 * function of the command: no directory listing, no dependence on which files happen to exist.
 */
function globsIntersect(a, b) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (i === a.length) r = b.slice(j).every((t) => t.t === 'star');
    else if (j === b.length) r = a.slice(i).every((t) => t.t === 'star');
    else if (a[i].t === 'star') r = go(i + 1, j) || go(i, j + 1);
    else if (b[j].t === 'star') r = go(i, j + 1) || go(i + 1, j);
    else r = atomsOverlap(a[i], b[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** The secret filenames a pattern could land on. Mirrors the .env family in isSecretPath(). */
const SECRET_GLOBS = ['.env', '.env.*'].map(parseGlob);

/**
 * Could this filename pattern expand onto a secret? `*`, `?` and `[…]` never match a leading dot
 * under bash's default (dotglob off), so `ls *.json` and `wc -l src/*` stay allowed — only a
 * pattern that spells the dot out can reach `.env`.
 */
function globCanMatchSecret(chunk) {
  const a = parseGlob(chunk.toLowerCase());
  if (!a.some((x) => x.t !== 'lit')) return false; // a plain name: the literal scan owns it
  if (!(a[0]?.t === 'lit' && a[0].c === '.')) return false;
  return SECRET_GLOBS.some((b) => globsIntersect(a, b));
}

/**
 * G6: the shell expands globs and braces before the command runs, so a guard that only reads the
 * literal string never sees the file that gets opened. Returns the offending word, or null.
 */
function expansionTouchesSecret(words) {
  for (const word of words) {
    for (const pattern of expandBraces(wordPattern(word))) {
      const literal = literalOf(pattern);
      if (literal !== null) {
        // The name can sit behind a separator the literal scan does not anchor on: `X=.env` then
        // `cat $X`, or `curl -d @.env`. Each side of one is still a filename.
        for (const candidate of [literal, ...literal.split(/[=@:,]/).slice(1)]) {
          if (namesSecret(candidate)) return candidate;
        }
        continue;
      }
      const chunks = patternChunks(pattern);
      const name = chunks[chunks.length - 1]; // only the last component names the file opened
      if (globCanMatchSecret(name)) return name.replace(/\\(.)/g, '$1');
    }
  }
  return null;
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

/**
 * Flags each dual-use verb may carry. These are allowlists on purpose: G5 got through because the
 * guard knew the spelling `-i` and not the spelling `--in-place`, and the audit's own conclusion
 * was that enumerating spellings is what failed. A flag nobody has justified is refused.
 */
const SED_SHORT_OK = 'nErzue'; // -n quiet, -E/-r extended, -z null-data, -u unbuffered, -e script
const SED_LONG_OK =
  /^--(quiet|silent|regexp-extended|null-data|unbuffered|separate|posix|sandbox|expression|debug|help|version)(=|$)/;
const ESLINT_FLAG_OK =
  /^(-f|--format|--ext|--max-warnings|--quiet|--color|--no-color|-c|--config|--no-eslintrc|--no-config-lookup|--no-ignore|--ignore-pattern|--rule|--rulesdir|--env|--global|--parser|--parser-options|--plugin|--resolve-plugins-relative-to|--report-unused-disable-directives|--no-inline-config|--stdin|--stdin-filename|--concurrency|--debug|--stats|-v|--version|-h|--help)(=|$)/;

/** Verbs that are only safe in specific forms. */
function readonlySegmentProblem(seg) {
  const verb = verbOf(seg);
  if (!verb) return null;
  if (!READ_VERBS.has(verb)) {
    return `'${verb}' is not on the reviewer command allowlist`;
  }
  if (verb === 'sed') {
    // G5: parse the flags instead of matching one spelling of them. `-i`, `-i.bak`, `--in-place`
    // and `-f script.sed` all fail this, and so does any flag added to sed in the future.
    for (const arg of argsOf(seg).slice(1)) {
      if (arg === '--') break;
      if (!arg.startsWith('-') || arg === '-') continue;
      if (arg.startsWith('--')) {
        if (!SED_LONG_OK.test(arg)) return `sed ${arg.split('=')[0]} is not a read-only sed flag`;
      } else {
        const letters = arg.slice(1).match(/^[A-Za-z]*/)[0];
        const bad = [...letters].find((ch) => !SED_SHORT_OK.includes(ch));
        if (bad || !letters) return `sed -${bad || arg.slice(1)} is not a read-only sed flag`;
      }
    }
    // sed writes files without -i too: the `w file` command and the `s///w file` flag.
    const script = argsOf(seg).slice(1).map(unquote).join('\n');
    if (/(^|[;{}\n])[ \t]*[0-9$,\/]*[ \t]*w[ \t]+\S/.test(script)) return 'sed w writes a file';
    if (/s([^\sA-Za-z0-9])(?:\\.|(?!\1)[^\n])*\1(?:\\.|(?!\1)[^\n])*\1[a-zA-Z0-9]*w/.test(script)) {
      return 'sed s///w writes a file';
    }
  }
  if (verb === 'awk') {
    // G4: awk is a programming language with file and process access, not a text filter.
    if (/(^|\s)(-f|--file)(\s|=)/.test(seg)) return 'awk -f runs an external program file';
    const prog = seg.replace(/^\S*awk\s+/, '');
    if (/\bsystem\s*\(/.test(prog)) return 'awk system() runs a shell command';
    if (/\bgetline\b/.test(prog)) return 'awk getline reads other files or command output';
    if (/\bENVIRON\b/.test(prog)) return 'awk ENVIRON[] reads environment secrets';
    if (/\bclose\s*\(/.test(prog)) return 'awk close() belongs to a pipe or an output file';
    if (/\|/.test(prog)) return 'awk | runs a command';
    if (/>/.test(prog)) return 'awk > writes a file';
  }
  if (verb === 'eslint') {
    for (const arg of argsOf(seg).slice(1)) {
      if (arg === '--') break;
      if (arg.startsWith('-') && !ESLINT_FLAG_OK.test(arg)) {
        return `eslint ${arg.split('=')[0]} is not a reporting-only flag (--fix and -o rewrite files)`;
      }
    }
  }
  if (verb === 'tsc') {
    // Narrowing beats listing emit flags: without --noEmit, tsc writes JavaScript somewhere.
    if (/(^|\s)(-b|--build)\b/i.test(seg)) return 'tsc --build writes build outputs';
    if (!/(^|\s)--noEmit\b/i.test(seg) && !/(^|\s)(-v|--version|-h|--help|--showConfig)\b/i.test(seg)) {
      return 'tsc without --noEmit emits compiled output';
    }
  }
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
  const shell = command ? shellView(command) : { segments: [], words: [] };
  if (command) {
    if (commandTouchesSecret(command)) {
      deny('fleet-guard: this command names a .env or credential file. Secrets stay sealed — use .env.example (PROTOCOL.md rule 1).');
    }
    // The shell expands globs and braces before the command runs, so a pattern that can land on
    // a secret is a secret read no matter which verb it is handed to (bypass G6).
    const expansion = expansionTouchesSecret(shell.words);
    if (expansion) {
      deny(`fleet-guard: '${expansion}' is a pattern the shell expands, and it can expand onto .env or .env.*. Name the file you actually want — secrets stay sealed (PROTOCOL.md rule 1).`);
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
      // `&>file` and `>&file` are the same write channel wearing the fd-duplication spelling.
      // `2>&1` and `>&-` are not: they name a descriptor, never a file.
      if (/&>>?\s*[^&\s]/.test(command) || />&\s*[^0-9\s&-]/.test(command)) {
        deny('fleet-guard: redirecting a stream onto a file is a write channel and is not permitted for reviewers (PROTOCOL.md rule 2).');
      }
      if (/<\s*\S*\.env/i.test(command)) {
        deny('fleet-guard: input redirection from a .env file is still a secret read (PROTOCOL.md rule 1).');
      }
      for (const seg of shell.segments) {
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
