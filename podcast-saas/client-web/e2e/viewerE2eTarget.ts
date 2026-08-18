/**
 * WHERE the viewer e2e suite is allowed to point, and WHO starts the app it points at.
 *
 * This is deliberately a separate, playwright-free module rather than logic inside
 * `playwright.viewer.config.ts`, for one reason: a rule that decides whether a browser suite may
 * touch production must itself be unit-tested, and a Playwright config cannot be imported by vitest
 * without dragging the test runner in.
 *
 * THE RULE: loopback, or refuse to run.
 *
 * Every OTHER Playwright config in this package (`playwright.config.ts`,
 * `playwright.production.config.ts`) defaults its baseURL to `https://flowvidco.com`, because they
 * exist to probe the deployed site. This suite is the opposite kind of thing — it plays media,
 * seeks the timeline, mounts pooled sim iframes and asserts on live DOM — so the single most
 * damaging mistake available is aiming it at production. `VIEWER_E2E_BASE_URL` is therefore not a
 * free-form knob: a non-loopback value is a hard startup error, not a warning and not a fallback,
 * so the mistake cannot be made quietly in a workflow file.
 */

/**
 * The default target: loopback, on a port that is NOT the developer's 3000.
 *
 * 3100 rather than 3000 is a deliberate choice about blast radius. When this config starts a server
 * itself, using 3000 would fight a dev server the developer already has running — and the audited
 * failure this file's sibling config documents is precisely that a second Next server corrupts the
 * `.next` directory of the first. A developer who wants the suite to use their existing dev server
 * still can, by naming it explicitly.
 */
export const DEFAULT_VIEWER_E2E_BASE_URL = 'http://localhost:3100';

/**
 * The environment, structurally.
 *
 * Deliberately NOT the global `ProcessEnv` interface: client-web's tsconfig pulls in Next's
 * augmentation of it, which makes `NODE_ENV` a REQUIRED property — so every caller passing a
 * focused `{ VIEWER_E2E_BASE_URL }` (which is how these rules are tested) fails to typecheck.
 * The functions here read two variables; this is the honest shape of what they need.
 */
export type ViewerE2eEnv = Readonly<Record<string, string | undefined>>;

/** Hostnames that mean "this machine, not the internet". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Resolve the suite's base URL, refusing anything that is not loopback.
 *
 * Throws — rather than falling back to the default — on a value that is set but unusable. A
 * malformed or non-loopback override is an operator mistake, and silently substituting something
 * else would run a real browser suite against a target nobody chose.
 */
export function resolveViewerE2eTarget(env: ViewerE2eEnv = process.env): string {
  const raw = env.VIEWER_E2E_BASE_URL?.trim();
  if (!raw) return DEFAULT_VIEWER_E2E_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `VIEWER_E2E_BASE_URL is not a URL: ${JSON.stringify(raw)}. ` +
      `It must be a loopback origin such as ${DEFAULT_VIEWER_E2E_BASE_URL}.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(url.host.replace(/:\d+$/, ''))) {
    throw new Error(
      `VIEWER_E2E_BASE_URL must be a loopback origin, got ${JSON.stringify(raw)}. ` +
      'The viewer e2e suite drives a real browser through a real app — it must never run against ' +
      'the deployed site. Use the production audit suite (playwright.production.config.ts) for that.',
    );
  }
  // Normalise away a trailing slash so `${BASE}/projects/...` never doubles it.
  return url.origin;
}

/** The port the suite's app listens on, derived from the (already validated) target. */
export function viewerE2ePort(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Should the config start the application itself?
 *
 * OFF unless explicitly opted in — including under `CI=true`. The sibling config documents the
 * audited reason a `webServer` is not unconditional: building or starting a second Next server
 * clobbers the `.next` directory of a dev server the developer is already running. An opt-in that
 * CI sets, rather than an auto-detect, keeps the local default byte-identical to what it was while
 * still letting a runner bring its own app up.
 */
export function shouldStartViewerE2eServer(env: ViewerE2eEnv = process.env): boolean {
  const v = env.VIEWER_E2E_START_SERVER?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * The environment the suite's own `next dev` needs in order to BOOT.
 *
 * Without this the job fails in the least informative way available: `lib/firebase.ts` calls
 * `initializeApp`/`getAuth` in a client component that Next renders on the server, and an
 * undefined `NEXT_PUBLIC_FIREBASE_API_KEY` makes that throw during SSR — so EVERY route returns
 * 500, Playwright's webServer waits out its full timeout on a page that will never be ready, and
 * the log says "Timed out waiting for the server" rather than "the app has no Firebase config".
 *
 * Placeholders are correct here, not a shortcut. The suite stubs `identitytoolkit`,
 * `securetoken`, `apis.google.com` and `www.googleapis.com` at the browser, and its error filter
 * explicitly tolerates `auth/invalid-api-key` — so no real credential is ever used, and supplying
 * one would only make the run less hermetic. `.env.example` ships the same placeholder shape.
 *
 * A developer who has real values in their environment keeps them: every key falls through to the
 * ambient value first, so this only ever fills in what is missing.
 */
export function viewerE2eServerEnv(env: ViewerE2eEnv = process.env): Record<string, string> {
  const placeholders: Record<string, string> = {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'e2e-placeholder',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'e2e.firebaseapp.com',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'e2e',
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'e2e.appspot.com',
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '0',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:0:web:e2e',
  };
  const out: Record<string, string> = { NEXT_TELEMETRY_DISABLED: '1' };
  for (const [k, fallback] of Object.entries(placeholders)) {
    out[k] = env[k]?.trim() || fallback;
  }
  return out;
}
