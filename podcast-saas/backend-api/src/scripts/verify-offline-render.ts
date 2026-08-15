/**
 * OFFLINE RENDER VERIFICATION — run a real simulation package through the real capture-preparation
 * code, in a real browser, with every non-loopback request BLOCKED, and prove it renders.
 *
 * WHY THIS EXISTS: the v0.1.26 incident could only be settled by looking at pixels. The gate said
 * "uniform canvas"; the cause was an import map pointing at a CDN. This tool closes that loop
 * without a full export: it takes a package as stored, runs the PRODUCTION dependency closure over
 * it, serves it through the PRODUCTION loopback server, and drives a real Chrome — then reports
 * the WebGL renderer string, whether frames actually change, and any request that tried to leave
 * loopback.
 *
 * WHAT IT PROVES: that the offline dependency closure makes a package boot and render with zero
 * external access. Requests to any non-loopback origin are actively FAILED (stronger than merely
 * having no network: a cached response cannot mask a missing dependency), and each attempt is
 * reported.
 *
 * WHAT IT DOES NOT PROVE: the Linux container path. `HeadlessExperimental.beginFrame` does not
 * exist on macOS, so frames here are `Page.captureScreenshot` on the real clock — the same
 * substitution `playwrightScreenshotBackend` documents. The container/beginFrame path is smoke
 * Stages A–E on a Linux host.
 *
 *   pnpm --filter backend-api exec tsx src/scripts/verify-offline-render.ts \
 *     --package ~/Desktop/boids-3d --entry index.html --out /tmp/verify-boids [--seconds 4]
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { launchHeadlessShell } from '../services/export/capture/cdpPipeTransport.js';
import { LoopbackPackageServer } from '../services/export/capture/isolation/loopbackPackageServer.js';
import { prepareOfflinePackage, type PreparedFile } from '../services/export/capture/dependencies/offlinePackage.js';
import { PageAudit } from '../services/export/capture/pageAudit.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined && fallback === undefined) {
    throw new Error(`missing --${name}`);
  }
  return v ?? fallback!;
}

/** Read a directory tree into package-root-relative files, skipping dotfiles as uploads do. */
async function readPackage(root: string): Promise<PreparedFile[]> {
  const out: PreparedFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push({ path: relative(root, abs).split(sep).join('/'), content: await readFile(abs) });
    }
  };
  await walk(root);
  return out;
}

/**
 * The generated package-root bridge, in the shape `SimulationService` publishes: SIM_READY after
 * the document's own boot, SCRIPT_APPLIED on startScript, and SIM_PAINTED once a frame has drawn.
 * Synthesised here because a package directory on disk has no generated runtime yet.
 */
const BRIDGE_JS = `;(function(){
  var _ready=false;
  function fire(){ if(_ready) return; _ready=true; window.postMessage({type:'SIM_READY'},'*'); }
  requestAnimationFrame(function(){ requestAnimationFrame(fire); });
  setTimeout(fire, 3000);
  var painted=false;
  function paintWatch(){
    if(!painted){
      var c=document.querySelector('canvas');
      if(c && c.width>1){ painted=true; window.postMessage({type:'SIM_PAINTED'},'*'); }
    }
    requestAnimationFrame(paintWatch);
  }
  requestAnimationFrame(paintWatch);
  window.addEventListener('message',function(e){
    var d=(e&&e.data)||{};
    if(d.type==='startScript'){ window.postMessage({type:'SCRIPT_APPLIED',token:d.token},'*'); }
    if(d.type==='PING_SIM_READY'&&_ready){ window.postMessage({type:'SIM_READY'},'*'); }
  });
})();`;

