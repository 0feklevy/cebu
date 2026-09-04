'use client';

import { useState } from 'react';
import { Image as ImageIcon, Music, Play, Sparkles } from 'lucide-react';
import type { LibraryMaterial } from 'shared/src/types/library-view';

/**
 * One banner tile.
 *
 * The tile IS the control — a `<button>` wrapping the whole surface — which is what the owner's
 * reference page does and why keyboard and screen-reader operability come free rather than being
 * bolted on. Nothing here is a `<div onClick>`.
 *
 * NO LIVE SIMULATION EVER RENDERS IN THE GRID. On an anonymous public page served by one 2-vCPU VM
 * with no CDN, a grid of WebGL contexts is a self-inflicted outage; exactly one simulation mounts,
 * on tap, inside the overlay. Grid tiles are static by design, not by omission.
 *
 * STYLING IS TOKEN-ONLY. Every colour is an HSL custom-property token (`bg-card`, `border-border`,
 * `text-muted-foreground`, `from-primary/70`), because the light palette is on `:root` and the dark
 * one on `html[data-theme="dark"]`. The `/c/` pages hardcode `text-black/50` and are broken in dark
 * mode; copying them is the single most likely way this page ships looking wrong, so a test asserts
 * no hex and no `text-black/` appears in the rendered tree.
 */

/**
 * Gradient tiles for material with no still image of its own. Built from palette TOKENS rather than
 * the hex triples in `PlaylistsPanel.tsx`'s CARD_GRADIENTS: those are fixed sRGB values that ignore
 * the theme entirely, and this page has to survive dark mode.
 */
const TOKEN_GRADIENTS = [
  'bg-gradient-to-br from-primary/80 via-primary/55 to-primary/25',
  'bg-gradient-to-br from-primary/70 to-accent/80',
  'bg-gradient-to-br from-secondary to-primary/55',
  'bg-gradient-to-br from-muted via-primary/30 to-primary/55',
  'bg-gradient-to-br from-primary/60 via-accent/60 to-primary/30',
  'bg-gradient-to-br from-accent to-primary/65',
];

/** Deterministic, so the same material keeps the same tile across renders and across visitors. */
export function gradientFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TOKEN_GRADIENTS[hash % TOKEN_GRADIENTS.length];
}

function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TypeGlyph({ type }: { type: LibraryMaterial['type'] }) {
  const common = { size: 22, strokeWidth: 1.6, 'aria-hidden': true } as const;
  switch (type) {
    case 'simulation': return <Sparkles {...common} />;
    case 'video':      return <Play {...common} />;
    case 'audio':      return <Music {...common} />;
    case 'image':      return <ImageIcon {...common} />;
  }
}

export const TYPE_LABEL: Record<LibraryMaterial['type'], string> = {
  simulation: 'Simulation', image: 'Image', video: 'Video', audio: 'Sound',
};

interface Props {
  material: LibraryMaterial;
  /** True for the first row — those load eagerly, the rest lazily. The reference page's trick. */
  eager?: boolean;
  onOpen: (material: LibraryMaterial) => void;
  /** Pointer went down on the tile — a moment before the click that opens it. */
  onWarm?: (material: LibraryMaterial) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

export function LibraryCard({ material, eager = false, onOpen, onWarm, buttonRef }: Props) {
  // A material whose bytes have gone (deleted image, moved object) falls back to the gradient
  // rather than showing a broken-image glyph. The server already dropped anything unresolvable.
  const [imageFailed, setImageFailed] = useState(false);
  const [portraitBanner, setPortraitBanner] = useState(false);
  // The tile's still picture: an image IS its own picture; a simulation or video rides on the
  // stored artifact the backend re-emitted as `bannerUrl` (sim poster / video-derived thumbnail).
  // Nothing is captured for this tile — no bannerUrl, no picture, gradient.
  const still = material.type === 'image' ? material.url : material.bannerUrl ?? null;
  const showImage = Boolean(still) && !imageFailed;
  const duration = formatDuration(material.durationSec);

  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={() => onOpen(material)}
      // `card-interactive` is the house hover (lift + shadow, one transition curve for every card
      // in the product) — not a hand-assembled translate/shadow pair that drifts from it.
      className="group card-interactive flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left text-card-foreground shadow-sm-soft hover:border-primary/30 focus-ring"
      onPointerDown={() => onWarm?.(material)}
    >
      <span className={`relative block aspect-video w-full overflow-hidden ${showImage ? 'bg-muted' : gradientFor(material.id)}`}>
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={still!}
            // A banner is decoration for a tile whose caption already names it; only an image
            // material's picture IS the content, so only that one gets a real alt.
            alt={material.type === 'image' ? material.name : ''}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            // No width/height attrs: the aspect-video span already reserves the box, and a
            // hardcoded 640×360 lied about every portrait poster (360×640) — the browser sized
            // the element from the wrong intrinsic ratio until the bytes arrived.
            onError={() => setImageFailed(true)}
            // A portrait poster (a 9:16 project's simulation, night run 2026-09-03 §3) is shown
            // whole inside the 16:9 tile rather than having its top and bottom cut off.
            onLoad={(e) => setPortraitBanner(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth)}
            // The stored crop fractions map the chosen region onto the whole tile — the same
            // arithmetic `ImageOverlay.tsx` uses, so a tile and the editor agree on the framing.
            // Only images carry a crop; a poster or thumbnail arrives already framed.
            style={material.type === 'image' && material.crop ? {
              position: 'absolute',
              width:  `${(1 / (material.crop.w || 1)) * 100}%`,
              height: `${(1 / (material.crop.h || 1)) * 100}%`,
              left:   `${(-material.crop.x / (material.crop.w || 1)) * 100}%`,
              top:    `${(-material.crop.y / (material.crop.h || 1)) * 100}%`,
              objectFit: 'fill',
              display: 'block',
            } : { width: '100%', height: '100%', objectFit: portraitBanner ? 'contain' : 'cover', display: 'block' }}
          />
        ) : (
          // On a chip, not bare over the gradient: `text-primary-foreground` is near-invisible on
          // the light theme's paler gradient stops. `bg-background/30` + `text-foreground/80`
          // track the theme, so the glyph reads over every TOKEN_GRADIENTS entry in both modes.
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/30 text-foreground/80">
              <TypeGlyph type={material.type} />
            </span>
          </span>
        )}
        {/* No scrim: the caption is a sibling BELOW the image span, so a gradient here darkened
            the poster's bottom half while protecting no text at all. */}
      </span>

      <span className="flex min-h-0 flex-col gap-0.5 px-3 py-2.5">
        <span className="truncate text-sm font-semibold text-card-foreground" title={material.name}>
          {material.name}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {TYPE_LABEL[material.type]}
          {duration ? ` · ${duration}` : ''}
          {material.type === 'image' && material.width && material.height
            ? ` · ${material.width}×${material.height}`
            : ''}
        </span>
      </span>
    </button>
  );
}
