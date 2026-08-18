/**
 * Pins the PRODUCTION wiring of the stuck-work reapers.
 *
 * `hlsRecovery.test.ts` and `corpusRecovery.test.ts` prove what those sweeps DO. That is only a
 * claim about the running system if `server.ts` actually starts them — and the whole point of
 * job-queue-003 is that a reaper which is never invoked again is indistinguishable from no reaper
 * at all. Deleting the `startHlsRecoverySweep()` line would leave both of those suites fully
 * green while restoring the exact bug they were written for.
 *
 * `server.ts` cannot be imported (module scope opens listeners and a database connection), so
 * this reads the source — the same shape, and for the same reason, as `trustProxyWiring.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(HERE, '../server.ts'), 'utf-8');
/** Comments stripped: the prose explains the bug, and prose must not satisfy an assertion. */
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('stuck-work reaper wiring', () => {
  it('starts the repeating HLS recovery sweep, not just a boot pass', () => {
    expect(serverCode, 'server.ts no longer imports the HLS reaper')
      .toMatch(/import\s*\{[^}]*startHlsRecoverySweep[^}]*\}\s*from\s*'\.\/services\/video\/hlsRecovery\.js'/);
    expect(serverCode, 'a reaper that is never started is the bug, not the fix')
      .toMatch(/\bstartHlsRecoverySweep\(\)/);
  });

  it('starts the corpus ingestion sweep', () => {
    expect(serverCode)
      .toMatch(/import\s*\{[^}]*startCorpusIngestionSweep[^}]*\}\s*from\s*'\.\/services\/ingestion\/corpusRecovery\.js'/);
    expect(serverCode).toMatch(/\bstartCorpusIngestionSweep\(\)/);
  });

  it('the boot pass shares the sweep`s predicate instead of redeclaring it', () => {
    // The old boot pass inlined its own `hls_status='processing' AND hls_started_at < cutoff`
    // with a 30-minute literal. A second copy of a staleness rule is how the two drift.
    expect(serverCode, 'the boot pass must delegate to the shared sweep')
      .toMatch(/\bawait sweepStuckTranscodes\(\)/);
    // Assert the DUPLICATED RULE is gone, not that a number is absent. An earlier draft banned
    // the literal `30 * 60 * 1000` outright, which would have failed this suite for any unrelated
    // thirty-minute constant a future edit adds to server.ts — a misleading red in a file the
    // author was not thinking about. What must not come back is server.ts re-deriving the
    // staleness cutoff for itself; that is what this checks.
    expect(serverCode, 'server.ts must not rebuild the HLS staleness predicate — delegate to hlsRecovery.ts')
      .not.toMatch(/hls_started_at[\s\S]{0,120}(lt|<)[\s\S]{0,80}(Date\.now|new Date)/);
  });

  it('still runs every boot recovery pass before the server listens', () => {
    for (const fn of [
      'recoverStuckTranscodes', 'recoverStuckCrops', 'recoverStuckSimulations',
      'recoverStuckPodcastScripts', 'recoverStuckPodcastRenders', 'recoverStuckPodcastMixes',
      'recoverStuckVideoGenerations',
    ]) {
      expect(serverCode, `${fn} is no longer called at boot`).toMatch(new RegExp(`await ${fn}\\(\\)`));
    }
  });
});

describe('the HLS lease', () => {
  it('a live transcode beats the heartbeat the sweep measures', () => {
    // Without this call the repeating sweep degrades from a liveness test into "encoding has
    // taken longer than the window", and would reap honest long transcodes.
    const transcodeSrc = readFileSync(resolve(HERE, '../services/video/runVideoTranscode.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(transcodeSrc).toMatch(/beatHlsHeartbeat\(video_file_id\)/);
    expect(transcodeSrc, 'the heartbeat must be stopped on every exit path').toMatch(/finally\s*\{[\s\S]*?stopHeartbeat\(\)/);
  });
});
