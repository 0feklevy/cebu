'use client';

// Per-video "Avatar circles" settings — Phase 1.
// Configures the 1–2 audio-reactive avatar circles shown in the bottom corners
// during b-roll sections: which speaker drives each, the face image (uploaded or
// captured + circularly cropped from the video), and the radial-visualizer style.
// (The bars animate in Phase 2; here we save the style + render a static preview.)

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, Loader2, Pause, Play, Upload } from 'lucide-react';
import { auth } from '../../lib/firebase';
import {
  getAvatarCircles, saveAvatarCircles, uploadCircleFace,
  type AvatarCirclesConfig, type AvatarCircleFace,
} from './avatarApi';
import { AvatarCircleViz, type CircleFrame } from '../viewer/AvatarCircleViz';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

const DEFAULT_CONFIG: AvatarCirclesConfig = {
  enabled: false,
  count: 2,
  faces: [
    { speaker: 'host_a', side: 'left' },
    { speaker: 'host_b', side: 'right' },
  ],
  barStyle: 'bars',
  numberOfBars: 240,
  sensitivity: 0.2,
  barWidth: 12,
  innerRadius: 118,
  smoothness: 0.72,
  minHeight: 5,
  maxHeight: 180,
  rotationOffset: 180,
  lowFreqCutPct: 0,
  highFreqCutPct: 92,
  colorMode: 'gradient',
  barColor: '#a855f7',
  gradientEnd: '#6366f1',
  background: '#0f172a',
  roundedBars: true,
  circleSize: 128,
  showCenterCircle: true,
};

function facesFor(cfg: AvatarCirclesConfig): AvatarCircleFace[] {
  const base = cfg.faces?.length ? cfg.faces : DEFAULT_CONFIG.faces!;
  if (cfg.count === 1) return [base.find((f) => f.side === 'left') ?? { speaker: 'host_a', side: 'left' }];
  const left = base.find((f) => f.side === 'left') ?? { speaker: 'host_a', side: 'left' };
  const right = base.find((f) => f.side === 'right') ?? { speaker: 'host_b', side: 'right' };
  return [left, right];
}

interface Props { projectId: string; duration: number; onClose: () => void; }

