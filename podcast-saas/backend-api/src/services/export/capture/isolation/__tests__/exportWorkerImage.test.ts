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
import { existsSync, readFileSync } from 'node:fs';
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
 * The REAL smoke (deploy/scripts/export-worker-smoke.sh) — three stages, each in the production
 * jail. The script cannot run here (no docker on dev/CI), so its CONTRACT is pinned: the proven
 * capability pair, the full jail, and each stage's load-bearing assertion. Stage A alone
 * false-passed v0.1.22 (Chrome rendered while the backend module was unloadable), hence B and C.
 */
describe('export-worker-smoke.sh — the three-stage smoke contract', () => {
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
      '--memory 2048m',
      '--memory-swap 2048m',
      '--cpus 2',
      // The same cage production builds, including the PID-1 init and the graceful window.
      '--init',
      '--stop-timeout 10',
    ]) {
      expect(smoke).toContain(flag);
    }
  });

  it('Stage A renders a marker via dump-dom — not test -x, not --version', () => {
    expect(smoke).toContain('--dump-dom');
    expect(smoke).toContain('FLOWVID-SANDBOX-OK');
    expect(smoke).toMatch(/grep -q "\$MARKER"/);
  });

  it("Stage B loads the backend through the IMAGE'S OWN env var — no duplicated path to drift", () => {
    expect(smoke).toContain('import(process.env.EXPORT_CAPTURE_BACKEND_MODULE)');
    expect(smoke).toContain('BACKEND-CONTRACT-OK');
    expect(smoke).toContain("captureSection");
    expect(smoke).toContain('available: true'); // the backend must also report runnable in its own image
  });

  it('Stage C runs the REAL entrypoint on a NON-static fixture and demands distinct frames + a passed gate', () => {
    expect(smoke).toContain('SIM_READY');
    expect(smoke).toContain('SIM_PAINTED');
    expect(smoke).toContain('dst=/input,ro');
    expect(smoke).toContain('dst=/output');
    expect(smoke).toContain('"gate": *"passed"');
    expect(smoke).toContain('"frameCount": *60');
    expect(smoke).toMatch(/cmp -s .*frame-000000\.jpg.*frame-000059\.jpg/);
    // The fixture animates (frame counter + hue) so byte-identical frames mean a dead compositor.
    expect(smoke).toContain("'FRAME ' + frame");
  });

  /** The Stage D block only — so a Stage C assertion can never stand in for a Stage D one. */
  const stageD = (): string => {
    const at = smoke.indexOf('STAGE D:');
    expect(at, 'the smoke script must contain a Stage D').toBeGreaterThan(-1);
    return smoke.slice(at);
  };

  it('Stage D reproduces the PRODUCTION TOPOLOGY: nested entry loading ../bridge.js', () => {
    // Stage C's fixture is flat and self-contained, so it could never fail the v0.1.23 bug.
    // Stage D is the shape that did: package-root runtime + a nested entry referencing it upward.
    const d = stageD(); // scoped: Stage C cannot satisfy any of these
    expect(d).toContain('src="../bridge.js?v=smoke"');
    expect(d).toContain('"entryPath": "scene/index.html"'); // nested, not a bare basename
    expect(d).toMatch(/mkdir -p "\$IN_D\/scene\/src"/);     // the bridge is NOT beside the entry
    // The full handshake must be exercised, not just a paint.
    expect(d).toContain('SIM_READY');
    expect(d).toContain('SCRIPT_APPLIED');
    expect(d).toContain('SIM_PAINTED');
    // Same demands as Stage C: real frames, distinct endpoints, passed gate.
    expect(d).toContain('STAGE-D: FAIL — sanity gate did not pass');
    expect(d).toMatch(/cmp -s "\$OUT_D\/frames\/frame-000000\.jpg" "\$OUT_D\/frames\/frame-000059\.jpg"/);
    // And it runs in the SAME cage — no relaxation for the harder fixture.
    expect(d).toMatch(/docker run --rm "\$\{CAGE\[@\]\}" "\$\{CHROME_CAPS\[@\]\}"[\s\S]{0,200}dst=\/input,ro/);
  });

  it('never contains --no-sandbox or --privileged, even as an option', () => {
    expect(smoke).not.toMatch(/--no-sandbox/);
    expect(smoke).not.toMatch(/--privileged/);
  });
});

describe('EXPORT_CAPTURE_BACKEND_MODULE ↔ the source tree (the misconfigured-path mutation)', () => {
  it('the Dockerfile points at a dist path whose SOURCE module exists', () => {
    const match = /ENV EXPORT_CAPTURE_BACKEND_MODULE=(\S+)/.exec(text);
    expect(match, 'Dockerfile must set EXPORT_CAPTURE_BACKEND_MODULE').toBeTruthy();
    const distPath = (match as RegExpExecArray)[1];
    expect(distPath).toMatch(/^\/app\/backend-api\/dist\/.+\.js$/);
    const srcRelative = distPath
      .replace('/app/backend-api/dist/', '')
      .replace(/\.js$/, '.ts');
    const srcPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../..', // …/backend-api/src
      srcRelative,
    );
    expect(existsSync(srcPath), `source module ${srcRelative} must exist for the baked dist path`).toBe(true);
  });
});
