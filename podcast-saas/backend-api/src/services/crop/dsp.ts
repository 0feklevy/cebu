/**
 * Pure-numeric DSP primitives for the smart-crop pipeline.
 *
 * Everything here is dependency-free (no OpenCV / MediaPipe / scipy) so it runs
 * unmodified on a plain Node host. The heavier vision/audio I/O is done by
 * ffmpeg (see ffmpegExtract.ts); this module only crunches the resulting arrays.
 */

// ── radix-2 complex FFT (iterative, in-place) ──────────────────────────────────

/**
 * In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be a power
 * of two. `inverse=true` computes the IFFT (without the 1/N scale — callers that
 * need it divide afterwards).
 */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftRadix2: length ${n} is not a power of two`);

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function nextPow2(n: number): number {
  return 1 << Math.ceil(Math.log2(Math.max(1, n)));
}

// ── pitch (F0) via normalized autocorrelation ──────────────────────────────────

export interface F0Result { f0: number; confidence: number; }

/**
 * Estimate fundamental frequency via FFT-based normalized autocorrelation.
 *
 * Improvements over a naive implementation:
 *   • Pre-emphasis + Hann window to stabilise the peak.
 *   • Parabolic interpolation around the peak lag → sub-sample F0 accuracy,
 *     which materially reduces gray-zone misclassification near the male/female
 *     boundary.
 *   • Octave-error guard: if a strong peak exists near double the lag (i.e. the
 *     true period is twice as long), prefer it — autocorrelation otherwise tends
 *     to lock onto the first harmonic.
 */
export function autocorrF0(
  chunk: Float32Array | Float64Array,
  sr: number,
  fmin = 70,
  fmax = 450,
): F0Result {
  const n = chunk.length;
  const lagMin = Math.max(1, Math.floor(sr / fmax));
  const lagMax = Math.min(n - 1, Math.floor(sr / fmin));
  if (lagMin >= lagMax || n < 64) return { f0: 0, confidence: 0 };

  // Pre-emphasis y[n] = x[n] - 0.97 x[n-1]
  const emph = new Float64Array(n);
  emph[0] = chunk[0];
  for (let i = 1; i < n; i++) emph[i] = chunk[i] - 0.97 * chunk[i - 1];

  // Hann window
  for (let i = 0; i < n; i++) emph[i] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  // FFT-based autocorrelation: acf = IFFT(|FFT(x)|^2)
  const size = nextPow2(2 * n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(emph);
  fftRadix2(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]; // power spectrum
    im[i] = 0;
  }
  fftRadix2(re, im, true); // unnormalised IFFT — only ratios matter below

  const zero = re[0];
  if (zero < 1e-9) return { f0: 0, confidence: 0 };

  // Highest peak in [lagMin, lagMax]
  let peakLag = lagMin;
  let peakVal = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const v = re[lag];
    if (v > peakVal) { peakVal = v; peakLag = lag; }
  }

  // Octave-error correction. A periodic signal autocorrelates at every multiple
  // of its period, so the global max can land on 2×/3× the true period (an
  // octave/twelfth too low). The fundamental is the *shortest* lag whose peak is
  // nearly as strong — scan upward and take the first strong local maximum.
  const thresh = 0.8 * peakVal;
  for (let lag = lagMin + 1; lag < peakLag; lag++) {
    if (re[lag] >= thresh && re[lag] >= re[lag - 1] && re[lag] >= re[lag + 1]) {
      peakLag = lag;
      break;
    }
  }

  // Parabolic interpolation around peakLag for sub-sample accuracy
  let lagInterp = peakLag;
  if (peakLag > lagMin && peakLag < lagMax) {
    const y0 = re[peakLag - 1], y1 = re[peakLag], y2 = re[peakLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) lagInterp = peakLag + (0.5 * (y0 - y2)) / denom;
  }

  const confidence = Math.max(0, Math.min(1, peakVal / zero));
  const f0 = lagInterp > 0 ? sr / lagInterp : 0;
  return { f0, confidence };
}

// ── spectral-residual saliency → per-column profile ────────────────────────────

/**
 * Spectral Residual Saliency (Hou & Zhang 2007) computed on a small square, then
 * collapsed to a per-column profile of length `outCols`. Returns values in
 * [0,1]. Pure NumPy in the reference; here a 2D FFT via row/column 1D FFTs.
 */
export function spectralResidualColumns(
  gray: Float64Array, // length w*h, row-major, values 0..255
  w: number,
  h: number,
  outCols: number,
): Float64Array {
  // FFT2 (forward)
  const re = new Float64Array(w * h);
  const im = new Float64Array(w * h);
  re.set(gray);
  fft2(re, im, w, h, false);

  // log amplitude
  const logAmp = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) logAmp[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-7);

  // averaged log amplitude (3×3 box) → spectral residual = logAmp - avg
  const avg = box3x3(logAmp, w, h);
  for (let i = 0; i < w * h; i++) {
    const residual = logAmp[i] - avg[i];
    const mag = Math.exp(residual);
    const ang = Math.atan2(im[i], re[i]);
    re[i] = mag * Math.cos(ang);
    im[i] = mag * Math.sin(ang);
  }

  // IFFT and take squared magnitude → saliency
  fft2(re, im, w, h, true);
  const sal = new Float64Array(w * h);
  const scale = 1 / (w * h);
  for (let i = 0; i < w * h; i++) {
    const r = re[i] * scale, ii = im[i] * scale;
    sal[i] = r * r + ii * ii;
  }

  // Collapse to column profile (sum over rows), resample to outCols, normalise.
  const colSum = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) colSum[x] += sal[row + x];
  }
  const out = resample1d(colSum, outCols);
  let max = 0;
  for (let i = 0; i < outCols; i++) if (out[i] > max) max = out[i];
  if (max > 1e-12) for (let i = 0; i < outCols; i++) out[i] /= max;
  return out;
}

function fft2(re: Float64Array, im: Float64Array, w: number, h: number, inverse: boolean): void {
  const rowRe = new Float64Array(w), rowIm = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    rowRe.set(re.subarray(off, off + w)); rowIm.set(im.subarray(off, off + w));
    fftRadix2(rowRe, rowIm, inverse);
    re.set(rowRe, off); im.set(rowIm, off);
  }
  const colRe = new Float64Array(h), colIm = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colRe[y] = re[y * w + x]; colIm[y] = im[y * w + x]; }
    fftRadix2(colRe, colIm, inverse);
    for (let y = 0; y < h; y++) { re[y * w + x] = colRe[y]; im[y * w + x] = colIm[y]; }
  }
}

function box3x3(src: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx]; c++;
        }
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

// ── 1D helpers ─────────────────────────────────────────────────────────────────

/** Linear-interpolation resample of a 1D array to `outLen` samples. */
export function resample1d(src: Float64Array, outLen: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(outLen);
  if (n === 0) return out;
  if (n === 1) { out.fill(src[0]); return out; }
  for (let i = 0; i < outLen; i++) {
    const pos = (i / Math.max(1, outLen - 1)) * (n - 1);
    const lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1);
    out[i] = src[lo] + (src[hi] - src[lo]) * (pos - lo);
  }
  return out;
}

/** Gaussian smoothing of a numeric series (reflect edges). sigma in samples. */
export function gaussian1d(xs: number[], sigma: number): number[] {
  if (xs.length < 2 || sigma <= 0) return xs.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let ksum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(v); ksum += v;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= ksum;

  const n = xs.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      let idx = i + k;
      if (idx < 0) idx = -idx;                       // reflect
      if (idx >= n) idx = 2 * n - 2 - idx;
      idx = Math.max(0, Math.min(n - 1, idx));
      acc += xs[idx] * kernel[k + radius];
    }
    out[i] = acc;
  }
  return out;
}

/** Sliding-window median (odd window). Kills single-sample outliers pre-smoothing. */
export function median1d(xs: number[], window: number): number[] {
  const n = xs.length;
  if (n < 3 || window < 3) return xs.slice();
  const half = Math.floor(window / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    const win = xs.slice(lo, hi + 1).sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

/** Bhattacharyya distance between two normalised histograms (∈ [0,1]). */
export function bhattacharyya(a: Float64Array, b: Float64Array): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  if (sa < 1e-12 || sb < 1e-12) return 1;
  let bc = 0;
  for (let i = 0; i < a.length; i++) bc += Math.sqrt((a[i] / sa) * (b[i] / sb));
  return Math.sqrt(Math.max(0, 1 - bc));
}
