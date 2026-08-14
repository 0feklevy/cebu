#!/usr/bin/env node
/**
 * Stream one shipment's notable events, then exit when the shipment ends.
 *
 *   node podcast-saas/ops/ship/watch.mjs .claude/ship/runs/<id>/ship.ndjson
 *
 * Designed to be the command behind a Claude `Monitor`: every line printed here becomes
 * one notification, and the process exits on `run.end` so the watch does not linger.
 *
 * Plain .mjs with no dependencies — not jq, not tsx — because a watcher that needs a
 * toolchain is a watcher that silently fails to attach on a fresh machine.
 *
 * Three properties matter:
 *   • It replays from the first event, so attaching late still shows the whole shipment.
 *   • It only ever reads COMPLETE lines, so a half-written record is never parsed.
 *   • It exits on `run.end` and only on `run.end`. The conductor emits that event from
 *     its own catch block, so even a crashed shipment ends the watch — silence here
 *     always means "still working", never "quietly finished".
 */
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: watch.mjs <path/to/ship.ndjson>\n');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The conductor creates the journal within a second of starting; wait rather than race it.
for (let i = 0; i < 30 && !existsSync(file); i++) await sleep(1_000);
if (!existsSync(file)) {
  process.stderr.write(`ship: no event journal at ${file}\n`);
  process.exit(1);
}

let consumed = 0; // complete lines already emitted

for (;;) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    await sleep(2_000); // the file is mid-write; try again
    continue;
  }

  // Everything up to the last newline is complete. A trailing partial record waits.
  const lastNewline = text.lastIndexOf('\n');
  const lines = lastNewline < 0 ? [] : text.slice(0, lastNewline).split('\n');

  let ended = false;
  for (const raw of lines.slice(consumed)) {
    if (!raw.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue; // a corrupt record must not stop the stream
    }
    if (ev.notify) process.stdout.write(`${ev.line}\n`);
    if (ev.event === 'run.end') ended = true;
  }
  consumed = lines.length;

  if (ended) break;
  await sleep(2_000);
}
