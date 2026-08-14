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

  it('hard-asserts the extracted binary IN PLACE and creates no cross-stage symlink here', () => {
    // The stable-path symlink moved to the RUNNER stage (v0.1.21: COPYing it across stages
    // dereferences it into a standalone binary stripped of its distribution). This stage only
    // proves extraction produced a real executable with its ICU data beside it.
    const stage = chromeStage();
    expect(stage).toContain('test -x "$BIN"');
    expect(stage).not.toContain('ln -s');
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

/**
 * THE v0.1.21 INCIDENT: `COPY --from=chrome /opt/chrome-headless-shell` dereferenced the
 * convenience symlink into a standalone 188 MB binary, separated from the CfT distribution
 * siblings Chrome resolves relative to its executable (icudtl.dat, .pak resources, the v8
 * snapshot, locales/, libEGL/libGLESv2). It passed `test -x` and `--version`, then died at first
 * real launch: "Invalid file descriptor to ICU data received.", exit 133. The runner must copy
 * the WHOLE tree and re-derive the stable path as a symlink INTO it.
 */
describe('export-worker.Dockerfile — runner stage keeps the binary inside its distribution', () => {
  const runner = () => {
    const at = text.lastIndexOf('AS runner');
    expect(at).toBeGreaterThan(-1);
    return text.slice(at);
  };

  it('copies the complete /opt/chrome tree and NEVER copies the symlink/binary independently', () => {
    const stage = runner();
    expect(stage).toMatch(/COPY --from=chrome \/opt\/chrome\s+\/opt\/chrome\b/);
    // The dereferencing COPY of the stable path is the bug — it must not come back.
    expect(stage).not.toMatch(/COPY[^\n]*\/opt\/chrome-headless-shell/);
  });

  it('recreates the stable path as a symlink into the tree and asserts the ICU data beside the binary', () => {
    const stage = runner();
    const recreate = stage.match(/RUN BIN=[^]*?test -x \/opt\/chrome-headless-shell/)?.[0];
    expect(recreate, 'runner must discover the binary and relink /opt/chrome-headless-shell').toBeTruthy();
    expect(recreate).toContain('icudtl.dat');
    expect(recreate).toMatch(/ln -s "\$BIN" \/opt\/chrome-headless-shell/);
  });

  it('chrome stage asserts icudtl.dat at install time too, so drift fails at the earliest stage', () => {
    expect(chromeStage()).toContain('icudtl.dat');
  });

  it('points HOME and XDG caches below /tmp — the one writable (tmpfs) surface at runtime', () => {
    // Fontconfig probes /var/cache/fontconfig and $HOME/.cache on a read-only rootfs and logs
    // "No writable cache directories" on every launch; /tmp is the sanctioned scratch, and no
    // additional persistent mount may be introduced for this.
    const stage = runner();
    expect(stage).toMatch(/ENV HOME=\/tmp/);
    expect(stage).toMatch(/XDG_CACHE_HOME=\/tmp\/\.cache/);
    expect(stage).toMatch(/XDG_CONFIG_HOME=\/tmp\/\.config/);
  });
});

/**
 * The REAL smoke (deploy/scripts/export-worker-smoke.sh) launches Chrome in the production jail
 * and requires a rendered marker — `test -x`/`--version` already false-passed once. The script
 * cannot run here (no docker on dev/CI), so its CONTRACT is pinned: the proven capability pair,
 * the full jail, the render assertion, and the absent forbidden flags.
 */
describe('export-worker-smoke.sh — the render smoke contract', () => {
  const SMOKE = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../..',
    '../deploy/scripts/export-worker-smoke.sh',
  );
  const smoke = readFileSync(SMOKE, 'utf8');

  it('sys-admin grants exactly the proven pair: SYS_ADMIN + SYS_CHROOT', () => {
    expect(smoke).toContain('--cap-add SYS_ADMIN --cap-add SYS_CHROOT');
    expect(smoke).toContain('--cap-drop ALL');
  });

  it('keeps the production jail: network none, read-only, tmpfs, non-root, quotas, no-new-privileges', () => {
    for (const flag of [
      '--network none',
      '--read-only',
      '--tmpfs /tmp:rw,nosuid,nodev,noexec',
      '--security-opt no-new-privileges:true',
      '--pids-limit 256',
      '--memory 2048m --memory-swap 2048m --cpus 2',
    ]) {
      expect(smoke).toContain(flag);
    }
  });

  it('actually RENDERS a marker via dump-dom and fails without it — not test -x, not --version', () => {
    expect(smoke).toContain('--dump-dom');
    expect(smoke).toContain('FLOWVID-SANDBOX-OK');
    expect(smoke).toMatch(/grep -q "\$MARKER"/);
  });

  it('never contains --no-sandbox or --privileged, even as an option', () => {
    expect(smoke).not.toMatch(/--no-sandbox/);
    expect(smoke).not.toMatch(/--privileged/);
  });
});
