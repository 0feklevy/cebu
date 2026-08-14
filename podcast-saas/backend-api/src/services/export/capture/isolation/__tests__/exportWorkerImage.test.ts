/**
 * The export-worker Dockerfile's build-breaking invariants, pinned as text assertions.
 *
 * THE INCIDENT THIS PINS (v0.1.20): the `chrome` stage ran `@puppeteer/browsers install` on
 * bookworm-slim, which ships no zip archiver. CfT delivers linux64 chrome-headless-shell as a
 * .zip and the extractor shells out to `unzip` (yauzl is not a dependency), so every production
 * build died with "Extraction failed: no zip archiver is available". The image cannot be built
 * in CI on every backend change (it downloads a pinned browser), so the DEPENDENCY ORDER is
 * pinned here instead — cheap, runs everywhere, and fails the suite if someone drops the
 * `unzip` install or moves it after the step that needs it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCKERFILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../..', // backend-api
  '../deploy/docker/export-worker.Dockerfile',
);
const text = readFileSync(DOCKERFILE, 'utf8');

/** The `chrome` stage only: from its FROM…AS chrome line to the next FROM. */
function chromeStage(): string {
  const start = text.indexOf('AS chrome');
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('FROM ', start);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('export-worker.Dockerfile — chrome stage build invariants', () => {
  it('installs unzip BEFORE the @puppeteer/browsers install that needs it', () => {
    const stage = chromeStage();
    const unzipAt = stage.search(/apt-get install[^\n]*\bunzip\b/);
    const puppeteerAt = stage.indexOf('@puppeteer/browsers install');
    expect(unzipAt).toBeGreaterThan(-1);
    expect(puppeteerAt).toBeGreaterThan(-1);
    expect(unzipAt).toBeLessThan(puppeteerAt);
  });

  it('hard-asserts the extracted binary, so a dangling symlink cannot reach the runner stage', () => {
    expect(chromeStage()).toContain('test -x /opt/chrome-headless-shell');
  });

  it('never weakens the sandbox: --no-sandbox appears nowhere in the image definition', () => {
    // It is allowed in comments ONLY as a prohibition ("NEVER --no-sandbox"); a bare occurrence
    // outside such a warning is treated as a regression.
    const lines = text.split('\n').filter((l) => l.includes('--no-sandbox'));
    for (const line of lines) {
      expect(line).toMatch(/NEVER --no-sandbox|no --no-sandbox/i);
    }
  });
});
