/**
 * The two admin surfaces an on-call operator reaches under time pressure: the Controls page's
 * kill switches (ui-ux-007) and the API-keys page's secret fields (ui-ux-008).
 *
 * Both were operable only by SIGHT. Every switch on Controls announced as "switch, on" with no
 * indication of WHICH switch — including Maintenance Mode, the control this page's own comments
 * call "the kill switches an incident actually needs". Every API-key field announced as an
 * unlabelled password box, so a screen-reader user could not tell which provider's key they were
 * about to overwrite.
 *
 * These tests deliberately do NOT assert "the aria-label attribute equals X" — that would pass for
 * a label attached to the WRONG control, which is the failure that actually hurts here. Each name
 * is resolved through the accessibility tree (`getByRole(..., { name })` / `getByLabelText`) and
 * then USED to drive the control, and the assertion is on what the API was asked to change.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { adminApi } = vi.hoisted(() => ({
  adminApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(async (_settings: unknown) => ({ success: true })),
    listApiKeys: vi.fn(),
    setApiKey: vi.fn(async () => ({ success: true })),
    testApiKey: vi.fn(async () => ({ valid: true, model: 'claude-x' })),
    deleteApiKey: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock('../lib/api', () => ({ adminApi }));
// AdminShell pulls in AdminNav → firebase + next/navigation. It is page chrome, not the subject.
vi.mock('../components/AdminShell', () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ControlsPage from '../app/feature-flags/page';
import ApiKeysPage from '../app/api-keys/page';

const SETTINGS = {
  id: 1,
  billing_enabled: false,
  generation_paused: false,
  generation_paused_message: null,
  maintenance_mode: false,
  maintenance_message: null,
  anonymous_user_limit: 3,
  generation_limit_enabled: false,
  generation_daily_limit: 10,
  sim_pool_mode: 'single',
  sim_scheduler_mode: 'off',
  sim_adaptive_quality: false,
  sim_boundary_sentinel: true,
  sim_transition_coordinator: true,
  rum_sample_rate: 0.1,
};

beforeEach(() => {
  vi.clearAllMocks();
  adminApi.getSettings.mockResolvedValue({ ...SETTINGS });
  adminApi.listApiKeys.mockResolvedValue([
    { provider: 'claude', set: true, last_updated: '2026-08-01T00:00:00.000Z' },
    { provider: 'openai', set: false, last_updated: null },
    { provider: 'gemini', set: false, last_updated: null },
    { provider: 'elevenlabs', set: false, last_updated: null },
  ]);
});
afterEach(cleanup);

/** Every switch this page renders, by the visible title an operator is looking for. */
const SWITCH_TITLES = [
  'Maintenance Mode',
  'Per-User Generation Limit',
  'Frame-valid transition coordinator',
  'Adaptive quality',
  'Boundary sentinel',
  'Welcome project seeding',
];

describe('admin Controls kill switches (ui-ux-007)', () => {
  it('gives every switch the name of the flag it throws', async () => {
    render(<ControlsPage />);
    await screen.findByRole('switch', { name: 'Maintenance Mode' });

    for (const title of SWITCH_TITLES) {
      expect(screen.getByRole('switch', { name: title })).toBeTruthy();
    }
    // No switch is left anonymous.
    expect(screen.getAllByRole('switch')).toHaveLength(SWITCH_TITLES.length);
  });

  it('reports its on/off state on the named switch, not just visually', async () => {
    render(<ControlsPage />);
    const maintenance = await screen.findByRole('switch', { name: 'Maintenance Mode' });
    expect(maintenance.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(maintenance);
    expect(
      (await screen.findByRole('switch', { name: 'Maintenance Mode' })).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('throws the flag the NAME promised — the switch found by name is wired to maintenance_mode', async () => {
    render(<ControlsPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Maintenance Mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(adminApi.updateSettings).toHaveBeenCalledTimes(1));
    const sent = adminApi.updateSettings.mock.calls[0]![0] as unknown as typeof SETTINGS;
    expect(sent.maintenance_mode).toBe(true);
    // …and only that one. A label bound to the wrong switch would show up right here.
    expect(sent.sim_adaptive_quality).toBe(false);
    expect(sent.generation_limit_enabled).toBe(false);
    expect(sent.sim_boundary_sentinel).toBe(true);
  });

  it('names the numeric operator inputs too', async () => {
    render(<ControlsPage />);
    await screen.findByRole('switch', { name: 'Maintenance Mode' });
    expect(screen.getByLabelText('Anonymous User Limit')).toBeTruthy();
    expect(screen.getByLabelText('Simulation telemetry sample rate')).toBeTruthy();
  });
});

describe('admin API-key fields (ui-ux-008)', () => {
  it('names each key field with the provider it belongs to', async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(adminApi.listApiKeys).toHaveBeenCalled());

    for (const name of [
      'Anthropic (Claude) API key',
      'Google (Gemini) API key',
      'OpenAI API key',
      'ElevenLabs API key',
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it('writes the typed secret to the provider the LABEL named, not a neighbour', async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(adminApi.listApiKeys).toHaveBeenCalled());

    // Fill every field with a distinct value, so a mis-wired label surfaces as the wrong secret.
    fireEvent.change(screen.getByLabelText('Anthropic (Claude) API key'), { target: { value: 'sk-ant-CLAUDE' } });
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'sk-OPENAI' } });
    fireEvent.change(screen.getByLabelText('Google (Gemini) API key'), { target: { value: 'AIza-GEMINI' } });
    fireEvent.change(screen.getByLabelText('ElevenLabs API key'), { target: { value: 'sk_ELEVEN' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));

    await waitFor(() => expect(adminApi.setApiKey).toHaveBeenCalledTimes(1));
    expect(adminApi.setApiKey).toHaveBeenCalledWith('openai', 'sk-OPENAI');
  });

  it('distinguishes the four Test / Save / Remove buttons by provider', async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(adminApi.listApiKeys).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: 'Test Anthropic (Claude) key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save ElevenLabs key' })).toBeTruthy();
    // Only Claude has a key set in the fixture, so only Claude offers Remove.
    expect(screen.getByRole('button', { name: 'Remove Anthropic (Claude) key' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove OpenAI key' })).toBeNull();
  });
});
