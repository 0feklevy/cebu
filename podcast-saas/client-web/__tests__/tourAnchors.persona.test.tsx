/**
 * The avatar persona modal renders every anchor the persona tour points at.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

vi.mock('../components/avatar/avatarApi', () => ({
  getAvatarConfig: vi.fn(async () => ({ config: {} })),
  saveAvatarConfig: vi.fn(async () => ({ config: {} })),
  getByokStatus: vi.fn(async () => ({})),
  listAnamResources: vi.fn(async () => ({ data: [] })),
  listAvatarTools: vi.fn(async () => ({ tools: [] })),
  listKnowledgeDocs: vi.fn(async () => ({ data: [] })),
  uploadKnowledgeDoc: vi.fn(), deleteKnowledgeDoc: vi.fn(),
}));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { AvatarSettingsModal } from '../components/avatar/AvatarSettingsModal';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Some anchors live behind the modal's own tab; open whichever tab names the anchor's panel. */
async function reveal(container: HTMLElement, anchor: string): Promise<void> {
  if (container.querySelector(anchorSelector(anchor as never))) return;
  const advanced = screen.queryByRole('button', { name: /advanced/i });
  if (advanced) fireEvent.click(advanced);
}

describe('tour anchors — the avatar persona', () => {
  it.each(SURFACE_ANCHORS.persona)('renders %s', async (anchor) => {
    const { container } = render(<AvatarSettingsModal open onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => expect(container.querySelector(anchorSelector('persona-basics'))).not.toBeNull());
    await reveal(container, anchor);
    await waitFor(() => expect(container.querySelector(anchorSelector(anchor))).not.toBeNull());
  });
});
