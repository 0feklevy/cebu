/**
 * Float32 PCM → 16-bit WAV, the shape a speech-to-text API accepts without a transcoder.
 *
 * The VAD hands over 16 kHz mono Float32 samples; a WAV container is 44 bytes of header in front
 * of them. Written here rather than imported because it is forty lines, and the one third-party
 * encoder in reach lives inside a package whose licence we did not want to audit for this.
 */
/** The bytes of a 16-bit mono WAV — the Blob-free form the tests read directly. */
export function encodeWavBytes(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);                  // PCM chunk size
  view.setUint16(20, 1, true);                   // PCM format
  view.setUint16(22, 1, true);                   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);                  // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return buffer;
}

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  return new Blob([encodeWavBytes(samples, sampleRate)], { type: 'audio/wav' });
}

/** Seconds of audio in a Float32 buffer at `sampleRate`. */
export function pcmDurationSec(samples: Float32Array, sampleRate = 16000): number {
  return samples.length / sampleRate;
}

/**
 * A short earcon — a soft two-tone "mm-hm?" — as a WAV Blob, so it plays through a plain
 * <audio> element and needs no AudioContext. Rendered once per page.
 */
export function earconBytes(sampleRate = 16000): ArrayBuffer {
  const durationSec = 0.22;
  const n = Math.round(sampleRate * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = t < 0.11 ? 660 : 880;
    const env = Math.sin(Math.PI * (t / durationSec));    // one smooth swell, no click
    out[i] = 0.35 * env * Math.sin(2 * Math.PI * f * t);
  }
  return encodeWavBytes(out, sampleRate);
}

export function earconWav(sampleRate = 16000): Blob {
  return new Blob([earconBytes(sampleRate)], { type: 'audio/wav' });
}
