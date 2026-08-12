/**
 * The editor mounts the LIVE simulation bytes, and still writes back the stored ones (audit §9.6).
 *
 * `simulation_served_url` is the active-revision pointer resolved on the way out; it rides only on
 * the two editor bootstrap reads. `simulation_url` stays the stored value everywhere, because that
 * is the column the editor echoes back on undo/redo restore and on duplicate — resolving it in
 * place would let a GET→PATCH round-trip persist a revision id captured at read time.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  rememberServedSimUrls, servedSimulationUrl, withRepublishedServedUrls,
} from '../lib/simServedUrl';
import { packageKeyOf, simDocumentSwitch } from '../lib/simPool';

// NOT `new URL(<literal>, import.meta.url)`: Vite rewrites that exact form into a bundled asset
// reference, and the result is an http: URL that readFileSync refuses.
const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const ORIGIN = 'https://cdn';
const PREFIX = `${ORIGIN}/sim-public/sims/s1`;
const STORED = `${PREFIX}/revisions/OLD/package/index.html?section=sec-1&v=H1`;
const SERVED = `${PREFIX}/revisions/NEW/package/index.html?section=sec-1&v=H1`;

const section = (over: Partial<Parameters<typeof servedSimulationUrl>[0]> = {}) => ({
  id: 'sec-1', simulation_url: STORED, simulation_served_url: SERVED, ...over,
});

describe('a row that carries its own served url', () => {
  it('mounts the served url, not the retired one it stores', () => {
    expect(servedSimulationUrl(section(), new Map())).toBe(SERVED);
  });

  it('mounts the stored url when the pointer resolved to it (legacy simulation)', () => {
    expect(servedSimulationUrl(section({ simulation_served_url: STORED }), new Map())).toBe(STORED);
  });

  it('mounts nothing for a section with no simulation', () => {
    expect(servedSimulationUrl({ id: 'x', simulation_url: null, simulation_served_url: null }, new Map()))
      .toBeNull();
  });
});

describe('a row that came back from a create/update response', () => {
  // Those responses are the stored row — they must be, since the server stores exactly what the
  // client sends — so the resolution has to survive the merge or dragging a section would drop its
  // preview back onto the retired revision.
  const remembered = rememberServedSimUrls([section()]);
  const patched = { id: 'sec-1', simulation_url: STORED };

  it('keeps mounting the live bytes after a PATCH merge', () => {
    expect(servedSimulationUrl(patched, remembered)).toBe(SERVED);
  });

  it('forgets the memory once the section REPUBLISHES to a new stored url', () => {
    // A generation writes the revision it just activated into `simulation_url`, so the stored value
    // is now the freshest one there is. Pinning the preview to the remembered revision would show
    // the user the package they just replaced.
    const regenerated = { id: 'sec-1', simulation_url: 'https://cdn/sim-public/sims/s1/revisions/NEWEST/package/index.html?section=sec-1&v=H2' };
    expect(servedSimulationUrl(regenerated, remembered)).toBe(regenerated.simulation_url);
  });

  it('falls back to the stored url for a section the memory never saw', () => {
    const duplicated = { id: 'sec-9', simulation_url: STORED };
    expect(servedSimulationUrl(duplicated, remembered)).toBe(STORED);
  });
});

describe('rememberServedSimUrls', () => {
  it('remembers only sections whose served url actually differs', () => {
    const map = rememberServedSimUrls([
      section({ id: 'differs' }),
      section({ id: 'same', simulation_served_url: STORED }),
      { id: 'legacy', simulation_url: STORED, simulation_served_url: null },
      { id: 'none', simulation_url: null, simulation_served_url: null },
    ]);
    expect([...map.keys()]).toEqual(['differs']);
  });
});

/**
 * AN IN-SESSION REPUBLISH MOVES THE WHOLE PACKAGE — the siblings included.
 *
 * `simulation_served_url` is resolved per response, and a generation only produces a response for
 * the section it regenerated. Its siblings keep the revision they were handed at editor bootstrap,
 * so the editor ends up asking for two different revision documents for one simulation.
 *
 * NOTHING 404s: a retired revision stays in storage (`RevisionService.gc()` has no production
 * caller), so the sibling still mounts perfectly well. What is lost is RESIDENCY — `packageKeyOf`
 * is origin+path, so the two revisions are two different packages, and every hop between siblings
 * becomes a full document boot behind the spinner instead of the single postMessage a same-package
 * hop costs. That is the entire point of the stage this memory belongs to, and it stopped applying
 * to exactly the sections an author revisits most, until the next PATCH or a page reload.
 */
