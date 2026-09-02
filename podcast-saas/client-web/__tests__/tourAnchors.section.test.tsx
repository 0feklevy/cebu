/**
 * The section editor renders every anchor the section tours point at, across the section kinds
 * it switches on: a simulation section with a simulation attached, an AI-video section, a clip
 * over a video, a clip over an image, and a b-roll clip.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageFile, Simulation, TimelineSection, VideoFile } from 'shared/src/generated/client-v1';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => 't' } }) }));
vi.mock('../lib/api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { SectionEditor } from '../components/SectionEditor';

const ORIGIN = 'http://localhost:8080';
const PREFIX = `${ORIGIN}/sim-public/simulations/proj-1/sim-1`;

const section = (over: Partial<TimelineSection> = {}): TimelineSection => ({
  id: 'sec-b', project_id: 'proj-1', video_file_id: 'vid-1', start_sec: 0, end_sec: 10,
  type: 'simulation', track: 'main', label: 'B', notes: null, sort_order: 0,
  simulation_url: `${PREFIX}/index.html?section=sec-b&v=h2`, simulation_served_url: null, simulation_id: 'sim-1',
  sim_script: 'main', sim_prompt: null, simple_ui: false, auto_script: true, sim_meta: null,
  global_offset_sec: null, clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
} as unknown as TimelineSection);

const SIM = {
  id: 'sim-1', project_id: 'proj-1', name: 'S', storage_prefix: 'simulations/proj-1/sim-1',
  entry_file: `${PREFIX}/index.html`, bridge_functions: null, status: 'ready', error: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation;
const VIDEO = { id: 'vid-1', project_id: 'proj-1', is_broll: false, filename: 'a.mp4', created_at: '2026-01-01T00:00:00.000Z' } as unknown as VideoFile;
const IMAGE = { id: 'img-1', project_id: 'proj-1', filename: 'a.png', created_at: '2026-01-01T00:00:00.000Z' } as unknown as ImageFile;

/** The section kinds, and the anchors each one is expected to render. */
const KINDS: Array<{ name: string; over: Partial<TimelineSection>; anchors: readonly string[] }> = [
  { name: 'simulation with a simulation attached', over: {}, anchors: ['sec-sim-select', 'sec-sim-prompt', 'sec-sim-generate', 'sec-sim-presets', 'sec-sim-controls'] },
  { name: 'AI video', over: { type: 'video', simulation_id: null, simulation_url: null }, anchors: ['sec-video-prompt', 'sec-video-generate', 'sec-video-options'] },
  { name: 'clip over a video', over: { type: 'clip', simulation_id: null, simulation_url: null, clip_source_video_id: 'vid-1' }, anchors: ['sec-video'] },
  { name: 'clip over an image', over: { type: 'clip', simulation_id: null, simulation_url: null, clip_source_image_id: 'img-1' }, anchors: ['sec-camera'] },
  { name: 'b-roll', over: { track: 'broll', type: 'video', simulation_id: null, simulation_url: null, clip_source_video_id: 'vid-1' }, anchors: ['sec-broll-info'] },
];

function mount(over: Partial<TimelineSection>) {
  return render(
    <SectionEditor
      section={section(over)}
      projectId="proj-1"
      simulations={[SIM]}
      videos={[VIDEO]}
      videoUrls={{ 'vid-1': 'blob:vid-1' }}
      images={[IMAGE]}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  ).container;
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'matchMedia'); });

describe('tour anchors — the section editor', () => {
  it('the kinds together claim every section anchor in the ledger', () => {
    const claimed = KINDS.flatMap((k) => k.anchors).sort();
    expect(claimed).toEqual([...SURFACE_ANCHORS.section].sort());
  });

  for (const kind of KINDS) {
    it.each(kind.anchors)(`${kind.name} renders %s`, async (anchor) => {
      const container = mount(kind.over);
      await waitFor(() => expect(container.querySelector(anchorSelector(anchor as never))).not.toBeNull());
    });
  }
});
