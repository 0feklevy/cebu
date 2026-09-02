/**
 * The extended library modal renders every anchor the library tour points at.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

vi.mock('../components/avatar/avatarApi', () => ({
  getProjectLibrary: vi.fn(async () => ({ items: [], total: 0, typeCounts: {} })),
  generateLibraryImage: vi.fn(async () => ({})),
  generateLibrarySimulation: vi.fn(async () => ({})),
  patchLibraryVisual: vi.fn(async () => ({ ok: true })),
  deleteLibraryVisual: vi.fn(async () => ({ ok: true })),
  editLibrarySimulation: vi.fn(async () => ({})),
  uploadLibraryFiles: vi.fn(async () => ({ ok: true, accepted: [], rejected: [] })),
}));
vi.mock('../components/avatar/renderers/EquationRenderer', () => ({ EquationRenderer: () => null }));
vi.mock('../components/avatar/renderers/ChartRenderer', () => ({ ChartRenderer: () => null }));
vi.mock('../components/avatar/renderers/DiagramRenderer', () => ({ DiagramRenderer: () => null }));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { ExtendedLibraryModal } from '../components/avatar/ExtendedLibraryModal';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('tour anchors — the extended library', () => {
  it.each(SURFACE_ANCHORS.library)('renders %s', async (anchor) => {
    const { container } = render(<ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => expect(container.querySelector(anchorSelector(anchor))).not.toBeNull());
  });
});
