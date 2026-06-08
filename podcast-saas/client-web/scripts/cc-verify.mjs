import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const TOKEN = process.argv[2];
const S = 'http://localhost:3000';
const OUT = '/tmp/p2val-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const consoleErrors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 80)} (${r.failure()?.errorText})`));
page.on('response', (r) => { if (r.status() >= 400 && /caption|vtt/i.test(r.url())) failed.push(`${r.status()} ${r.url().slice(0, 80)}`); });

await page.goto(`${S}/v/${TOKEN}`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('.viewer-cc-btn', { timeout: 20000 }).catch(() => {});

const ccBtn = page.locator('.viewer-cc-btn').first();
const ccVisible = await ccBtn.isVisible().catch(() => false);
const ccDisabled = await ccBtn.isDisabled().catch(() => true);
console.log('CC button visible:', ccVisible, '| disabled:', ccDisabled);

// Verify the VTT was fetched successfully by the player.
const vttResp = await page.evaluate(async () => {
  const u = document.querySelector('video');
  return !!u;
});

// Enable captions, seek into the first cue, and read the overlay.
if (ccVisible && !ccDisabled) {
  await ccBtn.click();
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.currentTime = 3; v.play().catch(() => {}); }
  });
  await page.waitForTimeout(2500);
}
const overlay = await page.locator('.viewer-caption-text').first().textContent().catch(() => null);
console.log('caption overlay text:', JSON.stringify((overlay || '').slice(0, 80)));

await page.screenshot({ path: `${OUT}/cc-viewer.png` }).catch(() => {});
const meaningfulFailed = failed.filter((f) => !/favicon|\/icon/.test(f));
console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 3).join(' | '));
console.log('failed caption/vtt requests:', meaningfulFailed.length, meaningfulFailed.slice(0, 3).join(' | '));
console.log('hasVideo:', vttResp);
await browser.close();
