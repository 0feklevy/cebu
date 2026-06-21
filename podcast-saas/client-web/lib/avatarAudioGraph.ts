// Shared Web Audio graph for the avatar-circle visualizer. One AudioContext per
// page; each main <video> is tapped once as: src → analyser (full-signal viz tap)
// and src → gain → destination (audible, volume-controlled). The gain mirrors the
// element's volume/muted each frame so the viewer's volume slider keeps working,
// while the analyser still reacts to the audio content regardless of volume.
//
// We only create the MediaElementSource once the context is actually running —
// tapping a suspended context would reroute the element into a silent graph and
// kill playback. A per-element tap failure is skipped (recoverable), not fatal.

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let unsupported = false;
const gains = new Map<HTMLMediaElement, GainNode>();

function audioCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * Ensure the analyser exists and the given media elements are tapped (when it's
 * safe to do so). Returns the shared AnalyserNode, or null if Web Audio is
 * unavailable or the context isn't running yet (caller should use an idle/fake
 * source until it returns non-null).
 */
export function ensureAvatarAnalyser(els: Array<HTMLMediaElement | null | undefined>): AnalyserNode | null {
  if (unsupported) return null;
  const Ctor = audioCtor();
  if (!Ctor) { unsupported = true; return null; }
  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    if (ctx.state !== 'running') return analyser; // don't tap until running (avoids silencing)
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
    }
    for (const el of els) {
      if (!el || gains.has(el)) continue;
      try {
        const src = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        src.connect(analyser);            // full-signal tap for the visualizer
        src.connect(gain);
        gain.connect(ctx.destination);    // audible path (volume/mute mirrored below)
        gains.set(el, gain);
      } catch {
        // This element is already tapped elsewhere or can't be tapped — skip it
        // only (do NOT disable the whole feature).
      }
    }
    return analyser;
  } catch {
    unsupported = true;
    return null;
  }
}

/** Mirror each tapped element's volume/muted into its gain (keeps the volume slider working). */
export function syncAvatarGains(): void {
  for (const [el, gain] of gains) {
    const v = el.muted ? 0 : (Number.isFinite(el.volume) ? el.volume : 1);
    try { gain.gain.value = v; } catch { /* ignore */ }
  }
}
