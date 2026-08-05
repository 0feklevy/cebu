import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SimPoolOverlay } from '../components/viewer/SimPoolOverlay';

vi.mock('../lib/assetUrl', () => ({ resolveAssetUrl: (u: string) => u }));

const frames = [{ key: 'k1', src: 'https://cdn.test/a/index.html', bootHide: [] }] as never;
const noop = () => {};

describe('cold-seek affordance', () => {
  it('shows the captured poster instead of a bare spinner while a cold sim boots', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    const img = container.querySelector('img.sim-cold-poster') as HTMLImageElement | null;
    expect(img, 'no poster rendered during the cold wait').not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://cdn.test/p.png');
    expect(container.querySelector('.sim-overlay-spinner'), 'spinner stacked over the poster').toBeNull();
  });

  it('keeps the spinner when the section has NO captured poster', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc={null} registerFrame={noop} onFrameLoad={noop} />);
    expect(container.querySelector('img.sim-cold-poster')).toBeNull();
    expect(container.querySelector('.sim-overlay-spinner')).not.toBeNull();
  });

  it('keeps a motion cue when the sim has genuinely STALLED, so a still frame cannot read as done', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        stalled posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    expect(container.querySelector('img.sim-cold-poster')).not.toBeNull();
    expect(container.querySelector('.sim-overlay-spinner')).not.toBeNull();
  });

  it('shows nothing at all when the sim is neither cold nor stalled', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible armGate
        posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    expect(container.querySelector('.sim-wait-affordance')).toBeNull();
  });
});