describe('a republish that lands while the editor is open', () => {
  const REV1 = `${PREFIX}/revisions/rev-1/package/index.html`;
  const REV2 = `${PREFIX}/revisions/rev-2/package/index.html`;
  const row = (id: string, served: string | null, stored = `${REV1}?section=${id}&v=h`) => ({
    id, simulation_id: 'sim-1', simulation_url: stored, simulation_served_url: served,
  });

  /** A and B are two sections of ONE package, both resolved to rev-1 at bootstrap. */
  const bootstrap = () => [
    row('sec-a', `${REV1}?section=sec-a&v=h`),
    row('sec-b', `${REV1}?section=sec-b&v=h`),
  ];
  /** …and the author regenerates A, which publishes rev-2 and moves the pointer. */
  const afterRegenerateA = () => [
    { ...row('sec-a', `${REV2}?section=sec-a&v=h`), simulation_url: `${REV2}?section=sec-a&v=h` },
    row('sec-b', `${REV1}?section=sec-b&v=h`),
  ];

  it('carries the new revision onto the sibling, keeping its OWN section query', () => {
    const [, b] = withRepublishedServedUrls(afterRegenerateA(), bootstrap());
    // The query is load-bearing: `?section=` is what the pool dispatches on and what the
    // poster/variant identity reads. Rebasing must not collapse the siblings onto one variant.
    expect(b.simulation_served_url).toBe(`${REV2}?section=sec-b&v=h`);
  });

  it('leaves the sibling one package hop away from the regenerated section — the real cost', () => {
    const stale = afterRegenerateA();
    expect(
      packageKeyOf(servedSimulationUrl(stale[0], new Map())!),
      'setup: the two rows should disagree without the fix',
    ).not.toBe(packageKeyOf(servedSimulationUrl(stale[1], new Map())!));
    expect(simDocumentSwitch({
      mounted: servedSimulationUrl(stale[0], new Map()),
      mountedDynamic: true,
      next: servedSimulationUrl(stale[1], new Map())!,
    }), 'a sibling hop cost a full document boot').toBe('navigate');

    const fixed = withRepublishedServedUrls(stale, bootstrap());
    expect(simDocumentSwitch({
      mounted: servedSimulationUrl(fixed[0], new Map()),
      mountedDynamic: true,
      next: servedSimulationUrl(fixed[1], new Map())!,
    }), 'the sibling hop must be a same-package reuse again').toBe('reuse');
  });

  it('never rewrites the STORED url — only the resolved copy', () => {
    const [, b] = withRepublishedServedUrls(afterRegenerateA(), bootstrap());
    expect(b.simulation_url, 'the column the editor writes back was rewritten').toBe(`${REV1}?section=sec-b&v=h`);
  });

  it('leaves sections of a DIFFERENT simulation alone', () => {
    const other = { id: 'sec-c', simulation_id: 'sim-2', simulation_url: `${PREFIX}-2/x.html?section=sec-c`, simulation_served_url: `${PREFIX}-2/x.html?section=sec-c` };
    const out = withRepublishedServedUrls([...afterRegenerateA(), other], [...bootstrap(), other]);
    expect(out[2].simulation_served_url).toBe(`${PREFIX}-2/x.html?section=sec-c`);
  });

  it('is inert for a drag, a trim or an undo — nothing republished, nothing moves', () => {
    // Every write endpoint resolves the pointer on the way out, so an ordinary edit comes back
    // naming the same revision. The identity of the array is preserved so the editor's memos hold.
    const before = bootstrap();
    const dragged = [{ ...before[0], start_sec: 5 }, before[1]] as typeof before;
    expect(withRepublishedServedUrls(dragged, before)).toBe(dragged);
  });

  it('is inert for a row the editor has never seen', () => {
    // A duplicate, or an audio cutaway being inserted: a first sighting is not evidence that a
    // revision moved, and treating it as one would rebase the whole package off a new row.
    const created = [...bootstrap(), row('sec-new', `${REV2}?section=sec-new&v=h`)];
    expect(withRepublishedServedUrls(created, bootstrap())).toBe(created);
  });

  it('leaves an un-revisioned (legacy) package completely alone', () => {
    // No pointer means the server echoes the stored URL, so nothing ever compares unequal.
    const legacy = [
      { id: 'sec-a', simulation_id: 'sim-9', simulation_url: `${ORIGIN}/legacy/a.html`, simulation_served_url: `${ORIGIN}/legacy/a.html` },
      { id: 'sec-b', simulation_id: 'sim-9', simulation_url: `${ORIGIN}/legacy/a.html?section=b`, simulation_served_url: `${ORIGIN}/legacy/a.html?section=b` },
    ];
    expect(withRepublishedServedUrls(legacy, legacy)).toBe(legacy);
  });
});

describe('the stored url is still what gets written back', () => {
  it('never appears in a section PATCH or POST body', () => {
    // sectionPatchBody / sectionCreateBody are the editor's only writers of this column.
    const editor = readSource('../components/VideoEditor.tsx');
    const bodies = editor.slice(editor.indexOf('function sectionPatchBody'), editor.indexOf('function sectionComparable'));
    expect(bodies).toContain('simulation_url: s.simulation_url');
    expect(bodies).not.toContain('simulation_served_url');
  });

  it('reaches the player only through a render-time copy', () => {
    const editor = readSource('../components/VideoEditor.tsx');
    expect(editor).toContain('activeSimSection={activeSimSectionServed}');
    expect(editor).toContain('servedSimulationUrl(activeSimSection, servedSimUrls)');
  });

  it('and the republish propagation is on the path a generation `done` actually takes', () => {
    // SectionEditor's stream handler → `onUpdate` → TimelinePanel → `onSectionsChange`, which is
    // `commitSections`. Asserted at the wiring because the editor is never mounted in this suite
    // (see editorSimResidency.test.tsx's note on the app shell) — the BEHAVIOUR of the propagation
    // is covered above, and this is the one line that decides whether it ever runs.
    const editor = readSource('../components/VideoEditor.tsx');
    const commit = editor.slice(editor.indexOf('const commitSections'), editor.indexOf('const restoreSectionSnapshot'));
    expect(commit).toContain('withRepublishedServedUrls(nextSections, sections)');
    expect(editor).toContain('onSectionsChange={commitSections}');
  });
});
