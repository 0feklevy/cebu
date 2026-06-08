// Phase 2 browser validation — console errors, failed requests, rendering, screenshots.
// Run: node scripts/p2val-e2e.mjs <nonce>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const N = process.argv[2];
const S = process.env.S || 'http://localhost:3000';
const OUT = '/tmp/p2val-shots';
mkdirSync(OUT, { recursive: true });

async function visit(browser, path, name, { expectSelector } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url().slice(0, 90)} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 90)}`); });

  const resp = await page.goto(`${S}${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => ({ status: () => 'ERR ' + e.message }));
  let selectorOk = null;
  if (expectSelector) selectorOk = await page.locator(expectSelector).first().isVisible().catch(() => false);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
  await ctx.close();
  return { path, status: typeof resp.status === 'function' ? resp.status() : resp.status, selectorOk, consoleErrors, failed };
}

const browser = await chromium.launch();
const results = [];
results.push(await visit(browser, `/c/p2val-single-${N}`, 'course-single', { expectSelector: 'h1' }));
results.push(await visit(browser, `/c/p2val-multi-${N}/lesson-2`, 'lesson-multi', { expectSelector: 'h1' }));
results.push(await visit(browser, `/c/p2val-media-${N}/media-lesson`, 'lesson-media', { expectSelector: 'video, .aspect-video' }));
results.push(await visit(browser, `/c/p2val-hebrew-${N}`, 'course-hebrew', { expectSelector: 'h1' }));
await browser.close();

for (const r of results) {
  console.log(`\n${r.path}  [HTTP ${r.status}]  selectorVisible=${r.selectorOk}`);
  console.log(`  console errors: ${r.consoleErrors.length}${r.consoleErrors.length ? ' → ' + r.consoleErrors.slice(0, 3).join(' | ') : ''}`);
  // Ignore benign favicon/icon 404s and HLS range/CORS noise from external media.
  const meaningful = r.failed.filter((f) => !/\/icon|favicon/.test(f));
  console.log(`  failed requests: ${meaningful.length}${meaningful.length ? ' → ' + meaningful.slice(0, 4).join(' | ') : ''}`);
}
console.log(`\nScreenshots → ${OUT}`);
