/**
 * WHAT DID THIS ACCOUNT ACTUALLY BUY FROM ELEVENLABS? — a read-only reconciliation.
 *
 * Written on 2026-08-23 after four unexplained dubbing charges appeared on 22 August: $69.00 at
 * one point and then $31.81 three times over, at 14:57, 16:14 and 18:06. Three IDENTICAL amounts
 * is the shape of the same work billed more than once, and the invoice alone cannot tell you which
 * it was — it shows money, not project ids.
 *
 * The vendor's project list can. Every dubbing project this product creates is stamped with a
 * `reference` derived from our own dub row id (`dubReference`), so grouping the account's projects
 * by that stamp answers the question outright:
 *
 *   • two or more projects sharing ONE reference  → the same dub was bought twice. That is a bug
 *     in this codebase, not a usage question, and the two fail-open reads in `DubbingService`
 *     (`findProjectByReference` and `listLanguagesQuietly`, both of which return empty on a
 *     transient vendor error and then fall through to a PAID write) are the first place to look.
 *   • one project per reference, several references  → separate pieces of work. The charges are
 *     real usage and the question is who asked for them.
 *   • a project with NO reference of ours          → created outside this product entirely.
 *
 * ── READ ONLY, AND DELIBERATELY SO ────────────────────────────────────────────────────────────
 * `GET /dubbing/project` and `GET .../language` are the only calls made. Neither bills: the vendor
 * charges on project CREATION and on ADDING a language, and this script does neither. It also
 * never deletes — `deleteProject` exists on the client and is not imported here, because deletion
 * is not documented to refund credits and a diagnostic that destroys evidence is worse than none.
 *
 * ── THE KEY IS NEVER PRINTED ──────────────────────────────────────────────────────────────────
 * Read from the environment by the client itself. This file never reads it, never logs it, and
 * never accepts it as an argument where a shell history would keep it.
 *
 *   pnpm --filter backend-api exec tsx scripts/dubbing-audit.ts
 *   pnpm --filter backend-api exec tsx scripts/dubbing-audit.ts --since 2026-08-22
 */
import { ElevenLabsDubbingClient, ElevenLabsKeyMissingError } from '../src/services/dubbing/ElevenLabsDubbingClient.js';
import type { DubbingProjectResponse } from '../src/services/dubbing/ElevenLabsDubbingClient.js';
import { estimateDubbingCost } from '../src/services/dubbing/cost.js';

/** Pages defensively: a workspace with a long history must not be truncated into a wrong answer. */
const MAX_PAGES = 200;

