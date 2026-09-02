'use client';

import { useEffect, useRef, useState } from 'react';
import { usePaintedSignal } from './usePaintedSignal';
import { X } from 'lucide-react';
import { SimSurface } from '@/lib/sim/SimSurface';
import type { LibraryMaterial } from 'shared/src/types/library-view';

/**
 * The single full-viewport surface. Exactly one child is mounted, and it is UNMOUNTED on close.
 *
 * Unmounting rather than hiding is the load-bearing rule, and it is a fact about browsers rather
 * than a preference: an in-viewport iframe at `opacity: 0` is NOT throttled, so a hidden simulation
 * keeps its WebGL context alive and keeps its audio playing. Removing the element is what releases
 * the context and stops the sound. The reference page says the same thing in its own comments, and
 * the repository documents it independently. A test asserts the iframe is GONE from the DOM after
 * a close, not merely hidden.
 *
 * `svh` units, not `vh`: a phone's URL bar must never be able to clip the close button.
 */

interface Props {
  material: LibraryMaterial;
  onClose: () => void;
}

export function LibraryOverlay({ material, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={material.name}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      style={{ height: '100svh' }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground" title={material.name}>{material.name}</p>
        </div>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
        >
          <X size={16} strokeWidth={1.9} aria-hidden />
        </button>
      </div>

      {/* min-h-0 is what actually lets this pane shrink inside the flex column. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 sm:p-5">
        <MaterialSurface material={material} />
      </div>
    </div>
  );
}

function MaterialSurface({ material }: { material: LibraryMaterial }) {
  switch (material.type) {
    case 'simulation': return <SimulationSurface material={material} />;
    case 'video':      return <VideoSurface material={material} />;
    case 'audio':      return <AudioSurface material={material} />;
    case 'image':      return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={material.url}
        alt={material.name}
        className="max-h-full max-w-full object-contain"
        decoding="async"
      />
    );
  }
}

/**
 * Never a hand-rolled `<iframe>`. `SimSurface` owns the `#simboot=` fragment (dropping it turns a
 * hash-only src change into a full navigation that hard-reloads a live sim), the
 * `allow-scripts allow-same-origin allow-forms` sandbox, and the `inert` + `aria-hidden` +
 * `tabIndex={-1}` rules for a frame that has not yet earned its reveal.
 */
function SimulationSurface({ material }: { material: LibraryMaterial }) {
  const [loaded, setLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // "Loaded" used to mean the document's load event, which fires long before a WebGL package has
  // drawn anything — the cover cleared onto a blank frame. The rAF gate every stored package
  // carries posts SIM_PAINTED on the first real frame; that is the honest signal. A package that
  // never posts it (none in production, but a cheap fallback beats a stuck cover) reveals a
  // moment after load (night run 2026-09-03 §6).
  const painted = usePaintedSignal(frameRef, loaded, 2500);
  const revealed = painted;
  const poster = material.posterUrl ?? material.bannerUrl ?? null;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-card">
      {poster && !revealed && (
        // The still of the same package, at once — the listener sees the picture the sim will
        // resolve into, instead of a grey box with a caption.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full object-contain" decoding="async" />
      )}
      <SimSurface
        src={material.url}
        bootHide={[]}
        visible={revealed}
        frameRef={(el) => { frameRef.current = el; }}
        onLoad={() => setLoaded(true)}
        title={material.name}
        allow="fullscreen"
        interactive
        className="absolute inset-0 h-full w-full border-0"
      >
        {!revealed && !poster && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Loading simulation…
          </span>
        )}
      </SimSurface>
    </div>
  );
}

const NOOP_FRAME_REF = () => {};

/**
 * hls.js is imported dynamically so it stays out of the first-load bundle — this page's whole
 * economy is one small server-rendered document, and a visitor who never opens a video should never
 * pay for the library. Safari plays HLS natively, so the native path is tried first.
 */
function VideoSurface({ material }: { material: LibraryMaterial }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;

    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = material.url;
      return () => { el.removeAttribute('src'); el.load(); };
    }

    void (async () => {
      try {
        const Hls = (await import('hls.js')).default;
        if (destroyed || !Hls.isSupported()) { setError(!Hls.isSupported()); return; }
        const instance = new Hls();
        hls = instance;
        instance.loadSource(material.url);
        instance.attachMedia(el);
      } catch {
        if (!destroyed) setError(true);
      }
    })();

    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [material.url]);

  if (error) {
    return <p className="text-sm text-muted-foreground">This video cannot be played in this browser.</p>;
  }

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      // The stored thumbnail (when the payload carries one) fills the surface while HLS attaches.
      poster={material.bannerUrl ?? undefined}
      className="max-h-full max-w-full rounded-lg border border-border bg-card"
    >
      {material.captionsUrl && (
        <track kind="captions" src={material.captionsUrl} srcLang="en" label="Captions" default />
      )}
    </video>
  );
}

/** `preload="none"` matters on a 2-vCPU VM with no CDN: opening the page must fetch no audio. */
function AudioSurface({ material }: { material: LibraryMaterial }) {
  return (
    <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-sm-soft">
      <p className="mb-3 truncate text-sm font-semibold text-card-foreground">{material.name}</p>
      <audio controls preload="none" src={material.url} className="w-full">
        Your browser cannot play this sound.
      </audio>
    </div>
  );
}
