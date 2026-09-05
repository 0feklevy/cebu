// Why does a take sometimes record a DIFFERENT page than the one it drove?
//
// f4-s1-public-page came back twice with the scratch editor's first paint ghosted under the demo
// viewer (double Ask! buttons, "No videos yet" over the film). Instrument rather than theorise:
// launch the capture profile exactly as the driver does, watch what pages appear and when, drive
// one page to the share URL, then compare a SCREENSHOT of that page against a FRAME decoded from
// its own video file. If the screenshot is clean and the frame is not, the recording is the
// problem, not the navigation.
//
//   node probe-recording.mjs            # uses the real capture profile
//   node probe-recording.mjs --fresh    # a throwaway profile, to test the restore theory
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const OUT = join(HERE, 'out', 'diag');
mkdirSync(OUT, { recursive: true });
const T = JSON.parse(readFileSync(join(HERE, '../seeding/TEMPLATE.json'), 'utf8'));
const fresh = process.argv.includes('--fresh');
const PROFILE = fresh ? mkdtempSync(join(tmpdir(), 'fv-profile-')) : join(HERE, 'chrome-profile');
console.log('profile:', PROFILE);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1600, height: 900 } },
});

// 1 · What pages exist, and when do they appear?
const seen = [];
ctx.on('page', (p) => seen.push({ at: Date.now(), url: p.url(), how: 'event' }));
console.log('pages at launch:', ctx.pages().map((p) => p.url()));
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 300));
  const urls = ctx.pages().map((p) => p.url());
  if (urls.length) console.log(`  +${(i + 1) * 300}ms pages:`, urls);
}

// 2 · Close everything, then drive ONE page.
for (const p of ctx.pages()) { const v = p.video(); await p.close().catch(() => {}); await v?.delete().catch(() => {}); }
const page = await ctx.newPage();
await page.bringToFront();
console.log('after newPage, pages:', ctx.pages().length);
await page.goto(T.demo.shareUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
console.log('driven page url:', page.url(), '| pages now:', ctx.pages().map((p) => p.url().slice(0, 60)));

// 3 · Screenshot (what the page IS) next to the video (what got recorded).
await page.screenshot({ path: join(OUT, 'driven-page.png') });
const v = page.video();
await page.close();
const raw = await v.path();
await ctx.close();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '4', '-i', raw, '-frames:v', '1', join(OUT, 'recorded-frame.png')]);
console.log('\nscreenshot :', join(OUT, 'driven-page.png'));
console.log('video frame:', join(OUT, 'recorded-frame.png'));
console.log('raw video  :', raw);
console.log('page events:', seen);
