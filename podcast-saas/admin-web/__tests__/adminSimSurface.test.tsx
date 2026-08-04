/**
 * AdminSimSurface — the single simulation/preview <iframe> in admin-web.
 *
 * Before Priority 4.7 the admin avatar gallery hand-rolled a raw <iframe>: the stored URL went to
 * `src` untouched, and the frame was invisible-but-focusable. Both were real failures, not tidiness:
 *   • a stored sim URL is denormalised with whatever API origin minted it, so on any OTHER
 *     environment framing it is refused by the frame-src CSP and the card renders blank;
 *   • opacity:0 removes nothing from the accessibility tree and pointer-events does not block Tab,
 *     so the invisible preview was still reachable by keyboard and by a screen reader.
 *
 * These previews are deliberately PASSIVE — no activation protocol, no reveal gate beyond `load` —
 * so nothing else in admin-web can enforce those rules on their behalf. This file is the enforcement.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resolveSimUrl reads NEXT_PUBLIC_API_URL ONCE, into a module-level const, at import time — so it
// has to be pinned before the import graph is evaluated, which is what vi.hoisted is for. Leaving
// it ambient would make the rebase assertion vacuous: if the environment's origin happened to equal
// the stored URL's origin, `expect(origin).toBe(...)` would pass with no rebase having occurred.
// A deliberately unusable origin also guarantees no test can reach the network.
const { API_ORIGIN } = vi.hoisted(() => {
  const origin = 'https://admin-under-test.invalid';
  process.env.NEXT_PUBLIC_API_URL = origin;
  return { API_ORIGIN: origin };
});

import { AdminSimSurface } from '../components/AdminSimSurface';
import { __resetDprSnapshotForTests } from 'shared/src/sim/simUrl';

/** A URL as actually stored: minted by the PRODUCTION api, now being rendered somewhere else. */
const STORED_ORIGIN = 'https://api.flowvidco.com';
const STORED_SIM_URL = `${STORED_ORIGIN}/sim-public/simulations/proj/sec/boids/index.html?v=7`;

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const el = container.querySelector('iframe');
  if (!el) throw new Error('expected an <iframe> to be rendered');
  return el;
}

