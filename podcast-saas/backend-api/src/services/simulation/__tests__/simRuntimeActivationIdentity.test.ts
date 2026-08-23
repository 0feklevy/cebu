/**
 * simulation-009 — a superseded section's outcome must not be stamped with the LIVE section's
 * identity.
 *
 * ── The defect ────────────────────────────────────────────────────────────────────────────────
 * `runMaybeAsync`'s rejection handler read the module-level mutable `current` when the promise
 * SETTLED, not the activation captured when it was CALLED. So:
 *
 *   section A has an async prepare()  →  the viewer scrubs to B  →  releaseCurrent('superseded')
 *   aborts A's signal and sets current = {B}  →  A's prepare rejects on the abort  →  the child
 *   posts SECTION_ERROR carrying **B's** activationId  →  the parent's matchesActivation passes
 *   →  a healthy section B is killed for a dead section A's error.
 *
 * The async SUCCESS path had it too: finish() posted SECTION_APPLIED against current.
 *
 * ── Why this harness exists ───────────────────────────────────────────────────────────────────
 * The child runtime ships as a SOURCE STRING embedded into every generated bridge.js — there is no
 * bundler between it and the browser — so nothing in this repo had ever executed it. Asserting on
 * the source text would be theatre: it would pin the characters, not the behaviour, and this
 * repository has already paid for that lesson once.
 *
 * So this evaluates the REAL emitted source against a stub window, fakes the bootstrap to hand it a
 * port, and drives the actual activation lifecycle. The assertions are on what the child POSTS.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildChildRuntimeSource } from '../simRuntimeChild.js';
import { SIM_PROTOCOL_NAMESPACE, SIM_PROTOCOL_VERSION } from 'shared/sim/runtimeProtocol';

interface Posted { type: string; activationId?: string; payload: Record<string, unknown> }

/** A deferred whose settlement this test controls — the async prepare() of a section. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Minimal stand-ins for everything the runtime touches on window/document. */
function makeWindow() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const el = () => ({
    id: '', textContent: '', style: {},
    appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
  });
  const parent = { postMessage() {} };
  const win: Record<string, unknown> = {
    parent,
    AbortController,
    URL,
    performance: { now: () => 0 },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
    fetch: async () => ({ ok: true }),
    addEventListener(type: string, fn: (e: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    document: {
      getElementById: () => null,
      createElement: el,
      getElementsByTagName: () => [],
      getAnimations: () => [],
      head: el(),
      documentElement: el(),
      addEventListener() {}, removeEventListener() {},
    },
  };
  return { win, parent, fire: (type: string, e: unknown) => (listeners[type] ?? []).forEach((f) => f(e)) };
}

const IDENT = {
  playerSessionId: 'sess-1',
  packageRevision: 'rev-1',
  documentId: 'doc-1',
};

/** Boot the real runtime with the given section bodies and return a driver. */
function boot(sections: Record<string, unknown>) {
  const { win, parent, fire } = makeWindow();
  const posted: Posted[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    start() {},
    close() {},
    postMessage(msg: Record<string, unknown>) {
      if (typeof msg.type === 'string') {
        posted.push({
          type: msg.type,
          activationId: msg.activationId as string | undefined,
          payload: (msg.payload ?? {}) as Record<string, unknown>,
        });
      }
    },
  };

  // The emitted source ends by calling __simInstallV3(window, __SECTIONS__, {...}); the real bridge
  // substitutes the sections. Evaluate it with the same substitution and hand back the handle.
  const source = buildChildRuntimeSource({ allManaged: true, anyQuality: false })
    .replace('__SECTIONS__', '__TEST_SECTIONS__')
    .replace('var __simV3 =', 'return');

   
  const install = new Function('window', '__TEST_SECTIONS__', source) as
    (w: unknown, s: unknown) => { onEnvelope: (raw: unknown) => void; isAdopted: () => boolean };
  const handle = install(win, sections);

  // Fake the parent's bootstrap offer so the child adopts our port.
  fire('message', {
    source: parent,
    origin: 'https://parent.example',
    data: { kind: 'flowvid.sim.bootstrap', protocolVersion: SIM_PROTOCOL_VERSION, parentOrigin: 'https://parent.example', ...IDENT },
    ports: [port],
  });

  let seq = 0;
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    handle.onEnvelope({
      namespace: SIM_PROTOCOL_NAMESPACE,
      protocolVersion: SIM_PROTOCOL_VERSION,
      type,
      ...IDENT,
      seq: ++seq,
      payload: {},
      ...extra,
    });
  };

  return { handle, posted, send, adopted: handle.isAdopted() };
}

