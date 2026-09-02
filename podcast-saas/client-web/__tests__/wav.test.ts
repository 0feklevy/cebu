import { describe, it, expect } from 'vitest';
import { earconBytes, encodeWav, encodeWavBytes, pcmDurationSec } from '../lib/wav';

const ascii = (view: DataView, offset: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header and clamps samples', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    expect(encodeWav(samples, 16000).type).toBe('audio/wav');
    const view = new DataView(encodeWavBytes(samples, 16000));
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);        // PCM
    expect(view.getUint16(22, true)).toBe(1);        // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);       // bits
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(48, true)).toBe(-0x4000);
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
    expect(view.getInt16(54, true)).toBe(0x7fff);    // clamped
    expect(view.getInt16(56, true)).toBe(-0x8000);   // clamped
  });

  it('pcmDurationSec is samples over rate', () => {
    expect(pcmDurationSec(new Float32Array(48000), 16000)).toBe(3);
  });

  it('the earcon is a short, quiet, click-free WAV', async () => {
    const view = new DataView(earconBytes(16000));
    const n = view.getUint32(40, true) / 2;
    expect(n / 16000).toBeCloseTo(0.22, 2);
    // Starts and ends at silence (the envelope), never clips.
    expect(Math.abs(view.getInt16(44, true))).toBeLessThan(200);
    expect(Math.abs(view.getInt16(44 + (n - 1) * 2, true))).toBeLessThan(200);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
    expect(peak).toBeLessThan(0.4 * 0x7fff);
  });
});