/** The `#simboot=` payload the sim-public proxy's pre-paint bootstrap reads. */
function bootPayload(src: string): { hide: string[] } {
  const raw = new URL(src).hash.replace(/^#/, '');
  const part = raw.split('&').find((p) => p.startsWith('simboot='));
  if (!part) throw new Error(`no simboot fragment in ${src}`);
  return JSON.parse(decodeURIComponent(part.slice('simboot='.length)));
}

beforeEach(() => {
  __resetDprSnapshotForTests();
  // Fixed so the device-hint assertions describe a device rather than the machine running CI.
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
});
afterEach(() => {
  cleanup();
  __resetDprSnapshotForTests();
});

describe('AdminSimSurface — a hidden preview is inert, not merely transparent', () => {
  it('is inert, aria-hidden and untabbable while hidden', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible={false} title="sim" />);
    const frame = frameOf(container);

    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.style.opacity).toBe('0');
    expect(frame.style.pointerEvents).toBe('none');
  });

  it('releases inert, aria-hidden and tabIndex once visible', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible title="sim" />);
    const frame = frameOf(container);

    expect(frame.hasAttribute('inert')).toBe(false);
    expect(frame.getAttribute('aria-hidden')).toBe('false');
    expect(frame.hasAttribute('tabindex')).toBe(false);
    expect(frame.style.opacity).toBe('1');
    expect(frame.style.pointerEvents).toBe('auto');
  });

  it('keeps a visible frame pointer-inert when the caller asks for a thumbnail', () => {
    // Pointer events follow visibility, never the reverse — a visible-but-non-interactive frame is
    // still in the tab order on purpose, because it is legitimately on screen.
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible interactive={false} />);
    const frame = frameOf(container);

    expect(frame.style.pointerEvents).toBe('none');
    expect(frame.hasAttribute('inert')).toBe(false);
  });

  it('is inert while hidden for an inline srcDoc document too', () => {
    // Pinned here rather than in the page-level test because jsdom genuinely navigates a srcdoc
    // frame and fires `load` on the next macrotask, so the pre-load window is not observable once
    // a component owns its own visibility. Here `visible` is a prop, so it is.
    const { container } = render(
      <AdminSimSurface srcDoc="<b>inline</b>" visible={false} sandbox="allow-scripts" />,
    );
    const frame = frameOf(container);

    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.style.pointerEvents).toBe('none');
  });

  it('renders no frame at all without a src or a srcDoc', () => {
    const { container } = render(<AdminSimSurface visible />);
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('AdminSimSurface — the src goes through resolveSimUrl', () => {
  it('rebases a sim URL minted under another API origin onto this environment', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    const url = new URL(frameOf(container).src);

    // THE defect the migration existed to fix: the foreign origin is refused by frame-src and the
    // card renders blank. Asserted both ways so neither a missing rebase nor a rebase onto some
    // third origin can slip through.
    expect(url.origin).toBe(API_ORIGIN);
    expect(url.origin).not.toBe(STORED_ORIGIN);
    // The bucket key is what identifies the sim, so the path and query must survive untouched.
    expect(url.pathname).toBe('/sim-public/simulations/proj/sec/boids/index.html');
    expect(url.searchParams.get('v')).toBe('7');
  });

  it('leaves a URL that is not a /sim-public/ key on its own origin', () => {
    // The rebase is keyed on the path because only /sim-public/ keys are guaranteed to exist on
    // every environment's origin. Rewriting anything else would point the frame at a 404.
    const foreign = 'https://cdn.example.com/hosted/sim/index.html';
    const { container } = render(<AdminSimSurface src={foreign} visible />);
    expect(new URL(frameOf(container).src).origin).toBe('https://cdn.example.com');
  });

  it('appends the device hints the sim self-tunes on', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    const url = new URL(frameOf(container).src);
    expect(url.searchParams.get('dpr')).toBe('2');
  });

  it('emits #simboot even for an empty hide list', () => {
    // Not cosmetic: per the HTML navigation spec a src change is same-document only while the NEW
    // fragment is non-null, so dropping `#simboot=` turns a hash-only change into a full navigation
    // that hard-reloads a live sim.
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    expect(bootPayload(frameOf(container).src)).toEqual({ hide: [] });
  });

  it('carries the caller-supplied boot-hide selectors into the fragment', () => {
    const { container } = render(
      <AdminSimSurface src={STORED_SIM_URL} visible bootHide={['#hud', '.controls']} />,
    );
    expect(bootPayload(frameOf(container).src)).toEqual({ hide: ['#hud', '.controls'] });
  });

  it('resolves the URL exactly once', () => {
    // A caller that hands over an ALREADY-resolved URL (or a component that resolves twice) is not
    // harmless: the duplicated dpr/simboot changes the src string, which reloads the frame.
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    const src = frameOf(container).src;

    expect(new URL(src).searchParams.getAll('dpr')).toHaveLength(1);
    expect(src.match(/simboot=/g)).toHaveLength(1);
  });
});

describe('AdminSimSurface — sandbox tokens', () => {
  it('defaults to the shared token set', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    expect(frameOf(container).getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  });

  it('lets the caller narrow the token set', () => {
    const { container } = render(
      <AdminSimSurface src={STORED_SIM_URL} visible sandbox="allow-scripts allow-same-origin" />,
    );
    expect(frameOf(container).getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
  });

  it('renders a srcDoc document with no src and never sees it granted allow-same-origin', () => {
    // A srcDoc frame that is BOTH scripted and same-origin can remove its own sandbox attribute and
    // reload itself unsandboxed — with the embedder's origin. The inline HTML here is model- or
    // user-authored, so that combination must never be reachable.
    const { container } = render(
      <AdminSimSurface srcDoc="<b>inline</b>" visible sandbox="allow-scripts" />,
    );
    const frame = frameOf(container);

    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('srcdoc')).toBe('<b>inline</b>');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('ignores srcDoc when a src is present, so a stored sim can never fall back to inline HTML', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} srcDoc="<b>inline</b>" visible />);
    const frame = frameOf(container);
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(new URL(frame.src).origin).toBe(API_ORIGIN);
  });
});