const activation = (id: string, payload: Record<string, unknown> = {}) => ({
  activationId: id, variantKey: 'v-' + id, configHash: 'h-' + id, payload: { config: {}, ...payload },
});

describe('the child runtime adopts a port and answers', () => {
  it('boots and accepts the bootstrap offer — the harness itself is real', () => {
    const { adopted } = boot({});
    expect(adopted).toBe(true);
  });
});

describe('simulation-009 — a superseded activation cannot speak for the live one', () => {
  let aPrepare: ReturnType<typeof deferred>;

  beforeEach(() => { aPrepare = deferred(); });

  /** Section A's prepare() never settles on its own — the test decides when and how. */
  const sections = () => ({
    'v-A': () => ({ __managed: true, prepare: () => aPrepare.promise, present() {}, release() {} }),
    'v-B': () => ({ __managed: true, prepare: () => Promise.resolve(), present() {}, release() {} }),
  });

  it('does NOT report a superseded section\'s FAILURE against the live section', async () => {
    const { posted, send } = boot(sections());
    send('INIT_DOCUMENT');
    send('PREPARE_SECTION', activation('A'));      // A's prepare() is now pending
    send('PREPARE_SECTION', activation('B'));      // scrub: releases A, current = B

    aPrepare.reject(new Error('aborted'));         // A's prepare rejects, late
    await new Promise((r) => setTimeout(r, 0));

    const errors = posted.filter((p) => p.type === 'SECTION_ERROR');

    // THE BUG: this used to be one SECTION_ERROR carrying B's activationId, which the parent's
    // matchesActivation accepted — killing a healthy B for A's failure.
    expect(errors.filter((e) => e.activationId === 'B')).toEqual([]);

    // AND NOTHING IS SENT AT ALL. Capturing the activation is enough to stop B being killed — an
    // envelope stamped with A's id would simply be rejected by the parent — but the runtime goes
    // further and DROPS a superseded activation's outcome, because nothing is displaying it any
    // more and its failure is moot. That is what markPresented does, and a mutation check showed
    // this assertion is the only thing pinning it: without this line, removing the identity
    // re-check passes.
    expect(errors, 'a superseded activation must post nothing, not merely post harmlessly').toEqual([]);
  });

  it('does NOT acknowledge a superseded section\'s SUCCESS against the live section', async () => {
    const { posted, send } = boot(sections());
    send('INIT_DOCUMENT');
    send('PREPARE_SECTION', activation('A'));
    send('PREPARE_SECTION', activation('B'));

    aPrepare.resolve();                            // A's prepare resolves, late
    await new Promise((r) => setTimeout(r, 0));

    const appliedForB = posted.filter((p) => p.type === 'SECTION_APPLIED' && p.activationId === 'B');
    // B's own prepare resolves too, so B may legitimately have exactly one APPLIED — never two,
    // and never one minted by A finishing.
    expect(appliedForB.length).toBeLessThanOrEqual(1);
    for (const ack of appliedForB) {
      expect(ack.payload.variantKey, 'an ack for B must describe B').toBe('v-B');
    }
  });

  it('still reports a failure for the section that is STILL current', async () => {
    // The guard must not silence real errors — only misattributed ones.
    const { posted, send } = boot(sections());
    send('INIT_DOCUMENT');
    send('PREPARE_SECTION', activation('A'));

    aPrepare.reject(new Error('genuinely broken'));
    await new Promise((r) => setTimeout(r, 0));

    const errors = posted.filter((p) => p.type === 'SECTION_ERROR' && p.activationId === 'A');
    expect(errors.length).toBe(1);
    expect(String(errors[0]!.payload.message)).toContain('genuinely broken');
  });

  it('still acknowledges a section that is STILL current', async () => {
    const { posted, send } = boot(sections());
    send('INIT_DOCUMENT');
    send('PREPARE_SECTION', activation('A'));

    aPrepare.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const applied = posted.filter((p) => p.type === 'SECTION_APPLIED' && p.activationId === 'A');
    expect(applied.length).toBe(1);
    expect(applied[0]!.payload.variantKey).toBe('v-A');
  });
});
