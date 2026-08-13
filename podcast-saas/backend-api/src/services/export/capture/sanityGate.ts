/**
 * The rendering SANITY GATE (plan §0.3). Pure and testable: it takes samples of the CANVAS REGION
 * (not the whole screenshot) across several frames and a few recorded signals, and returns a verdict.
 *
 * Why the canvas region and not the screenshot: "Frame-1 non-uniformity is not sufficient — a dead
 * black WebGL canvas under a Minimal-UI slider still yields a non-uniform screenshot" (§0.3). The
 * slider makes the *screenshot* non-uniform while the *canvas* is dead black. So the gate looks at
 * the canvas pixels only, and demands BOTH:
 *   • intra-frame non-uniformity — at least one sampled frame's canvas is not a flat colour, AND
 *   • inter-frame delta — the canvas actually changes across frames (the `movedOver()` idea from
 *     sim-canary.spec.ts: hash frame pairs, animation ⇒ different hashes),
 * combined with the `SIM_PAINTED` signal and a non-dead WebGL context (a WebGL context that was
 * attempted but came back null is the M144 black-canvas trap — plan §4 failure modes 1–2).
 *
 * It is a *sanity gate*, not a proof: a FAILURE is trustworthy (something is wrong); a PASS is strong
 * evidence, not a guarantee.
 */

/** A downsampled RGBA grid of the canvas region for one frame. `rgba` is length `width*height*4`. */
export interface FrameSample {
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayLike<number>;
}

/** What the injected probe recorded about WebGL context creation. */
export interface WebglRecord {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly renderer: string;
}

export interface GateInput {
  /** Did the bridge post `SIM_PAINTED` (a real first frame drew)? */
  readonly simPainted: boolean;
  /** The WebGL probe's recording. */
  readonly webgl: WebglRecord;
  /** Canvas-region samples across the capture. Need ≥2 to judge inter-frame delta. */
  readonly frames: readonly FrameSample[];
  /**
   * Per-channel tolerance for "uniform". A flat canvas has max−min ≤ this on every channel. Small
   * so anti-aliasing / codec noise doesn't read as content, but non-zero so it isn't brittle.
   */
  readonly uniformTolerance?: number;
}

export interface GateChecks {
  readonly simPainted: boolean;
  /** true unless a WebGL context was attempted and came back null (the dead-context trap). */
  readonly webglLive: boolean;
  /** true if at least one sampled canvas frame is non-uniform. */
  readonly intraFrameNonUniform: boolean;
  /** true if the canvas changed across frames (≥2 distinct frame signatures). */
  readonly interFrameDelta: boolean;
  /** true if there were enough samples to judge delta at all. */
  readonly enoughSamples: boolean;
}

export interface GateResult {
  readonly gate: 'passed' | 'failed';
  readonly reason?: string;
  readonly rendererString: string;
  readonly checks: GateChecks;
  readonly distinctFrames: number;
}

const DEFAULT_UNIFORM_TOLERANCE = 6;

/**
 * A cheap, order-sensitive hash of a frame's RGBA bytes (FNV-1a, 32-bit). Used only to count
 * DISTINCT frames — the same "did the pixels change?" question `movedOver()` answers by hashing.
 */
export function frameSignature(sample: FrameSample): string {
  let h = 0x811c9dc5;
  const px = sample.rgba;
  const n = px.length;
  for (let i = 0; i < n; i++) {
    h ^= px[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  // Fold width/height in so two same-byte buffers of different shape don't collide.
  h ^= sample.width;
  h = Math.imul(h, 0x01000193);
  h ^= sample.height;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Is a canvas frame flat (a single colour within tolerance)? A dead/black canvas is uniform; a
 * rendered scene is not. Compares each channel's spread (max−min) across all sampled pixels.
 */
export function isFrameUniform(sample: FrameSample, tolerance = DEFAULT_UNIFORM_TOLERANCE): boolean {
  const px = sample.rgba;
  const n = px.length;
  if (n < 8) return true; // one pixel or less: nothing to be non-uniform about
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, aMin = 255, aMax = 0;
  for (let i = 0; i + 3 < n; i += 4) {
    const r = px[i] & 0xff, g = px[i + 1] & 0xff, b = px[i + 2] & 0xff, a = px[i + 3] & 0xff;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    if (a < aMin) aMin = a; if (a > aMax) aMax = a;
  }
  return (
    rMax - rMin <= tolerance &&
    gMax - gMin <= tolerance &&
    bMax - bMin <= tolerance &&
    aMax - aMin <= tolerance
  );
}

/**
 * The gate. PASSES iff SIM_PAINTED fired, the WebGL context is not a dead attempted-null context,
 * at least one canvas frame is non-uniform, and the canvas changed across frames. A FAILURE lists
 * every failing check so the job row explains itself.
 */
export function evaluateSanityGate(input: GateInput): GateResult {
  const tolerance = input.uniformTolerance ?? DEFAULT_UNIFORM_TOLERANCE;
  const frames = input.frames;

  const webglLive = !(input.webgl.attempted && !input.webgl.ok);
  const enoughSamples = frames.length >= 2;

  const intraFrameNonUniform = frames.some((f) => !isFrameUniform(f, tolerance));

  const signatures = new Set<string>();
  for (const f of frames) signatures.add(frameSignature(f));
  const distinctFrames = signatures.size;
  const interFrameDelta = distinctFrames >= 2;

  const checks: GateChecks = {
    simPainted: input.simPainted,
    webglLive,
    intraFrameNonUniform,
    interFrameDelta,
    enoughSamples,
  };

  const reasons: string[] = [];
  if (!input.simPainted) reasons.push('the sim never posted SIM_PAINTED (no first frame drew)');
  if (!webglLive) {
    reasons.push('a WebGL context was requested but came back null (M144 SwiftShader trap — black canvas)');
  }
  if (!enoughSamples) {
    reasons.push(`only ${frames.length} canvas sample(s) — need ≥2 to judge animation`);
  }
  if (!intraFrameNonUniform) {
    reasons.push('every sampled canvas frame is uniform (dead/black canvas under the UI)');
  }
  if (enoughSamples && !interFrameDelta) {
    reasons.push('the canvas did not change across frames (nothing is animating)');
  }

  if (reasons.length > 0) {
    return {
      gate: 'failed',
      reason: reasons.join('; '),
      rendererString: input.webgl.renderer,
      checks,
      distinctFrames,
    };
  }

  return {
    gate: 'passed',
    rendererString: input.webgl.renderer,
    checks,
    distinctFrames,
  };
}