/**
 * WHY THIS TABLE EXISTS INSTEAD OF AN IMPORT.
 *
 * client-web/lib/sim/SimSurface.tsx is the same component for the player. admin-web cannot import
 * it (no path, and pulling client-web into admin's tsconfig graph would compile client-only modules
 * such as lib/sim/protocol.ts), and the two cannot be merged into `shared` either: shared sets no
 * `jsx` flag, declares no react, and its export map is `"./src/*": "./src/*.ts"` — a .tsx cannot
 * even be resolved through it — while backend-api imports `shared` from a Node server.
 *
 * So the agreement is asserted, not assumed, in two halves that are only sound together:
 *   1. admin's RENDERED DOM matches the table below (the tests above and this one);
 *   2. client-web's SOURCE still expresses the same rules and the same constants — read off disk,
 *      because a filesystem read is the one thing that works across the package boundary.
 * Either half alone would be self-confirming; together, a change to either surface fails here.
 */
const SHARED_SURFACE_CONTRACT = {
  defaultSandbox: 'allow-scripts allow-same-origin allow-forms',
  fadeMs: 200,
  loading: 'eager',
  /** Expressions that must appear verbatim in BOTH surfaces' iframe JSX. */
  ruleExpressions: [
    'inert={!shown}',
    'aria-hidden={!shown}',
    'tabIndex={shown ? undefined : -1}',
    'opacity: shown ? 1 : 0',
    "pointerEvents: shown && interactive ? 'auto' : 'none'",
    'sandbox={sandbox ?? DEFAULT_SANDBOX}',
  ],
} as const;

function readRepoFile(relativeToThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');
}

describe('AdminSimSurface agrees with client-web SimSurface', () => {
  const adminSource = readRepoFile('../components/AdminSimSurface.tsx');
  const clientSource = readRepoFile('../../client-web/lib/sim/SimSurface.tsx');
  const clientProtocol = readRepoFile('../../client-web/lib/sim/protocol.ts');

  it('renders the contract sandbox and loading attributes', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    const frame = frameOf(container);
    expect(frame.getAttribute('sandbox')).toBe(SHARED_SURFACE_CONTRACT.defaultSandbox);
    expect(frame.getAttribute('loading')).toBe(SHARED_SURFACE_CONTRACT.loading);
  });

  it('fades over the contract duration', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible />);
    expect(frameOf(container).style.transition).toContain(`${SHARED_SURFACE_CONTRACT.fadeMs}ms`);
  });

  it('omits the transition entirely when the caller opts out of the fade', () => {
    const { container } = render(<AdminSimSurface src={STORED_SIM_URL} visible fade={false} />);
    expect(frameOf(container).style.transition).toBe('');
  });

  it("client-web's SimSurface still declares the same default sandbox", () => {
    const clientDefault = /const DEFAULT_SANDBOX = '([^']+)'/.exec(clientSource)?.[1];
    expect(clientDefault).toBe(SHARED_SURFACE_CONTRACT.defaultSandbox);
  });

  it("client-web's SIM_FADE_MS still matches admin's duplicated literal", () => {
    // admin duplicates the number because SIM_FADE_MS lives in a client-only module. This is the
    // check that turns that duplication from a drift risk into a CI failure.
    const clientFade = /export const SIM_FADE_MS = (\d+)/.exec(clientProtocol)?.[1];
    expect(Number(clientFade)).toBe(SHARED_SURFACE_CONTRACT.fadeMs);
    expect(/const ADMIN_SIM_FADE_MS = (\d+)/.exec(adminSource)?.[1]).toBe(String(SHARED_SURFACE_CONTRACT.fadeMs));
  });

  for (const expression of SHARED_SURFACE_CONTRACT.ruleExpressions) {
    it(`both surfaces express: ${expression}`, () => {
      expect(adminSource).toContain(expression);
      expect(clientSource).toContain(expression);
    });
  }

  it('both surfaces resolve the src through the one shared resolveSimUrl', () => {
    // Not two copies that agree today: literally the same module, so the rebase cannot be fixed in
    // one app and left broken in the other.
    expect(adminSource).toContain("from 'shared/src/sim/simUrl'");
    expect(readRepoFile('../../client-web/lib/simUrl.ts')).toContain("from 'shared/src/sim/simUrl'");
    expect(clientSource).toContain('resolveSimUrl(src, { hideSelectors: bootHide ?? [] })');
    expect(adminSource).toContain('resolveSimUrl(src, { hideSelectors: bootHide ?? [] })');
  });
});
