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
import { rememberServedSimUrls, servedSimulationUrl } from '../lib/simServedUrl';

// NOT `new URL(<literal>, import.meta.url)`: Vite rewrites that exact form into a bundled asset
// reference, and the result is an http: URL that readFileSync refuses.
const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const STORED = 'https://cdn/sim-public/sims/s1/revisions/OLD/package/index.html?section=sec-1&v=H1';
const SERVED = 'https://cdn/sim-public/sims/s1/revisions/NEW/package/index.html?section=sec-1&v=H1';

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
});