export function AvatarCirclesSettings({ projectId, duration, onClose }: Props) {
  const [cfg, setCfg] = useState<AvatarCirclesConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [capturing, setCapturing] = useState<'left' | 'right' | null>(null);
  const [uploadingSide, setUploadingSide] = useState<'left' | 'right' | null>(null);
  const [playing, setPlaying] = useState(true);   // preview animates by default (fake audio)

  useEffect(() => {
    getAvatarCircles(projectId)
      .then((r) => { if (r.config) setCfg({ ...DEFAULT_CONFIG, ...r.config, faces: r.config.faces ?? DEFAULT_CONFIG.faces }); })
      .finally(() => setLoading(false));
  }, [projectId]);

  const patch = (p: Partial<AvatarCirclesConfig>) => setCfg((c) => ({ ...c, ...p }));
  const patchFace = useCallback((side: 'left' | 'right', p: Partial<AvatarCircleFace>) => {
    setCfg((c) => ({ ...c, faces: facesFor(c).map((f) => (f.side === side ? { ...f, ...p } : f)) }));
  }, []);

  const onUploadFile = async (side: 'left' | 'right', file: File) => {
    setUploadingSide(side);
    try { const { url } = await uploadCircleFace(projectId, file, file.name); patchFace(side, { imageUrl: url }); }
    catch (e) { alert((e as Error).message); }
    finally { setUploadingSide(null); }
  };

  const onCapture = async (side: 'left' | 'right', blob: Blob) => {
    setUploadingSide(side);
    try { const { url } = await uploadCircleFace(projectId, blob, 'capture.png'); patchFace(side, { imageUrl: url }); }
    catch (e) { alert((e as Error).message); }
    finally { setUploadingSide(null); setCapturing(null); }
  };

  const save = async () => {
    setSaving(true);
    try { await saveAvatarCircles(projectId, { ...cfg, faces: facesFor(cfg) }); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e) { alert((e as Error).message); }
    finally { setSaving(false); }
  };

  const faces = facesFor(cfg);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 6, display: 'flex', flexDirection: 'column', background: '#fff', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div style={{ flexShrink: 0, padding: '14px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onClose} style={iconBtn} title="Back"><ArrowLeft size={16} /></button>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Avatar circles</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>shown in the bottom corners during b-roll</span>
        <div style={{ flex: 1 }} />
        <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 className="animate-spin" /></div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* LEFT: enable + faces + preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label style={rowBetween}>
              <span style={labelStrong}>Enable avatar circles</span>
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} style={{ width: 18, height: 18 }} />
            </label>

            <div style={rowBetween}>
              <span style={labelStrong}>Number of circles</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {[1, 2].map((n) => (
                  <button key={n} onClick={() => patch({ count: n as 1 | 2 })}
                    style={{ ...pill, ...(cfg.count === n ? pillActive : {}) }}>{n}</button>
                ))}
              </div>
            </div>

            {/* Face cards */}
            {faces.map((f) => (
              <div key={f.side} style={card}>
                <div style={rowBetween}>
                  <span style={labelStrong}>{f.side === 'left' ? 'Left circle' : 'Right circle'}</span>
                  <select value={f.speaker} onChange={(e) => patchFace(f.side, { speaker: e.target.value as 'host_a' | 'host_b' })} style={select}>
                    <option value="host_a">Speaker A</option>
                    <option value="host_b">Speaker B</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 }}>
                  <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', background: '#0f172a', flexShrink: 0, border: '2px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {f.imageUrl ? <img src={f.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={20} color="#64748b" />}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    <label style={{ ...ghostBtn, justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
                      {uploadingSide === f.side ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Upload image
                      <input type="file" accept="image/*" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                        onChange={(e) => { const file = e.target.files?.[0]; if (file) onUploadFile(f.side, file); e.currentTarget.value = ''; }} />
                    </label>
                    <button style={ghostBtn} onClick={() => setCapturing(f.side)}><Camera size={13} /> Capture from video</button>
                    <input value={f.label ?? ''} onChange={(e) => patchFace(f.side, { label: e.target.value })} placeholder="Name (optional)" style={input} />
                  </div>
                </div>
              </div>
            ))}

            {/* Live preview — Play to see the animation (fake audio, no sound). */}
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: cfg.background ?? '#0f172a' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 11 }}>b-roll preview</div>
                {faces.map((f) => {
                  const psize = Math.max(40, Math.min(96, (cfg.circleSize ?? 128) * 0.42));
                  const pframe = Math.round(psize * 2.3);
                  const getFrame = (): CircleFrame => {
                    if (!playing) return { spectrum: null, level: 0, running: false };
                    const t = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
                    const activeLeft = Math.floor(t / 2.5) % 2 === 0;             // alternate speaker every 2.5s
                    const isActive = (f.side === 'left') === activeLeft;
                    return { spectrum: null, level: isActive ? 1 : 0.25, running: true };
                  };
                  return (
                    <div key={f.side} style={{ position: 'absolute', bottom: '7%', [f.side === 'left' ? 'left' : 'right']: '5%', width: pframe, height: pframe } as React.CSSProperties}>
                      <AvatarCircleViz config={cfg} face={f} size={psize} frame={pframe} getFrame={getFrame} />
                    </div>
                  );
                })}
                <button
                  onClick={() => setPlaying((p) => !p)}
                  style={{ position: 'absolute', top: 8, left: 8, height: 30, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 8, border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Pause' : 'Play'}
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT: visualizer style controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ ...labelStrong, marginBottom: 2 }}>Radial visualizer frame</span>
            <Num label="Circle size" value={cfg.circleSize ?? 128} min={16} max={400} onChange={(v) => patch({ circleSize: v })} />
            <Num label="Number of bars" value={cfg.numberOfBars ?? 240} min={8} max={512} onChange={(v) => patch({ numberOfBars: v })} />
            <Slider label="Sensitivity" value={cfg.sensitivity ?? 0.2} min={0} max={1} step={0.01} onChange={(v) => patch({ sensitivity: v })} />
            <Num label="Bar width" value={cfg.barWidth ?? 12} min={1} max={64} onChange={(v) => patch({ barWidth: v })} />
            <Num label="Inner radius" value={cfg.innerRadius ?? 118} min={0} max={400} onChange={(v) => patch({ innerRadius: v })} />
            <Slider label="Smoothness" value={cfg.smoothness ?? 0.72} min={0} max={1} step={0.01} onChange={(v) => patch({ smoothness: v })} />
            <Num label="Minimum height" value={cfg.minHeight ?? 5} min={0} max={400} onChange={(v) => patch({ minHeight: v })} />
            <Num label="Maximum height" value={cfg.maxHeight ?? 180} min={1} max={600} onChange={(v) => patch({ maxHeight: v })} />
            <Num label="Rotation offset" value={cfg.rotationOffset ?? 180} min={0} max={360} onChange={(v) => patch({ rotationOffset: v })} />
            <Slider label="Low freq cut %" value={cfg.lowFreqCutPct ?? 0} min={0} max={100} step={1} onChange={(v) => patch({ lowFreqCutPct: v })} />
            <Slider label="High freq cut %" value={cfg.highFreqCutPct ?? 92} min={0} max={100} step={1} onChange={(v) => patch({ highFreqCutPct: v })} />
            <div style={rowBetween}>
              <span style={label}>Color mode</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['solid', 'gradient'] as const).map((m) => (
                  <button key={m} onClick={() => patch({ colorMode: m })} style={{ ...pill, ...(cfg.colorMode === m ? pillActive : {}) }}>{m}</button>
                ))}
              </div>
            </div>
            <Color label="Bar color" value={cfg.barColor ?? '#a855f7'} onChange={(v) => patch({ barColor: v })} />
            {cfg.colorMode === 'gradient' && <Color label="Gradient end" value={cfg.gradientEnd ?? '#6366f1'} onChange={(v) => patch({ gradientEnd: v })} />}
            <Color label="Background" value={cfg.background ?? '#0f172a'} onChange={(v) => patch({ background: v })} />
            <label style={rowBetween}><span style={label}>Rounded bars</span><input type="checkbox" checked={cfg.roundedBars ?? true} onChange={(e) => patch({ roundedBars: e.target.checked })} /></label>
            <label style={rowBetween}><span style={label}>Show center circle</span><input type="checkbox" checked={cfg.showCenterCircle ?? true} onChange={(e) => patch({ showCenterCircle: e.target.checked })} /></label>
          </div>
        </div>
      )}

      {capturing && (
        <FaceCaptureDialog
          projectId={projectId}
          duration={duration}
          onCancel={() => setCapturing(null)}
          onConfirm={(blob) => onCapture(capturing, blob)}
        />
      )}
    </div>
  );
}

