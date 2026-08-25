/**
 * The rAF gate's runtime control scanner — EXECUTED, not read.
 *
 * WHY THIS FILE EXISTS. `rafGate.test.ts` covers the same scanner with 51 assertions and every
 * one of them matches the gate's SOURCE TEXT, e.g.
 *
 *     expect(out).toContain("if (el.id) return '#' + el.id;")
 *
 * That pins the current line as if it were the specification. It cannot distinguish a selector
 * that works from one that does not, and — measured, not assumed — it would turn RED on the
 * correct fix, because `'#' + CSS.escape(el.id)` no longer contains that substring. A suite that
 * rejects the fix and accepts the defect is worse than no suite, because it reads as coverage.
 *
 * So this file runs the gate. `injectRafGate(CONTROLS_ENTRY_HTML)` is loaded into a real jsdom
 * document with `runScripts: 'dangerously'`, the gate's own inline script installs itself, and the
 * scanner is driven the way the editor drives it — by posting `listSimControls` and reading the
 * `simControlsList` that comes back. Every assertion below is on a value the code produced.
 *
 * WHAT JSDOM IS AND IS NOT AUTHORITATIVE FOR. It implements CSS selector parsing and matching
 * (via nwsapi), so `querySelectorAll` throwing on an invalid selector and matching two elements
 * for a duplicate id are faithful. It does NOT lay out: `offsetParent` is always null and
 * `getComputedStyle().position` is empty, so the scanner's visible/hidden split degrades to
 * "everything hidden". Nothing here asserts on `hidden` — that half belongs to a browser, and is
 * Phase 1's Playwright job. `CSS.escape` does not exist in jsdom at all, which is itself worth
 * knowing before anyone writes a fix that depends on it.
 *
 * HISTORY. This file was first landed DESCRIBING the defects — four tests asserting that the
 * emitted selectors were broken in exactly the measured ways — and the fix (gate v5) then flipped
 * those four expectations while every other test held still. That is the property the source-text
 * suite lacked: the same executable assertions condemned the defect and now defend the fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * MUTATION PROOF — run 2026-08-25, both directions, then reverted
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A test that claims to catch what another suite misses has to demonstrate it. `controlSelector`
 * was temporarily given the real fix — escape the id, and accept the `#id` / `[name]` branches
 * only when `querySelectorAll(...).length === 1`, otherwise fall through to the structural path:
 *
 *   OLD `rafGate.test.ts`   →  1 failed / 37 passed.  It went RED **on the correct fix**, at the
 *                              `expect(out).toContain("if (el.id) return '#' + el.id;")` line.
 *   THIS file              →  exactly the four defect-describing tests flipped, and nothing else
 *                              moved. Under the fix every emitted selector resolved to one node.
 *
 * So the source-text suite rejects the fix and accepts the defect; this one does the reverse.
 *
 * THE MEASUREMENT THAT CAME OUT OF IT, which changes the shape of the fix:
 *
 * Under the mutation the scanner emitted 17 controls, all resolving to exactly one element — but
 * `#odd:id.v2`, `#123numeric` and `#has space` were **absent from the list entirely**. A correctly
 * escaped selector contains a backslash, and `listSimControls` drops anything matching
 * `/[{}<\\]/`. The same regex guards `SimUiControls.ts`, `client-web/lib/simUiControls.ts` and
 * `SIM_BOOT_SNIPPET` — four copies, all rejecting backslash, because the string ends up inside a
 * `<style>` block and that filter is what keeps CSS injection out of it.
 *
 * So escaping alone converts a wrong selector into a missing control: still silent, still wrong.
 * That is the measured argument for ADR D9's rule that the wire carries LOCATOR IDS and never
 * free selector strings, and for `data-sim-control` being the first locator strategy — neither
 * needs the filter relaxed.
 *
 * The duplicate id, by contrast, IS fixed by the fall-through: both `#dup` elements got distinct
 * structural selectors and both resolved to one node.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { injectRafGate } from '../SimulationService.js';
import { CONTROLS_ENTRY_HTML } from '../../../scripts/fixtures/controlsFixture.js';

interface ScannedControl {
  selector: string;
  kind: string;
  label: string;
  hidden?: boolean;
}

let dom: JSDOM;
let win: Window & typeof globalThis;
let doc: Document;
let scanned: ScannedControl[];
/**
 * Every uncaught error thrown by the gate or the fixture while the document booted.
 *
 * This is not decoration. jsdom swallows a script error by default, and a fixture that dies
 * halfway through still produces a document, still answers the scan, and still lets most of the
 * assertions below pass — against a page where half the listeners were never attached. That
 * happened on the first run of this file: a `ReferenceError` in the fixture's own IIFE aborted it
 * silently, and the only signal was that two expectations disagreed. The harness has to be able to
 * SEE its own failure, so the errors are captured and asserted on.
 */
