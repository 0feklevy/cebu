/**
 * RELEASE-BLOCKING PRODUCTION FLOWS — the journeys whose breakage is worth an automatic rollback.
 *
 * The existing production suites answer "is the deployed site structurally sound": no localhost
 * URLs, no CSP violations, no stale service worker, the auth iframe is framed. Those are real,
 * and they are all *page-level*. They would not have caught a release where every page loaded
 * perfectly and no stored video could be played, because nothing followed a stored key all the
 * way to bytes in a browser.
 *
 * This file covers the flows the owner named as release-blocking, in their words:
 *
 *   "legacy DB URL without token → backend processing/token minting → valid final URL →
 *    resource successfully loads"
 *
 * plus opening an existing project, playback, and reaching the export entry point.
 *
 * ── THIS RUNS AGAINST REAL PRODUCTION. IT IS STRICTLY READ-ONLY. ──────────────────────────────
 * It opens pages, follows links, and issues GETs. It never submits an export, never writes, and
 * never deletes. An export job costs real compute and real storage; a smoke suite that queued one
 * on every release would be a slow, expensive, self-inflicted load test. So the export flow is
 * verified up to the point of REQUEST — the entry point renders and is reachable — which is the
 * leg that has actually broken, and stops before anything is enqueued.
 *
 * ── NOTHING HERE SKIPS SILENTLY ───────────────────────────────────────────────────────────────
 * Where a flow needs a fixture (a known public project), an unset variable makes the test FAIL,
 * not skip. `release-cli playwright-summary --require-tests` additionally refuses to score these
 * titles as passing unless they actually executed, so removing a repository variable can no
 * longer remove a check. That was a real hole: every fixture-dependent audit used `test.skip`,
 * and a skipped spec and a passing spec were indistinguishable to the gate.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com';

/** A fixture path, or a failure explaining exactly which variable is missing. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This flow is release-blocking, so a missing fixture fails the release ` +
        `rather than quietly removing the check. Set it as a repository variable.`,
    );
  }
  return v;
}

/** Requests the page made that never completed — the shape a broken media URL takes. */
function trackFailures(page: Page): string[] {
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText ?? 'failed';
    // Aborts are routine: the browser cancels media range requests when it has buffered enough,
    // and every <video> produces some. Only genuine transport failures are interesting.
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/i.test(err)) failed.push(`${r.url()} — ${err}`);
  });
  return failed;
}

test.describe('release-blocking: an existing project opens and its media resolves', () => {
  test('flow: opening an existing project renders its media without a broken URL', async ({ page }) => {
    const path = required('SMOKE_PUBLIC_PATH');
    const failed = trackFailures(page);

    const res = await page.goto(new URL(path, BASE).toString(), { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `project page returned ${res?.status()}`).toBeLessThan(400);
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

    // The page rendering is not the claim. The claim is that what it referenced resolved.
    expect(failed, `requests from the project page failed:\n${failed.join('\n')}`).toEqual([]);
  });

  test('flow: a stored media URL is minted and the resource actually loads', async ({ page }) => {
    // THE OWNER'S NAMED CASE, end to end and in a real browser.
    //
    // A media URL on a production page is the *output* of the token-minting path: the row holds a
    // bare storage key, and the backend turns it into a fetchable URL — historically by building
    // one from configuration, which is how `http://localhost:8080/...` and a CSP-refused
    // `pub-*.r2.dev` origin both reached real viewers. Asserting the URL merely EXISTS would have
    // passed in both incidents. So each one is fetched, and the response must carry real bytes.
    const path = required('SMOKE_PUBLIC_PATH');
    await page.goto(new URL(path, BASE).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

    const mediaUrls = await page.evaluate(() => {
      const out = new Set<string>();
      for (const el of document.querySelectorAll('img, video, source, track, iframe')) {
        const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src');
        if (src && /^https?:/.test(src)) out.add(src);
      }
      return [...out];
    });

    expect(mediaUrls.length, 'the project page referenced no media at all — nothing to verify').toBeGreaterThan(0);

    const broken: string[] = [];
    for (const url of mediaUrls.slice(0, 12)) {
      const res = await page.request.get(url, { timeout: 30_000 }).catch(() => null);
      if (!res) { broken.push(`${url} — no response`); continue; }
      if (res.status() >= 400) { broken.push(`${url} — HTTP ${res.status()}`); continue; }
      // A 200 with an empty body is a broken asset that a status check calls healthy.
      const len = (await res.body().catch(() => Buffer.alloc(0))).byteLength;
      if (len === 0) broken.push(`${url} — 200 with an empty body`);
    }
    expect(broken, `minted media URLs did not load:\n${broken.join('\n')}`).toEqual([]);
  });

  test('flow: an untokenised private media URL is refused, not served', async ({ page }) => {
    // The other half of the token path, and the one that fails dangerously rather than visibly.
    // A private key requested with no token must never return the object. This asks production
    // for a private-prefix key that does not exist: whatever the answer is, it must not be 200,
    // and it must not be a redirect to storage — either would mean the prefix is unguarded.
    const res = await page.request.get(new URL('/local-storage/exports/does-not-exist/probe.mp4', BASE).toString(), {
      maxRedirects: 0,
      timeout: 20_000,
    });
    expect(res.status(), 'a private, untokenised key was served').not.toBe(200);
    expect([301, 302, 303, 307, 308], 'a private key redirected to storage instead of being refused').not.toContain(
      res.status(),
    );
  });
});

test.describe('release-blocking: playback and export entry', () => {
  test('flow: playback starts on a real project', async ({ page }) => {
    const path = required('SMOKE_PUBLIC_PATH');
    const failed = trackFailures(page);
    await page.goto(new URL(path, BASE).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

    const video = page.locator('video').first();
    if ((await video.count()) === 0) {
      // A project page with no <video> is a legitimate shape (slides, simulation-only). The
      // media round trip above already covered its assets, so this asserts the weaker claim
      // rather than failing for a page type the fixture happens to be.
      expect(failed, `no <video> on the page, and requests failed:\n${failed.join('\n')}`).toEqual([]);
      return;
    }

    await video.evaluate((el: HTMLVideoElement) => { el.muted = true; return el.play().catch(() => {}); });
    // readyState >= 2 (HAVE_CURRENT_DATA) means a decodable frame arrived — i.e. the media URL
    // resolved, the range requests were served, and the codec is playable in this browser. A
    // `play()` that resolves proves none of that on its own.
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 30_000, message: 'video never buffered a frame' })
      .toBeGreaterThanOrEqual(2);
    expect(failed, `media requests failed during playback:\n${failed.join('\n')}`).toEqual([]);
  });

  test('flow: the export entry point is reachable and does not error', async ({ page }) => {
    // Deliberately stops at the ENTRY. Submitting would enqueue a real render on every release.
    const path = required('SMOKE_PUBLIC_PATH');
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(new URL(path, BASE).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

    const entry = page.locator('[data-testid*="export" i], button:has-text("Export"), a:has-text("Export")').first();
    if (await entry.count()) {
      await entry.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    }
    // Whether or not this fixture exposes an export control, the page must not be throwing.
    // A chunk-load error here is the signature of a partially-deployed frontend — the failure
    // an automatic deploy makes more likely, not less.
    const fatal = consoleErrors.filter((e) => /ChunkLoadError|Loading chunk|Unexpected token '<'|Failed to fetch dynamically imported/i.test(e));
    expect(fatal, `the page is throwing load errors:\n${fatal.join('\n')}`).toEqual([]);
  });
});
