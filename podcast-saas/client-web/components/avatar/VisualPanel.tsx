'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { VisualResult } from './avatarApi';
import { DiagramRenderer } from './renderers/DiagramRenderer';

/**
 * katex and chart.js load ONLY when a visual of that kind is actually shown (performance-009).
 *
 * These two were imported at module scope, and this module is reached from `AvatarConversation`,
 * which every public viewer route renders. So ~465 KB of parser and charting library sat in the
 * INITIAL JavaScript of `/[slug]` and `/v/[shareToken]` — paid for by every viewer, including the
 * overwhelming majority who never open the avatar, and of those who do, the ones who never see an
 * equation or a chart.
 *
 * `ssr: false` because both renderers are imperative and browser-only: they write into a ref in
 * `useEffect` (katex) or construct a Chart against a canvas (chart.js). Neither produces server
 * markup worth having, and asking for it would only add a hydration boundary to reconcile.
 *
 * DiagramRenderer stays a static import deliberately — it is a plain iframe with an inline script
 * and pulls in no library, so deferring it would add a chunk request to save nothing.
 */
const EquationRenderer = dynamic(
  () => import('./renderers/EquationRenderer').then((m) => m.EquationRenderer),
  { ssr: false, loading: () => <div className="avatar-visual-panel__loading" aria-hidden /> },
);

const ChartRenderer = dynamic(
  () => import('./renderers/ChartRenderer').then((m) => m.ChartRenderer),
  { ssr: false, loading: () => <div className="avatar-visual-panel__loading" aria-hidden /> },
);

interface Props {
  visual: VisualResult;
  visible: boolean;
  onDismiss: () => void;
}

// Corner popup for fast visuals (equation / chart / diagram / image). Ported from
// darwin-avatar/client/src/components/VisualPanel.tsx.
export function VisualPanel({ visual, visible, onDismiss }: Props) {
  const caption = visual.type !== 'none' ? (visual as { caption?: string }).caption ?? '' : '';
  const [diagramHeight, setDiagramHeight] = useState(320);

  useEffect(() => { setDiagramHeight(320); }, [visual]);

  useEffect(() => {
    if (visual.type !== 'diagram') return;
    const handler = (e: MessageEvent) => {
      const d = e.data as { type?: string; height?: number };
      if (d && d.type === 'DIAGRAM_HEIGHT' && typeof d.height === 'number') setDiagramHeight(d.height);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [visual.type]);

  const clampedDiagramHeight = typeof window !== 'undefined' ? Math.min(diagramHeight, window.innerHeight - 160) : diagramHeight;

  return (
    <div
      className={`avatar-visual-panel${visible ? ' avatar-visual-panel--visible' : ''}`}
      style={visual.type === 'diagram' ? { height: clampedDiagramHeight + 96, maxHeight: 'calc(100% - 24px)', overflow: 'hidden' } : undefined}
    >
      <button className="avatar-visual-panel__close" onClick={onDismiss} aria-label="Close visual">✕</button>

      <div className="avatar-visual-panel__content" style={visual.type === 'diagram' ? { padding: 0, overflow: 'hidden' } : undefined}>
        {visual.type === 'equation' && (
          <div className="avatar-visual-panel__equation"><EquationRenderer latex={visual.latex} /></div>
        )}
        {visual.type === 'chart' && (
          <div className="avatar-visual-panel__chart">
            <ChartRenderer chartType={visual.chartType} title={visual.title} labels={visual.labels} datasets={visual.datasets} height={320} />
          </div>
        )}
        {visual.type === 'diagram' && (
          <div className="avatar-visual-panel__diagram"><DiagramRenderer html={visual.html} iframeHeight={clampedDiagramHeight} /></div>
        )}
        {visual.type === 'image_ready' && (
          <img src={(visual as { imageUrl: string }).imageUrl} alt={caption} style={{ width: '100%', borderRadius: 8, display: 'block' }} />
        )}
        {(visual.type === 'image_loading' || visual.type === 'image') && (
          <div className="avatar-visual-panel__image-loading">
            <div className="avatar-image-shimmer" />
            <p className="avatar-image-shimmer__text">Generating image…</p>
          </div>
        )}
      </div>

      {caption && <div className="avatar-visual-panel__caption"><p>{caption}</p></div>}
    </div>
  );
}
