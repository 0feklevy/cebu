/**
 * Re-keying a combined `bridge.js` onto different section ids.
 *
 * The end-to-end proof lives in `projectDuplication.test.ts` (a copied package must dispatch on the
 * COPY's section ids or every simulation section answers `SCRIPT_MISSING`). This file pins the
 * transform itself, and in particular the three things a regex over generated source can get wrong:
 * renaming the marker but not the object key the RUNTIME reads, touching bytes that are not ids, and
 * mistaking a package with no section map for one it may rewrite.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { parseSectionEntries, rewriteBridgeSectionIds, wrapBridgeCombined } from '../SimulationService.js';

const A = 'sec-aaaa-0001';
const B = 'sec-bbbb-0002';
const A2 = 'copy-aaaa-1111';
const B2 = 'copy-bbbb-2222';

const bodyOf = (tag: string): string => `var g = window.__ran || (window.__ran = []);\ng.push('${tag}');\nreturn null;`;
const BRIDGE = wrapBridgeCombined(new Map([[A, bodyOf('alpha')], [B, bodyOf('beta')]]));

describe('rewriteBridgeSectionIds', () => {
  it('moves the marker AND the dispatch key together', () => {
    const out = rewriteBridgeSectionIds(BRIDGE, new Map([[A, A2], [B, B2]]));

    expect(out.sections).toBe(2);
    expect(out.renamed).toEqual(new Map([[A, A2], [B, B2]]));
    // The parser reads the MARKERS…
    expect([...parseSectionEntries(out.source).keys()].sort()).toEqual([A2, B2].sort());
    // …and the runtime reads the OBJECT KEY. Renaming only one of them produces a document where
    // the two disagree, which no parse-level assertion would catch.
    expect(out.source).toContain(`'${A2}': function (params) {`);
    expect(out.source).toContain(`'${B2}': function (params) {`);
    expect(out.source).not.toContain(`'${A}':`);
    expect(out.source).not.toContain(A);
    expect(out.source).not.toContain(B);
  });

  it('produces a bridge that really dispatches the renamed section', () => {
    // The claim is about behaviour, so it is checked by running the bytes.
    const out = rewriteBridgeSectionIds(BRIDGE, new Map([[A, A2], [B, B2]]));
    const ran = runSection(out.source, B2);
    expect(ran).toEqual(['beta']);
    // And the OLD id now resolves to nothing — which is exactly what a copy must NOT be asked for.
    expect(runSection(out.source, B)).toEqual([]);
  });

  it('changes nothing but the ids', () => {
    const out = rewriteBridgeSectionIds(BRIDGE, new Map([[A, A2], [B, B2]]));
    expect(out.source.split(A2).join(A).split(B2).join(B)).toBe(BRIDGE);
  });

  it('renames only what the map names, and is a no-op for an identity mapping', () => {
    const partial = rewriteBridgeSectionIds(BRIDGE, new Map([[A, A2]]));
    expect([...parseSectionEntries(partial.source).keys()].sort()).toEqual([A2, B].sort());

    const same = rewriteBridgeSectionIds(BRIDGE, new Map([[A, A], [B, B]]));
    expect(same.source).toBe(BRIDGE);
    expect(same.renamed.size).toBe(0);
    expect(same.sections).toBe(2);
  });

  it('reports zero sections for a bridge with no marker map, and leaves it alone', () => {
    // A legacy or hand-written package. There is nothing to re-key, and inventing a map would be
    // worse than the defect — so the caller is told, and the bytes are untouched.
    const raw = ';(function(){ window.SimAPI = { start: function(){}, stop: function(){} }; })();';
    const out = rewriteBridgeSectionIds(raw, new Map([[A, A2]]));
    expect(out.sections).toBe(0);
    expect(out.renamed.size).toBe(0);
    expect(out.source).toBe(raw);
  });

  it('refuses a marked entry whose dispatch key is not where the marker says', () => {
    // Half a rename is worse than none: the parser and the runtime would name different sections.
    const broken = BRIDGE.replace(`'${A}': function (params) {`, "'somethingElse': function (params) {");
    expect(() => rewriteBridgeSectionIds(broken, new Map([[A, A2]])))
      .toThrow(/dispatch key is not at the head of its block/);
  });

  it('refuses to write an id that is not safe as a JS object key', () => {
    expect(() => rewriteBridgeSectionIds(BRIDGE, new Map([[A, "x', evil: function(){}, y: '"]])))
      .toThrow(/Unsafe sectionId/);
  });
});

/** Load a bridge in a VM and start one section; returns what the bodies recorded. */
function runSection(source: string, section: string): string[] {
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const ctx: Record<string, unknown> = {
    console, Object, JSON, String, Math, Date, Array, URLSearchParams,
    document: {
      readyState: 'complete', head: { appendChild(): void { /* no-op */ } }, documentElement: {},
      getElementById: (): null => null,
      createElement: (): Record<string, unknown> => ({ remove(): void { /* no-op */ } }),
      addEventListener(): void { /* no-op */ },
    },
    location: { search: '', href: 'https://sim.test/index.html' },
    parent: { postMessage: (): void => { /* the posts are not what this file asserts */ } },
    setTimeout: (): number => 1,
    setInterval: (): number => 2,
    clearTimeout: (): void => { /* no-op */ },
    clearInterval: (): void => { /* no-op */ },
    requestAnimationFrame: (cb: (t: number) => void): number => { cb(0); return 3; },
    cancelAnimationFrame: (): void => { /* no-op */ },
    addEventListener(type: string, fn: (e: { data: unknown }) => void) { if (type === 'message') listeners.push(fn); },
    removeEventListener() { /* no-op */ },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx as vm.Context, { filename: 'bridge.js' });
  for (const l of [...listeners]) l({ data: { type: 'startScript', script: section, params: {}, token: 1 } });
  return (ctx.__ran as string[] | undefined) ?? [];
}