let scriptErrors: string[];

/**
 * Drive the scanner exactly as the editor does, and wait for the reply it posts.
 *
 * `Window & typeof globalThis` rather than `Window`: the constructors (`MessageEvent`, `Event`)
 * live on the global scope, not on the `Window` interface, and this must construct events INSIDE
 * the jsdom realm — an event built from the test's own realm would fail the gate's identity checks
 * for a reason that has nothing to do with the code under test.
 */
function runScan(w: Window & typeof globalThis): Promise<ScannedControl[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listSimControls never answered')), 4000);
    w.addEventListener('message', function onMsg(e: MessageEvent) {
      const d = (e as MessageEvent).data as { type?: string; controls?: ScannedControl[] };
      if (!d || d.type !== 'simControlsList') return;
      clearTimeout(timer);
      w.removeEventListener('message', onMsg as EventListener);
      resolve(d.controls ?? []);
    } as EventListener);
    // The gate refuses anything whose source is not window.parent. On a top-level jsdom window
    // `window.parent === window`, so this satisfies the real guard rather than removing it.
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'listSimControls' }, source: w }));
  });
}

beforeAll(async () => {
  scriptErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => scriptErrors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...args: unknown[]) => scriptErrors.push(`error: ${args.join(' ')}`));

  dom = new JSDOM(injectRafGate(CONTROLS_ENTRY_HTML), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,        // the gate wraps requestAnimationFrame
    url: 'https://example.test/sim/index.html?section=base',
    virtualConsole: vc,
  });
  win = dom.window as unknown as Window & typeof globalThis;
  doc = win.document;
  scanned = await runScan(win);
});

// ── The harness itself has to be real, or everything below is decoration ──────

describe('harness', () => {
  it('neither the gate nor the fixture threw while booting', () => {
    // Without this, a fixture that dies halfway still lets most of this file pass.
    //
    // ONE known environment limitation is filtered, by its exact text: jsdom does not implement
    // HTMLCanvasElement.getContext unless the optional `canvas` package is installed. That is a
    // statement about the harness, not about the code under test, and the fixture already guards
    // the null it returns. It is matched narrowly on purpose — a ReferenceError, a TypeError, or
    // any other unimplemented API still fails this test.
    const unexpected = scriptErrors.filter((e) => !e.includes('HTMLCanvasElement.prototype.getContext'));
    expect(unexpected).toEqual([]);
  });

  it('the gate actually installed itself in the document', () => {
    // If this is false the scanner never ran and every assertion below is vacuous.
    expect((win as unknown as { __SIM_RAF_GATE__?: { version: number } }).__SIM_RAF_GATE__)
      .toBeTruthy();
    expect((win as unknown as { __SIM_RAF_GATE__: { version: number } }).__SIM_RAF_GATE__.version)
      .toBe(5);
  });

  it('the fixture document installed its own control state', () => {
    expect((win as unknown as { __CONTROL_STATE__?: Record<string, unknown> }).__CONTROL_STATE__)
      .toBeTruthy();
  });

  it('the scanner returned controls', () => {
    expect(scanned.length).toBeGreaterThan(5);
    for (const c of scanned) {
      expect(typeof c.selector).toBe('string');
      expect(c.selector.length).toBeGreaterThan(0);
    }
  });
});