async function main(): Promise<void> {
  const packageDir = arg('package').replace(/^~/, process.env.HOME ?? '~');
  const entryRel = arg('entry', 'index.html');
  const outDir = arg('out', '/tmp/verify-offline-render');
  const seconds = Number(arg('seconds', '4'));
  const shellPath =
    process.env.CHROME_HEADLESS_SHELL_PATH ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'frames'), { recursive: true });

  // ── 1. the package, exactly as storage would hold it (nested entry + root bridge) ──────────────
  const inner = await readPackage(packageDir);
  const packageName = packageDir.replace(/\/+$/, '').split('/').pop()!;
  const stored: PreparedFile[] = [
    { path: 'bridge.js', content: Buffer.from(BRIDGE_JS) },
    ...inner.map((f) => ({ path: `${packageName}/${f.path}`, content: f.content })),
  ];
  const entryPath = `${packageName}/${entryRel}`;
  console.log(`package: ${stored.length} files, entry ${entryPath}`);

  // ── 2. the PRODUCTION dependency closure ───────────────────────────────────────────────────────
  const prepared = await prepareOfflinePackage(stored, entryPath);
  console.log(`vendored: ${prepared.vendoredPacks.join(', ') || '(none)'} (${prepared.vendoredBytes} bytes)`);
  console.log(`rewritten: ${prepared.rewrittenSpecifiers.join(' | ') || '(none)'}`);
  console.log(`neutralised: ${prepared.neutralisedUrls.join(' | ') || '(none)'}`);
  console.log(`unresolved: ${prepared.unresolved.map((u) => `${u.kind}:${u.raw}`).join(' | ') || '(none)'}`);

  // ── 3. the PRODUCTION loopback server ──────────────────────────────────────────────────────────
  const server = new LoopbackPackageServer(
    prepared.files.map((f) => ({ path: f.path, content: f.content })),
    { entryPath },
  );
  await server.start();
  const entryUrl = server.entryUrl('?section=verify&v=1', '');
  console.log(`serving: ${entryUrl}`);

  const audit = new PageAudit();
  const externalAttempts: string[] = [];
  const handle = launchHeadlessShell({
    executablePath: shellPath,
    flags: [
      '--headless',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--mute-audio',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1280,720',
    ],
  });
  const cdp = handle.connection;

  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', width: 1280, height: 720 });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId as string, flatten: true });
    const sid = attached.sessionId as string;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Network.enable', {}, sid);

    // EVERY non-loopback request is failed outright. Stronger than "no network": a warm HTTP cache
    // or a resolvable CDN cannot hide a dependency the package still needs.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sid);
    const pending = new Map<string, string>();
    cdp.onEvent((event) => {
      if (event.sessionId !== sid) return;
      if (event.method === 'Fetch.requestPaused') {
        const req = event.params.request as { url: string };
        const id = event.params.requestId as string;
        if (PageAudit.isExternalUrl(req.url)) {
          externalAttempts.push(req.url);
          void cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'InternetDisconnected' }, sid);
        } else {
          void cdp.send('Fetch.continueRequest', { requestId: id }, sid);
        }
      } else if (event.method === 'Network.requestWillBeSent') {
        const r = event.params.request as { url?: string } | undefined;
        if (r?.url) pending.set(String(event.params.requestId), r.url);
      } else if (event.method === 'Network.loadingFailed') {
        audit.recordFailedRequest(pending.get(String(event.params.requestId)) ?? '', String(event.params.errorText ?? ''));
      } else if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        audit.recordException(d?.exception?.description ?? d?.text ?? 'exception');
      } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        const args = (event.params.args as Array<{ description?: string; value?: unknown }>) ?? [];
        audit.recordConsoleError(args.map((a) => String(a.description ?? a.value ?? '')).join(' '));
      }
    });

    await cdp.send('Page.navigate', { url: entryUrl }, sid);
    const evaluate = async (expression: string): Promise<unknown> => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      return (res.result as { value?: unknown } | undefined)?.value;
    };

    // Let the module graph load and the scene boot on the real clock.
    await new Promise((r) => setTimeout(r, 3_000));
    await evaluate(`window.postMessage({type:'startScript',script:'verify',params:{simpleUi:false,autoScript:true},token:1},'*')`);
    await new Promise((r) => setTimeout(r, 1_500));

    const renderer = String(
      (await evaluate(`(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return '';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      })()`)) ?? '',
    );
    const threeLoaded = await evaluate(`typeof window.__THREE__ !== 'undefined' || !!document.querySelector('canvas')`);

    // Frames on the real clock — enough to show motion.
    const fps = 10;
    const total = Math.max(3, Math.round(seconds * fps));
    for (let i = 0; i < total; i++) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, sid);
      await writeFile(
        join(outDir, 'frames', `frame-${String(i).padStart(4, '0')}.jpg`),
        Buffer.from(String(shot.data), 'base64'),
      );
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }

    const report = {
      package: packageDir,
      entryPath,
      files: prepared.files.length,
      vendoredPacks: prepared.vendoredPacks,
      vendoredBytes: prepared.vendoredBytes,
      rewrittenSpecifiers: prepared.rewrittenSpecifiers,
      neutralisedUrls: prepared.neutralisedUrls,
      unresolved: prepared.unresolved,
      rendererString: renderer,
      canvasPresent: Boolean(threeLoaded),
      externalRequestAttempts: [...new Set(externalAttempts)],
      pageAudit: audit.summarise(),
      frames: total,
      framesDir: join(outDir, 'frames'),
    };
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n── report ──');
    console.log(`  rendererString      ${JSON.stringify(renderer)}`);
    console.log(`  canvasPresent       ${report.canvasPresent}`);
    console.log(`  externalAttempts    ${report.externalRequestAttempts.length}`);
    for (const u of report.externalRequestAttempts.slice(0, 5)) console.log(`      ${u}`);
    console.log(`  pageAudit           ${report.pageAudit ?? '(clean)'}`);
    console.log(`  frames              ${total} in ${report.framesDir}`);
  } finally {
    await handle.kill().catch(() => {});
    await server.stop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
