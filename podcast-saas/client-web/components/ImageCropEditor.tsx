'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ImageFile } from 'shared/src/generated/client-v1';

interface Props {
  image: ImageFile;
  onApprove: (crop: { crop_x: number; crop_y: number; crop_w: number; crop_h: number }) => void;
  onCancel: () => void;
}

const TARGET_RATIO = 16 / 9;

// Given the natural image dimensions, compute the largest centered 16:9 crop (in 0–1 fractions).
function defaultCrop(w: number, h: number): { cx: number; cy: number; cw: number; ch: number } {
  const imgRatio = w / h;
  if (imgRatio > TARGET_RATIO) {
    // Image is wider than 16:9 → letterbox sides, crop width
    const cw = (TARGET_RATIO * h) / w;
    return { cx: (1 - cw) / 2, cy: 0, cw, ch: 1 };
  } else {
    // Image is taller than 16:9 → pillarbox top/bottom, crop height
    const ch = (w / TARGET_RATIO) / h;
    return { cx: 0, cy: (1 - ch) / 2, cw: 1, ch };
  }
}

export function ImageCropEditor({ image, onApprove, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef       = useRef<HTMLImageElement>(null);

  const [naturalW, setNaturalW] = useState(image.width  ?? 0);
  const [naturalH, setNaturalH] = useState(image.height ?? 0);

  // Crop state as fractions of the DISPLAYED image element size
  const [cx, setCx] = useState(image.crop_x);
  const [cy, setCy] = useState(image.crop_y);
  const [cw, setCw] = useState(image.crop_w);
  const [ch, setCh] = useState(image.crop_h);

  // When the image loads and we know its natural size, set the default 16:9 crop
  const handleLoad = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const nw = el.naturalWidth;
    const nh = el.naturalHeight;
    setNaturalW(nw);
    setNaturalH(nh);
    // Only auto-set if we had no stored crop yet (i.e. crop_w === 1 at original upload)
    if (image.crop_w === 1 && image.crop_h === 1) {
      const d = defaultCrop(nw, nh);
      setCx(d.cx); setCy(d.cy); setCw(d.cw); setCh(d.ch);
    }
  }, [image.crop_w, image.crop_h]);

  // Drag state
  const dragRef = useRef<{
    startX: number; startY: number;
    startCx: number; startCy: number;
  } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startCx: cx,
      startCy: cy,
    };
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current || !el) return;
      const r2 = el.getBoundingClientRect();
      const dx = (me.clientX - dragRef.current.startX) / r2.width;
      const dy = (me.clientY - dragRef.current.startY) / r2.height;
      setCx(Math.max(0, Math.min(1 - cw, dragRef.current.startCx + dx)));
      setCy(Math.max(0, Math.min(1 - ch, dragRef.current.startCy + dy)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    void r; // prevent unused warning
  };

  // Preview: show cropped result at 16:9 in a small box
  const previewStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    paddingTop: '56.25%', // 16:9
    overflow: 'hidden',
    borderRadius: 8,
    background: '#000',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
        Drag the blue crop box to choose the 16:9 region. The dashed area will be cropped out.
      </p>

      {/* Main crop editor: full image with overlay */}
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', userSelect: 'none' }}
      >
        <img
          ref={imgRef}
          src={image.original_url}
          onLoad={handleLoad}
          alt="Crop source"
          draggable={false}
          style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 6 }}
        />

        {/* Dimming overlay outside crop region */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'rgba(0,0,0,0.55)',
          clipPath: `polygon(
            0% 0%, 100% 0%, 100% 100%, 0% 100%,
            0% 0%,
            ${cx * 100}% ${cy * 100}%,
            ${cx * 100}% ${(cy + ch) * 100}%,
            ${(cx + cw) * 100}% ${(cy + ch) * 100}%,
            ${(cx + cw) * 100}% ${cy * 100}%,
            ${cx * 100}% ${cy * 100}%
          )`,
        }} />

        {/* Draggable crop box */}
        <div
          onMouseDown={onMouseDown}
          style={{
            position: 'absolute',
            left:   `${cx * 100}%`,
            top:    `${cy * 100}%`,
            width:  `${cw * 100}%`,
            height: `${ch * 100}%`,
            border: '2px solid #3b82f6',
            boxSizing: 'border-box',
            cursor: 'move',
            borderRadius: 2,
          }}
        >
          {/* Rule-of-thirds grid lines */}
          {[1/3, 2/3].map((f) => (
            <div key={`h${f}`} style={{
              position: 'absolute', left: 0, right: 0,
              top: `${f * 100}%`, height: 1,
              background: 'rgba(255,255,255,0.3)', pointerEvents: 'none',
            }} />
          ))}
          {[1/3, 2/3].map((f) => (
            <div key={`v${f}`} style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${f * 100}%`, width: 1,
              background: 'rgba(255,255,255,0.3)', pointerEvents: 'none',
            }} />
          ))}
          {/* Corner handles */}
          {[[0,0],[0,100],[100,0],[100,100]].map(([l,t]) => (
            <div key={`${l}${t}`} style={{
              position: 'absolute',
              left: `${l}%`, top: `${t}%`,
              transform: 'translate(-50%,-50%)',
              width: 10, height: 10,
              background: '#3b82f6', borderRadius: 2,
              pointerEvents: 'none',
            }} />
          ))}
        </div>
      </div>

      {/* 16:9 preview */}
      <div>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 4px' }}>16:9 preview</p>
        <div style={previewStyle}>
          <img
            src={image.original_url}
            alt="Crop preview"
            draggable={false}
            style={{
              position: 'absolute',
              // Scale so the crop region fills exactly the preview box
              width:  `${(1 / cw) * 100}%`,
              height: `${(1 / ch) * 100}%`,
              left:   `${(-cx / cw) * 100}%`,
              top:    `${(-cy / ch) * 100}%`,
              objectFit: 'fill',
            }}
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '6px 14px', borderRadius: 7, border: '1px solid #e5e7eb',
            background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151',
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => onApprove({ crop_x: cx, crop_y: cy, crop_w: cw, crop_h: ch })}
          style={{
            padding: '6px 14px', borderRadius: 7, border: 'none',
            background: '#3b82f6', color: '#fff', fontSize: 12,
            fontWeight: 700, cursor: 'pointer',
          }}
        >
          Use this crop
        </button>
      </div>
    </div>
  );
}