// ── ADR D6: a locator must resolve to exactly one element ────────────────────
//
// The scanner GENERATES a selector and never resolves it — `listSimControls` only filters
// /[{}<\\]/ and length. So nothing downstream can fail loudly: the string ends up inside a CSS
// rule (`__simBootHide` / `__simHideUi`), and CSS drops what it cannot parse, silently, by design.
// These tests resolve every emitted selector, which is the check the pipeline does not do.

describe('emitted selectors, resolved (ADR D6)', () => {
  const resolve = (sel: string): { count: number; threw: boolean } => {
    try {
      return { count: doc.querySelectorAll(sel).length, threw: false };
    } catch {
      return { count: 0, threw: true };
    }
  };

  it('FIXED (gate v5): a CSS-special id falls through to a structural path that resolves', () => {
    // These ids are legal HTML and unparseable raw CSS. The v4 gate emitted them verbatim —
    // '#odd:id.v2' threw, '#123numeric' threw, '#has space' matched NOTHING silently. Escaping
    // was measured to be a dead end (the /[{}<\\]/ filters at seven sites drop backslashes), so
    // the fix is the fall-through: an id that is not provably clean AND unique never becomes a
    // selector at all, and the control arrives on a child-combinator structural path instead.
    for (const probe of ['oddId', 'numericId', 'spaceId']) {
      const c = scanned.find((x) => doc.querySelector(x.selector) ===
        doc.querySelector('[data-probe="' + probe + '"]') && resolve(x.selector).count === 1);
      expect(c, probe + ' must be offered via a resolvable selector').toBeTruthy();
      expect(c!.selector).toContain(':nth-of-type(');
      expect(c!.selector).not.toContain('\\');
    }
  });

  it('FIXED (gate v5): duplicate ids get DISTINCT structural selectors — both controls are offered', () => {
    // The v4 gate emitted '#dup' for both elements: the selector matched two nodes and the
    // dedupe-by-string then dropped one control from the list entirely.
    expect(scanned.some((c) => c.selector === '#dup')).toBe(false);
    const dups = ['dupFirst', 'dupSecond'].map((probe) =>
      scanned.find((x) => resolve(x.selector).count === 1 && doc.querySelector(x.selector) ===
        doc.querySelector('[data-probe="' + probe + '"]')));
    expect(dups[0], 'first #dup control offered').toBeTruthy();
    expect(dups[1], 'second #dup control offered').toBeTruthy();
    expect(dups[0]!.selector).not.toBe(dups[1]!.selector);
  });

  it('FIXED (gate v5): a shared name is never a selector — each group member resolves alone', () => {
    // '[name="mode"]' matches the whole radio group and '[name="flags"]' both checkboxes. The
    // name branch now demands a proven-unique match, so a group can only arrive as per-element
    // selectors (here via their ids; for id-less radios, via structural paths).
    expect(scanned.some((c) => c.selector === '[name="mode"]')).toBe(false);
    expect(scanned.some((c) => c.selector === '[name="flags"]')).toBe(false);
    for (const probe of ['modeA', 'modeB', 'modeC', 'chkA', 'chkB']) {
      const c = scanned.find((x) => resolve(x.selector).count === 1 && doc.querySelector(x.selector) ===
        doc.querySelector('[data-probe="' + probe + '"]'));
      expect(c, probe + ' must be individually addressable').toBeTruthy();
    }
  });

  it('FIXED (gate v5): a structural anchor is never a dirty or duplicate ancestor id', () => {
    // The anchor used to be '#' + parent.id for ANY ancestor id — the same defect, one level up:
    // a duplicate or unparseable ancestor id would poison every path anchored on it. The anchor
    // is now gated by the same clean+unique proof, so no emitted selector may embed one.
    for (const c of scanned) {
      expect(c.selector, c.selector + ' embeds an unparseable fragment').not.toMatch(/#[0-9]/);
      expect(resolve(c.selector).threw, c.selector + ' must parse').toBe(false);
    }
  });

  it('the structural nth-of-type branch IS single-match, as its comment claims', () => {
    // Verified 2026-08-25: the uniqueness hole is the #id and [name] branches that run BEFORE
    // this one, not the structural path. Any emitted structural selector must resolve to one.
    const structural = scanned.filter((c) => c.selector.includes(':nth-of-type('));
    for (const c of structural) {
      expect(resolve(c.selector).threw, `${c.selector} must parse`).toBe(false);
      expect(resolve(c.selector).count, `${c.selector} must match exactly one`).toBe(1);
    }
  });

  it('THE INVARIANT: every emitted selector resolves to exactly one element', () => {
    // The assertion the whole action-recording feature depends on, flipped from its defect form
    // on 2026-08-25 when gate v5 landed. Stated as a count so a failure names the offenders.
    const broken = scanned.filter((c) => resolve(c.selector).count !== 1);
    expect(broken.map((c) => c.selector), 'unresolvable/ambiguous selectors').toEqual([]);
    expect(broken.length).toBe(0);
  });
});

// ── ADR D5: a synthetic click is untrusted, so generic click cannot be replayed ──

describe('synthetic events (ADR D5)', () => {
  it('a dispatched click does not run a handler gated on isTrusted', () => {
    const btn = doc.getElementById('needs-gesture') as HTMLButtonElement;
    const state = (win as unknown as { __CONTROL_STATE__: Record<string, unknown> }).__CONTROL_STATE__;
    const diag = (win as unknown as { __DIAGNOSTIC__: string[] }).__DIAGNOSTIC__;
    const before = diag.length;

    btn.click();
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    // The handler ran and refused, twice. Nothing observable changed.
    expect(diag.slice(before)).toEqual(['untrusted-click', 'untrusted-click']);
    expect(state.gesture).toBeUndefined();
  });
});

// ── ADR D2: writing a control's value back does not rewind internal state ──────

describe('reset semantics (ADR D2)', () => {
  it('restoring a slider to its baseline does NOT restore accumulated state', () => {
    const speed = doc.getElementById('speed') as HTMLInputElement;
    const physics = () => (win as unknown as { __PHYSICS__: number }).__PHYSICS__;
    const baseline = speed.value;
    expect(physics()).toBe(0);

    for (const v of ['40', '60', '80']) {
      speed.value = v;
      speed.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    const accumulated = physics();
    expect(accumulated).toBeGreaterThan(0);

    // Put the control back exactly where it started.
    speed.value = baseline;
    speed.dispatchEvent(new win.Event('input', { bubbles: true }));
    expect(speed.value).toBe(baseline);

    // The DOM is restored. The simulation is not. This is why reload-document is the default
    // reset and why in-place restore requires an adapter that proves a baseline digest.
    expect(physics()).toBeGreaterThan(accumulated);
  });
});

// ── The React controlled-input trap ───────────────────────────────────────────

describe('React-controlled inputs', () => {
  it('a naive value write is SWALLOWED and reverts', () => {
    const el = doc.getElementById('react-temp') as HTMLInputElement;
    const state = (win as unknown as { __CONTROL_STATE__: Record<string, unknown> }).__CONTROL_STATE__;
    expect(el.value).toBe('10');

    // What an executor written without knowing about React does.
    el.value = '42';
    el.dispatchEvent(new win.Event('input', { bubbles: true }));

    expect(el.value, 'the tracker agreed, so the change was treated as a no-op').toBe('10');
    expect(state['reactTemp:swallowed']).toBe(1);
    expect(state.reactTemp).toBe('10');
  });

  it('writing through the PROTOTYPE setter leaves the tracker stale, and the change sticks', () => {
    const el = doc.getElementById('react-temp') as HTMLInputElement;
    const state = (win as unknown as { __CONTROL_STATE__: Record<string, unknown> }).__CONTROL_STATE__;
    const proto = Object.getPrototypeOf(el) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;

    setter.call(el, '37');
    el.dispatchEvent(new win.Event('input', { bubbles: true }));

    expect(el.value).toBe('37');
    expect(state.reactTemp).toBe('37');
  });
});

// ── A fact worth pinning, because a fix will depend on it ─────────────────────

describe('environment', () => {
  it('CSS.escape does not exist in jsdom — a fix using it needs a browser or a polyfill', () => {
    expect((win as unknown as { CSS?: { escape?: unknown } }).CSS?.escape).toBeUndefined();
  });
});
