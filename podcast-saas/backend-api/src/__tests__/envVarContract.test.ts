/**
 * Every environment variable the server reads should be findable by whoever has to set it.
 *
 * A measured gap, not a suspicion: 119 variables are read by `backend-api/src` and 57 had no entry
 * in either `.env.example` at all. An operator standing up an environment could not know they
 * existed, and a wrong default stays invisible until something behaves oddly in production.
 *
 * ── WHY THIS IS A RATCHET AND NOT A CLEAN ASSERTION ───────────────────────────────────────────
 * Documenting all 57 properly is real work and most of the remainder points at a binary path or a
 * cache directory rather than at behaviour. A test that fails today teaches people to skip it. So
 * the known gap is listed BELOW, explicitly, and the test fails only on a NEW undocumented
 * variable. The list is meant to shrink; every entry deleted from it is a variable someone can now
 * find.
 *
 * ── WHAT COUNTS AS DOCUMENTED ─────────────────────────────────────────────────────────────────
 * Either `.env.example` — they are two different files with two different jobs (app secrets vs
 * compose orchestration) — OR an `environment:` entry in `docker-compose.yml`, because compose
 * SETS several of these for the containers directly and a var it provides is configured rather
 * than missing. Checking only the example files reports a var as absent when production supplies
 * it, which is a false alarm that costs someone an afternoon.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(new URL('.', import.meta.url).pathname, '..');
const ROOT = join(SRC, '..', '..');

/**
 * Undocumented as of 2026-08-22, and deliberately allowed.
 *
 * Delete from this list when you add the variable to an `.env.example`. Do not ADD to it — that is
 * what the test is for.
 */
const KNOWN_UNDOCUMENTED: readonly string[] = [
  // Vendor identifiers for the avatar provider, set per-workspace.
  'ANAM_AVATAR_ID', 'ANAM_LLM_ID', 'ANAM_VOICE_ID',
  // Binary and cache paths, normally resolved by the image rather than configured.
  'CHROME_HEADLESS_SHELL_PATH', 'CHROME_HEADLESS_SHELL_VERSION', 'PLAYWRIGHT_CHROMIUM_PATH',
  'WHISPER_BIN', 'WHISPER_CPP_BIN', 'WHISPER_MODEL_PATH', 'XDG_CACHE_HOME',
  // Whisper tuning; only meaningful on the local-transcription path.
  'WHISPER_CPP_LANGUAGE', 'WHISPER_CPP_MODEL', 'WHISPER_CPP_THREADS', 'WHISPER_LANGUAGE',
  // Export-capture internals, set by the export orchestrator rather than by an operator.
  'EXPORT_CAPTURE_BACKEND_MODULE', 'EXPORT_CAPTURE_DPR', 'EXPORT_CAPTURE_IMAGE',
  'EXPORT_CAPTURE_INPUT_DIR', 'EXPORT_CAPTURE_LOCAL', 'EXPORT_CAPTURE_OUTPUT_DIR',
  'EXPORT_IMAGE_DIGEST', 'EXPORT_MAX_SIM_WINDOWS',
  // Model selection with sensible defaults in code.
  'GOOGLE_IMAGE_MODEL', 'OPENAI_IMAGE_MODEL', 'SEO_MODEL',
  // Podcast render tuning.
  'PODCAST_TEMPO', 'PODCAST_TTS_FORMAT',
  // Vendor base URL, overridden only in tests.
  'ELEVENLABS_API_BASE',
];

/** Provided by the runtime itself, or by CI. Nobody sets these in a .env file. */
const RUNTIME_PROVIDED = new Set([
  'NODE_ENV', 'PORT', 'CI', 'HOME', 'PATH', 'TZ',
  'npm_package_version', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...walk(full));
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Every name this codebase reads from the environment.
 *
 * TWO PATTERNS, because there are two ways this code reads a variable and the first version of
 * this file only knew one. `process.env.NAME` is the common one. But the capture provider, the
 * dubbing budget and the migration runner take a `NodeJS.ProcessEnv` as a PARAMETER and read
 * `env.NAME` off it — a better shape for testing, and completely invisible to a scan anchored on
 * `process.`.
 *
 * That blind spot hid 19 variables, `MIGRATION_DATABASE_URL`, `WORKER_QUEUES` and the whole
 * `EXPORT_CAPTURE_*` family among them. Worse than the count: it made the ratchet's verdict
 * unsound rather than merely incomplete, because a genuinely undocumented variable read that way
 * could never appear in the diff this test computes. A gate that cannot see a class of input is
 * not a smaller gate, it is a gate with a hole.
 */
function envNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.push(m[1]!);
  // `env.NAME` where `env` is the injected ProcessEnv. The negative lookbehind keeps this from
  // double-counting the `process.env.` hits above.
  for (const m of text.matchAll(/(?<!process\.)\benv\.([A-Z][A-Z0-9_]+)/g)) names.push(m[1]!);
  return names;
}

function allEnvNamesRead(): Set<string> {
  const read = new Set<string>();
  for (const file of walk(SRC)) for (const n of envNamesIn(readFileSync(file, 'utf8'))) read.add(n);
  return read;
}

describe('every environment variable is findable by whoever has to set it', () => {
  it('no NEW undocumented variable has appeared', () => {
    const read = allEnvNamesRead();
    expect(read.size, 'the env-var scan matched nothing — its pattern has drifted').toBeGreaterThan(80);
    // BOTH shapes, asserted by example. A regression that silently dropped either pattern would
    // shrink the read set and make this file report success while checking half the surface.
    expect(read, 'the process.env.X pattern stopped matching').toContain('DATABASE_URL');
    expect(read, 'the injected env.X pattern stopped matching').toContain('EXPORT_CAPTURE_TMPFS_MB');

    const documented = new Set<string>();
    for (const p of [join(ROOT, '.env.example'), join(ROOT, 'deploy', '.env.example')]) {
      for (const m of readFileSync(p, 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) documented.add(m[1]);
    }
    // Compose SETS these for the containers; a var it provides is configured, not missing.
    for (const m of readFileSync(join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8')
      .matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)) documented.add(m[1]);

    const undocumented = [...read]
      .filter((v) => !documented.has(v) && !RUNTIME_PROVIDED.has(v) && !KNOWN_UNDOCUMENTED.includes(v))
      .sort();

    expect(
      undocumented,
      'these variables are read by the server and documented nowhere — add them to .env.example',
    ).toEqual([]);
  });

  it('the allow-list has not rotted', () => {
    // An entry for a variable nothing reads any more is a line that makes the gap look larger
    // than it is, and it is the reason ratchet lists stop being trusted.
    const read = allEnvNamesRead();
    const stale = KNOWN_UNDOCUMENTED.filter((v) => !read.has(v));
    expect(stale, 'these are allowed as undocumented but nothing reads them — delete the entries').toEqual([]);
  });
});