// ── Capture a frame from the video + circular crop ──────────────────────────────
function FaceCaptureDialog({ projectId, duration, onCancel, onConfirm }: { projectId: string; duration: number; onCancel: () => void; onConfirm: (b: Blob) => void; }) {
  const [time, setTime] = useState(Math.max(0, Math.min(duration, duration * 0.1)));
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const VIEW = 280;

  const loadFrame = useCallback(async (t: number) => {
    setLoadingFrame(true); setErr(null);
    try {
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      const r = await fetch(`${BASE}/api/v1/projects/${projectId}/frame-preview?time_seconds=${t.toFixed(2)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j as { message?: string }).message ?? `Couldn't load frame (${r.status})`); }
      const blob = await r.blob();
      setImgUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      setScale(1); setOffset({ x: 0, y: 0 });
    } catch (e) { setErr((e as Error).message); }
    finally { setLoadingFrame(false); }
  }, [projectId]);

  useEffect(() => { loadFrame(time); /* initial */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = () => {
    const img = imgRef.current;
    if (!img) return;
    const out = 512;
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // circular clip
    ctx.beginPath(); ctx.arc(out / 2, out / 2, out / 2, 0, Math.PI * 2); ctx.clip();
    // base "cover" scale of the image into the viewport, then user scale
    const cover = Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight);
    const s = cover * scale * (out / VIEW);
    const dw = img.naturalWidth * s;
    const dh = img.naturalHeight * s;
    const dx = (out - dw) / 2 + offset.x * (out / VIEW);
    const dy = (out - dh) / 2 + offset.y * (out / VIEW);
    ctx.drawImage(img, dx, dy, dw, dh);
    canvas.toBlob((b) => { if (b) onConfirm(b); }, 'image/png');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 18, width: 'min(360px, calc(100vw - 32px))', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Capture avatar face</span>
        <div
          style={{ position: 'relative', width: VIEW, height: VIEW, margin: '0 auto', borderRadius: '50%', overflow: 'hidden', background: '#0f172a', cursor: 'grab', touchAction: 'none' }}
          onPointerDown={(e) => { dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (dragRef.current) setOffset({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }); }}
          onPointerUp={() => { dragRef.current = null; }}
        >
          {imgUrl && (
            <img ref={imgRef} src={imgUrl} alt="" draggable={false}
              style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%,-50%) translate(${offset.x}px,${offset.y}px) scale(${scale})`, minWidth: '100%', minHeight: '100%', objectFit: 'cover', userSelect: 'none' }} />
          )}
          {loadingFrame && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 className="animate-spin" color="#fff" /></div>}
          {!imgUrl && !loadingFrame && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, color: '#cbd5e1', fontSize: 12 }}>{err ?? 'Move the time slider to load a frame'}</div>}
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', boxShadow: '0 0 0 9999px rgba(0,0,0,0.0), inset 0 0 0 2px rgba(255,255,255,0.7)', pointerEvents: 'none' }} />
        </div>
        {err && <span style={{ fontSize: 11, color: '#dc2626', textAlign: 'center' }}>{err}</span>}
        <Slider label="Zoom" value={scale} min={1} max={3} step={0.01} onChange={setScale} />
        <div>
          <div style={{ ...rowBetween, marginBottom: 4 }}><span style={label}>Time</span><span style={{ fontSize: 12, color: '#a855f7', fontWeight: 700 }}>{time.toFixed(1)}s</span></div>
          <input type="range" min={0} max={Math.max(1, duration)} step={0.1} value={time}
            onChange={(e) => setTime(Number(e.target.value))} onMouseUp={() => loadFrame(time)} onTouchEnd={() => loadFrame(time)} style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{ ...ghostBtn, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={confirm} style={{ ...primaryBtn, flex: 1, justifyContent: 'center' }}>Use this</button>
        </div>
      </div>
    </div>
  );
}

// ── tiny styled controls ────────────────────────────────────────────────────────
function Num({ label: l, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; }) {
  return (
    <div style={rowBetween}>
      <span style={label}>{l}</span>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} style={{ ...input, width: 80, textAlign: 'right' }} />
    </div>
  );
}
function Slider({ label: l, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; }) {
  return (
    <div>
      <div style={{ ...rowBetween, marginBottom: 2 }}><span style={label}>{l}</span><span style={{ fontSize: 11, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{value}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
    </div>
  );
}
function Color({ label: l, value, onChange }: { label: string; value: string; onChange: (v: string) => void; }) {
  return (
    <div style={rowBetween}>
      <span style={label}>{l}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 40, height: 26, border: '1px solid #e2e8f0', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
    </div>
  );
}

const label: React.CSSProperties = { fontSize: 12, color: '#475569', fontWeight: 600 };
const labelStrong: React.CSSProperties = { fontSize: 13, color: '#0f172a', fontWeight: 700 };
const rowBetween: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#f8fafc' };
const input: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 8px', fontSize: 12, color: '#0f172a', outline: 'none' };
const select: React.CSSProperties = { ...input, cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid #e2e8f0', background: '#fff', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' };
const pillActive: React.CSSProperties = { background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff', border: '1px solid transparent' };
const iconBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 16px', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