interface Row {
  projectId: string;
  reference: string | null;
  status: string;
  createdAt: string | null;
  durationSec: number | null;
  languages: string[];
  sourceLanguage: string | null;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function collect(client: ElevenLabsDubbingClient): Promise<DubbingProjectResponse[]> {
  const out: DubbingProjectResponse[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.listProjects({ cursor, pageSize: 100 });
    out.push(...(res.projects ?? []));
    if (!res.has_more || !res.next_cursor) return out;
    cursor = res.next_cursor;
  }
  console.warn(`! stopped at ${MAX_PAGES} pages — the listing may be incomplete`);
  return out;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

async function main(): Promise<void> {
  const since = arg('--since');
  const client = new ElevenLabsDubbingClient();

  const projects = await collect(client);
  console.log(`\n${projects.length} dubbing project(s) in this workspace.\n`);

  const rows: Row[] = [];
  for (const p of projects) {
    // The project list does not carry the language targets, so each project is asked for its own.
    // Read-only, and it is what turns "a project exists" into "this is what it was billed for".
    let languages: string[] = [];
    try {
      languages = (await client.listLanguages(p.project_id)).map((l) => l.target_language);
    } catch {
      languages = ['<could not list>'];
    }
    rows.push({
      projectId: p.project_id,
      reference: p.reference ?? null,
      status: p.status,
      createdAt: (p as { created_at?: string | null }).created_at ?? null,
      durationSec: p.media?.duration_s ?? null,
      languages,
      sourceLanguage: p.source_language ?? null,
    });
  }

  // THE PROJECT LIST MAY CARRY NO TIMESTAMPS. `created_at` is declared on the vendor's LANGUAGE
  // response, not on the project one, so whether a project reports its creation time depends on the
  // account and the API version. Saying that plainly beats printing a column of "(no date)" and
  // letting the reader think the projects are undated rather than the listing being.
  const dated = rows.filter((r) => r.createdAt).length;
  if (dated === 0) {
    console.log('NOTE: this listing carries no creation timestamps, so charges cannot be matched to');
    console.log('      the invoice by TIME. Match them by fingerprint instead — a 7:27 source with two');
    console.log('      language targets is one $31.81 line at the headline rate.\n');
  } else if (dated < rows.length) {
    console.log(`NOTE: only ${dated} of ${rows.length} projects report a creation time.\n`);
  }

  const inWindow = since && dated > 0 ? rows.filter((r) => (r.createdAt ?? '') >= since) : rows;
  if (since && dated === 0) console.log('--since ignored: no timestamps to filter on.\n');
  else if (since) console.log(`${inWindow.length} created on or after ${since}.\n`);

  // ── THE ANSWER: does any reference appear more than once? ────────────────────────────────────
  const byReference = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.reference ?? '<no reference — not created by this product>';
    byReference.set(key, [...(byReference.get(key) ?? []), r]);
  }

  const duplicated = [...byReference.entries()].filter(([ref, list]) => list.length > 1 && ref.startsWith('flowvid'));
  if (duplicated.length > 0) {
    console.log('DUPLICATE PROJECTS — the same dub was bought more than once:\n');
    for (const [ref, list] of duplicated) {
      console.log(`  reference ${ref}  ×${list.length}`);
      for (const r of list) {
        console.log(`    ${r.createdAt ?? '(no date)'}  ${r.projectId}  [${r.languages.join(', ')}]  ${r.status}`);
      }
    }
    console.log('\n  ^ This is a BILLING BUG in this codebase, not usage. See the header of this file.\n');
  } else {
    console.log('No reference appears twice — every dub was bought exactly once.\n');
  }

  // ── What each project cost, so the total reconciles against the invoice ──────────────────────
  console.log('created              languages  minutes   est. cost   reference');
  let total = 0;
  for (const r of [...inWindow].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))) {
    const languageCount = r.languages.filter((l) => !l.startsWith('<')).length;
    const cost = estimateDubbingCost({
      durationSec: r.durationSec ?? 0,
      languageCount,
      // The clean rate: a watermarked dub is unshippable, so it is not what this product buys.
      watermarked: false,
    });
    total += cost.usd;
    const when = (r.createdAt ?? '(no date)').slice(0, 19).replace('T', ' ');
    console.log(
      `${when.padEnd(20)} ${String(languageCount).padStart(9)}  ${cost.minutes.toFixed(2).padStart(7)}   ` +
      `${money(cost.usd).padStart(9)}   ${r.reference ?? '(none)'}`,
    );
  }
  console.log(`${''.padEnd(20)} ${''.padStart(9)}  ${''.padStart(7)}   ${money(total).padStart(9)}   TOTAL (estimated)\n`);
  console.log('The estimate uses the vendor HEADLINE rate of $2.20 per source-minute per language.');
  console.log('A real invoice below this is the plan\'s discount; a real invoice ABOVE it means the');
  console.log('account was billed for work this listing does not show — which is itself the finding.\n');
}

main().catch((err) => {
  if (err instanceof ElevenLabsKeyMissingError) {
    console.error('\nNo ElevenLabs API key in the environment.');
    console.error('Run it where the key is set, e.g. from the backend container:');
    console.error('  docker compose exec backend node dist/scripts/dubbing-audit.js\n');
    process.exit(2);
  }
  console.error('\ndubbing-audit failed:', (err as Error).message);
  process.exit(1);
});
