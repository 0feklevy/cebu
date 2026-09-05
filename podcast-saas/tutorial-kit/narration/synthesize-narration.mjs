// Synthesize every narration line through the PRODUCT's own TTS path (GuidanceTTSService),
// with the admin default voice — exactly what production guidance uses. Run via
// run-narration.sh (tsx + backend env). Idempotent: skips clips that already exist unless
// --force. Writes SPEND.md with the character ledger.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force');

const { GuidanceTTSService, resolveGuidanceVoice } =
  await import('../../backend-api/src/services/audio/GuidanceTTSService.ts');

const lines = JSON.parse(readFileSync(join(HERE, 'lines.json'), 'utf8'));
const narratorCfg = await resolveGuidanceVoice('en');
// A clearly different premade voice for the two in-film VIEWER questions ("Antoni").
const viewerCfg = { voiceId: 'ErXwobaYiN019PkySvjV', model: narratorCfg.model };

// The LOCAL admin_settings row stores an ElevenLabs key ID, not a key (vendor rejects it with
// "API key ID used as API key"); the working credential lives in the env, which is exactly the
// fallback GuidanceTTSService already implements. Bypass the broken keystore row for this run
// only — flagged in FOLLOWUP as a local-config defect, not code.
const tts = new GuidanceTTSService({ getSystemKey: async () => null });
const ledger = [];
let synthesized = 0, skipped = 0, chars = 0;

for (const l of lines) {
  const name = `f${l.film}-s${l.scene}.mp3`;
  const path = join(HERE, 'audio', name);
  if (existsSync(path) && !force) { skipped++; continue; }
  const cfg = l.role === 'viewer' ? viewerCfg : narratorCfg;
  const buf = await tts.synthesize(l.text, cfg);
  writeFileSync(path, buf);
  synthesized++;
  chars += l.text.length;
  ledger.push({ name, role: l.role, chars: l.text.length, bytes: buf.length });
  console.log(`✓ ${name} (${l.role}, ${l.text.length} chars, ${(buf.length / 1024).toFixed(0)}KB)`);
}

const spend = [
  '# Narration TTS spend ledger',
  '',
  `Run: ${new Date().toISOString()}`,
  `Voice (narrator): ${narratorCfg.voiceId} · model ${narratorCfg.model} (admin default via resolveGuidanceVoice)`,
  `Voice (viewer questions): ${viewerCfg.voiceId} ("Antoni", ElevenLabs premade)`,
  `Clips synthesized this run: ${synthesized} (skipped existing: ${skipped})`,
  `Characters billed this run: ${chars}`,
  '',
  '| clip | role | chars | bytes |',
  '|---|---|---|---|',
  ...ledger.map(e => `| ${e.name} | ${e.role} | ${e.chars} | ${e.bytes} |`),
  '',
].join('\n');
writeFileSync(join(HERE, existsSync(join(HERE, 'SPEND.md')) && !force ? 'SPEND-latest.md' : 'SPEND.md'), spend);
console.log(`\nDone: ${synthesized} synthesized, ${skipped} skipped, ${chars} chars billed.`);
