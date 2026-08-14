/**
 * Capture ONE timeline section, through the REAL production provider, without running an export.
 *
 * WHY THIS EXISTS: every step of this incident was diagnosed by running a 20-minute, 12-window
 * project export and reading container logs as they scrolled past — three times. A single section
 * exercises the identical path (plan resolution → package root → offline dependency closure →
 * hardened container → Chrome → sanity gate) in under a minute, and prints the facts that took a
 * live `docker events` session to recover.
 *
 * WHAT IT IS NOT: it does not write anything. No export row, no storage object, no DB mutation —
 * the section is READ to find its simulation URL, and the capture output goes to a temp dir. The
 * real export path is untouched and still uses the plan's frozen `servedSimUrl`; this tool
 * resolves the same URL the same way, read-only, for diagnosis.
 *
 *   pnpm --filter backend-api exec tsx src/scripts/capture-one-section.ts \
 *     --section-id 75639e6c-c18d-470d-8334-d14106e32371
 *
 * Requires the capture provider to be configured (EXPORT_CAPTURE_IMAGE), exactly as production is.
 */

import { rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { simulations, timeline_sections } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { resolveSimulationUrl } from '../services/simulation/simulationUrlResolver.js';
import { resolveConfiguredCaptureProvider } from '../services/export/capture/isolation/containerCaptureProvider.js';
import { parseServedSimUrl } from '../services/export/capture/isolation/containerCaptureProvider.js';
import { prepareOfflinePackage } from '../services/export/capture/dependencies/offlinePackage.js';
import { CaptureUnavailable } from '../services/export/capture/captureTypes.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const sectionId = arg('section-id');
  if (!sectionId) {
    console.error('usage: capture-one-section.ts --section-id <uuid> [--duration <sec>]');
    process.exit(2);
  }
  const durationOverride = Number(arg('duration') ?? '0');

  const [section] = await db.select().from(timeline_sections).where(eq(timeline_sections.id, sectionId));
  if (!section) throw new Error(`section ${sectionId} not found`);
  const [sim] = section.simulation_id
    ? await db.select().from(simulations).where(eq(simulations.id, section.simulation_id))
    : [undefined];

  const storage = getStorageAdapter();
  const servedUrl = resolveSimulationUrl(section.simulation_url, sim ?? null, storage);
  if (!servedUrl) throw new Error(`section ${sectionId} has no simulation URL`);

  const source = parseServedSimUrl(servedUrl);
  console.log('── section ────────────────────────────────────────────────');
  console.log('  sectionId     ', sectionId);
  console.log('  simulationId  ', section.simulation_id ?? '(none)');
  console.log('  simpleUi      ', section.simple_ui ?? false);
  console.log('  autoScript    ', section.auto_script ?? true);
  console.log('  layout        ', source?.layout ?? '(unparseable)');
  console.log('  packageRoot   ', source?.packageRoot ?? '-');
  console.log('  entryPath     ', source?.entryPath ?? '-');
  if (!source) throw new Error(`servedSimUrl is not a sim-public key: ${servedUrl}`);

  // Dependency picture BEFORE capture — the fastest way to see a package that cannot render offline.
  const prefix = `${source.packageRoot}/`;
  const keys = await storage.listObjects(prefix);
  const files = await Promise.all(
    keys.map(async (k) => ({ path: k.slice(prefix.length), content: await storage.readObject(k) })),
  );
  console.log('── package ────────────────────────────────────────────────');
  console.log('  files         ', files.length);
  console.log('  hasBridge     ', files.some((f) => f.path === 'bridge.js'));
  try {
    const prepared = await prepareOfflinePackage(files, source.entryPath);
    console.log('  vendoredPacks ', prepared.vendoredPacks.join(', ') || '(none)');
    console.log('  vendoredBytes ', prepared.vendoredBytes);
    console.log('  rewritten     ', prepared.rewrittenSpecifiers.join(' | ') || '(none)');
    console.log('  neutralised   ', prepared.neutralisedUrls.join(' | ') || '(none)');
    console.log('  unresolved    ', prepared.unresolved.map((u) => `${u.kind}:${u.raw}`).join(' | ') || '(none)');
  } catch (err) {
    console.log('  dependency closure FAILED:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const provider = resolveConfiguredCaptureProvider();
  if (!provider) {
    console.error('\nEXPORT_CAPTURE_IMAGE is not set — configure the provider exactly as production does.');
    process.exit(3);
  }
  console.log('── capture ────────────────────────────────────────────────');
  console.log('  provider      ', provider.name, '| available:', await provider.isAvailable());

  const started = Date.now();
  let clipPath: string | undefined;
  try {
    const result = await provider.captureSection({
      servedSimUrl: servedUrl,
      sectionId,
      simpleUi: section.simple_ui ?? false,
      autoScript: section.auto_script ?? true,
      uiHide: [],
      durationSec: durationOverride > 0 ? durationOverride : 2,
      fps: 30,
      width: 1920,
      height: 1080,
      configHash: '',
      posterKey: '',
    });
    clipPath = result.clipPath;
    const bytes = result.clipPath ? (await stat(result.clipPath)).size : 0;
    console.log('  frameCount    ', result.frameCount);
    console.log('  rendererString', JSON.stringify(result.rendererString));
    console.log('  gate          ', result.gate);
    console.log('  reason        ', result.reason ?? '(none)');
    console.log('  clipBytes     ', bytes);
    console.log('  elapsedSec    ', ((Date.now() - started) / 1000).toFixed(1));
    console.log(result.gate === 'passed' && bytes > 0 ? '\nRESULT: GREEN' : '\nRESULT: RED');
    process.exitCode = result.gate === 'passed' && bytes > 0 ? 0 : 1;
  } catch (err) {
    const unavailable = err instanceof CaptureUnavailable;
    console.log(`\nRESULT: RED (${unavailable ? 'capture unavailable' : 'capture failed'})`);
    console.log('  ', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (clipPath) await rm(clipPath, { force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
