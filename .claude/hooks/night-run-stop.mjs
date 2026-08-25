#!/usr/bin/env node
/**
 * NIGHT RUN — refuse to stop while there is work left.
 *
 * The owner's standing instruction, given three times and ignored three times: during an unattended
 * run, finishing a PR is not a stopping point. Written as a HOOK rather than another paragraph in
 * CLAUDE.md because the paragraph already exists (§3c) and did not hold.
 *
 * Armed by the presence of `.claude/night-run`. Delete that file and this hook does nothing, so the
 * owner can end it without editing settings.
 *
 * BOUNDED ON PURPOSE. It blocks at most MAX_BLOCKS consecutive stops, counted in a state file next
 * to the sentinel. An assistant with genuinely nothing left to do must be able to stop, and a hook
 * that can loop forever is a worse failure than the one it prevents.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTINEL = join(HERE, '..', 'night-run');
const COUNTER = join(HERE, '..', '.night-run-blocks');
const MAX_BLOCKS = 40;

if (!existsSync(SENTINEL)) process.exit(0);          // not a night run — never interfere

let n = 0;
try { n = Number(readFileSync(COUNTER, 'utf8')) || 0; } catch { n = 0; }

if (n >= MAX_BLOCKS) {
  try { unlinkSync(COUNTER); } catch { /* first run */ }
  console.log(JSON.stringify({
    systemMessage: `night-run: ${MAX_BLOCKS} consecutive stops blocked — standing down so this cannot loop. Delete .claude/night-run to disarm.`,
  }));
  process.exit(0);
}

writeFileSync(COUNTER, String(n + 1));
console.log(JSON.stringify({
  decision: 'block',
  reason:
    'NIGHT RUN IS ACTIVE. This is not a stopping point. Open the ledger ' +
    '(.claude/review/DECISIONS.md), take the next item, and keep working. ' +
    'Only two things justify stopping: a decision only the owner can make, or an action only the ' +
    'owner can take — and for either, say it in one line and CONTINUE with everything that does ' +
    'not depend on the answer. CI waiting, a PR merged, a wave finished: none of those are ' +
    'stopping points. If you believe there is genuinely nothing left, say what you checked.',
}));
