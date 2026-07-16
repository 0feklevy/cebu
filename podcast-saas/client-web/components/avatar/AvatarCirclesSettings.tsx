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

const BASE = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

const DEFAULT_CONFIG: AvatarCirclesConfig = {
  enabled: false,
  visibility: 'broll',
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
  circleOpacity: 1,
  circleLayout: 'corners',
  circleSideInsetPct: 3,
  circleBottomPct: 4,
  circleGapPct: 4,
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
  const [isCompactPanel, setIsCompactPanel] = useState(false);

  useEffect(() => {
    getAvatarCircles(projectId)
      .then((r) => { if (r.config) setCfg({ ...DEFAULT_CONFIG, ...r.config, faces: r.config.faces ?? DEFAULT_CONFIG.faces }); })
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 900px), (max-height: 680px)');
    const sync = () => setIsCompactPanel(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

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
    try {
      await saveAvatarCircles(projectId, { ...cfg, faces: facesFor(cfg) });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
      // Notify the editor preview (a sibling component with no shared state) to
      // re-read the config so it reflects the new enabled/style without a reload.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('avatar-circles-saved', { detail: { projectId } }));
      }
    }
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
        <div style={settingsShell(isCompactPanel)}>
          <aside style={settingsAside(isCompactPanel)}>
            <section style={sectionPanel}>
              <div style={rowBetween}>
                <span style={labelStrong}>Show avatar circles</span>
                <div style={segmented}>
                  {(() => {
                    const mode = !cfg.enabled ? 'none' : (cfg.visibility ?? 'broll');
                    return ([['broll', 'During b-roll'], ['always', 'Always'], ['none', 'None']] as const).map(([m, txt]) => (
                      <button key={m}
                        onClick={() => patch(m === 'none' ? { enabled: false } : { enabled: true, visibility: m })}
                        style={{ ...pill, ...(mode === m ? pillActive : {}) }}>{txt}</button>
                    ));
                  })()}
                </div>
              </div>

              <div style={rowBetween}>
                <span style={labelStrong}>Number of circles</span>
                <div style={segmented}>
                  {[1, 2].map((n) => (
                    <button key={n} onClick={() => patch({ count: n as 1 | 2 })}
                      style={{ ...pill, ...(cfg.count === n ? pillActive : {}) }}>{n}</button>
                  ))}
                </div>
              </div>
            </section>

            <section style={sectionPanel}>
              <div style={sectionHeader}>
                <span style={labelStrong}>Placement</span>
              </div>
              <div style={rowBetween}>
                <span style={label}>Layout</span>
                <div style={segmented}>
                  {([
                    ['corners', 'Corners'],
                    ['right-stack', 'Stack right'],
                  ] as const).map(([m, txt]) => (
                    <button key={m} onClick={() => patch({ circleLayout: m })}
                      style={{ ...pill, ...((cfg.circleLayout ?? 'corners') === m ? pillActive : {}) }}>{txt}</button>
                  ))}
                </div>
              </div>
              <RangeNumber label="Opacity" value={cfg.circleOpacity ?? 1} min={0} max={1} step={0.01} onChange={(v) => patch({ circleOpacity: v })} />
              <RangeNumber label="Side inset" value={cfg.circleSideInsetPct ?? 3} min={0} max={45} step={1} suffix="%" onChange={(v) => patch({ circleSideInsetPct: v })} />
              <RangeNumber label="Bottom offset" value={cfg.circleBottomPct ?? 4} min={0} max={70} step={1} suffix="%" onChange={(v) => patch({ circleBottomPct: v })} />
              <RangeNumber label="Stack gap" value={cfg.circleGapPct ?? 4} min={0} max={20} step={1} suffix="%" onChange={(v) => patch({ circleGapPct: v })} />
            </section>

            <section style={sectionPanel}>
              <div style={sectionHeader}>
                <span style={labelStrong}>Radial visualizer frame</span>
              </div>
              <div style={controlStack}>
                <RangeNumber label="Circle size" value={cfg.circleSize ?? 128} min={16} max={220} step={1} onChange={(v) => patch({ circleSize: v })} />
                <RangeNumber label="Number of bars" value={cfg.numberOfBars ?? 240} min={8} max={512} step={1} onChange={(v) => patch({ numberOfBars: Math.round(v) })} />
                <RangeNumber label="Sensitivity" value={cfg.sensitivity ?? 0.2} min={0} max={1} step={0.01} onChange={(v) => patch({ sensitivity: v })} />
                <RangeNumber label="Bar width" value={cfg.barWidth ?? 12} min={1} max={64} step={1} onChange={(v) => patch({ barWidth: v })} />
                <RangeNumber label="Inner radius" value={cfg.innerRadius ?? 118} min={0} max={400} step={1} onChange={(v) => patch({ innerRadius: v })} />
                <RangeNumber label="Smoothness" value={cfg.smoothness ?? 0.72} min={0} max={1} step={0.01} onChange={(v) => patch({ smoothness: v })} />
                <RangeNumber label="Minimum height" value={cfg.minHeight ?? 5} min={0} max={400} step={1} onChange={(v) => patch({ minHeight: v })} />
                <RangeNumber label="Maximum height" value={cfg.maxHeight ?? 180} min={1} max={600} step={1} onChange={(v) => patch({ maxHeight: v })} />
                <RangeNumber label="Rotation offset" value={cfg.rotationOffset ?? 180} min={0} max={360} step={1} onChange={(v) => patch({ rotationOffset: v })} />
                <RangeNumber label="Low freq cut" value={cfg.lowFreqCutPct ?? 0} min={0} max={100} step={1} suffix="%" onChange={(v) => patch({ lowFreqCutPct: v })} />
                <RangeNumber label="High freq cut" value={cfg.highFreqCutPct ?? 92} min={0} max={100} step={1} suffix="%" onChange={(v) => patch({ highFreqCutPct: v })} />
              </div>
            </section>

            <section style={sectionPanel}>
              <div style={optionStack}>
                <div style={optionTile}>
                  <span style={label}>Color mode</span>
                  <div style={segmented}>
                    {(['solid', 'gradient'] as const).map((m) => (
                      <button key={m} onClick={() => patch({ colorMode: m })} style={{ ...pill, ...(cfg.colorMode === m ? pillActive : {}) }}>{m}</button>
                    ))}
                  </div>
                </div>
                <Color label="Bar color" value={cfg.barColor ?? '#a855f7'} onChange={(v) => patch({ barColor: v })} />
                {cfg.colorMode === 'gradient' && <Color label="Gradient end" value={cfg.gradientEnd ?? '#6366f1'} onChange={(v) => patch({ gradientEnd: v })} />}
                <Color label="Background" value={cfg.background ?? '#0f172a'} onChange={(v) => patch({ background: v })} />
                <Toggle label="Rounded bars" checked={cfg.roundedBars ?? true} onChange={(v) => patch({ roundedBars: v })} />
                <Toggle label="Show center circle" checked={cfg.showCenterCircle ?? true} onChange={(v) => patch({ showCenterCircle: v })} />
              </div>
            </section>
          </aside>

          <section style={demoPane(isCompactPanel)}>
            <div style={demoHeader}>
              {faces.map((f) => (
                <div key={f.side} style={faceHeadCard}>
                  <div style={faceHeadPreview}>
                    {f.imageUrl ? <img src={f.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={18} color="#64748b" />}
                  </div>
                  <div style={faceHeadBody}>
                    <div style={faceHeadTop}>
                      <span style={labelStrong}>{f.side === 'left' ? 'Left circle' : 'Right circle'}</span>
                      <select value={f.speaker} onChange={(e) => patchFace(f.side, { speaker: e.target.value as 'host_a' | 'host_b' })} style={faceSelect}>
                        <option value="host_a">Speaker A</option>
                        <option value="host_b">Speaker B</option>
                      </select>
                    </div>
                    <div style={faceActionRow}>
                      <label style={{ ...faceActionBtn, position: 'relative' }}>
                        {uploadingSide === f.side ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Upload image
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={(e) => { const file = e.target.files?.[0]; if (file) onUploadFile(f.side, file); e.currentTarget.value = ''; }} />
                      </label>
                      <button style={faceActionBtn} onClick={() => setCapturing(f.side)}><Camera size={13} /> Capture from video</button>
                    </div>
                    <input value={f.label ?? ''} onChange={(e) => patchFace(f.side, { label: e.target.value })} placeholder="Name (optional)" style={faceNameInput} />
                  </div>
                </div>
              ))}
            </div>
            <div style={demoSurface}>
              <div style={demoFrame}>
                <button
                  onClick={() => setPlaying((p) => !p)}
                  style={demoPlayFloating}
                >
                  {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Pause' : 'Play'}
                </button>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 11 }}>b-roll preview</div>
                <div style={previewAsk}>Ask!</div>
                {faces.map((f, index) => {
                  const previewStack = (cfg.circleLayout ?? 'corners') === 'right-stack';
                  const psize = previewStack && faces.length > 1
                    ? Math.max(30, Math.min(58, (cfg.circleSize ?? 128) * 0.3))
                    : Math.max(36, Math.min(92, (cfg.circleSize ?? 128) * 0.42));
                  const pframe = Math.round(psize * 2.3);
                  const sideInset = `${cfg.circleSideInsetPct ?? 3}%`;
                  const bottomOffset = `${cfg.circleBottomPct ?? 4}%`;
                  const bottom = previewStack
                    ? `calc(max(${bottomOffset}, 58px) + ${index * (pframe + 10)}px)`
                    : (faces.length > 1 && f.side === 'right')
                      ? `max(${bottomOffset}, 58px)`
                      : bottomOffset;
                  const posStyle: React.CSSProperties = previewStack
                    ? { right: sideInset }
                    : f.side === 'left'
                      ? { left: sideInset }
                      : { right: sideInset };
                  const getFrame = (): CircleFrame => {
                    if (!playing) return { spectrum: null, level: 0, running: false };
                    const t = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
                    const activeLeft = Math.floor(t / 2.5) % 2 === 0;             // alternate speaker every 2.5s
                    const isActive = (f.side === 'left') === activeLeft;
                    return { spectrum: null, level: isActive ? 1 : 0.25, running: true };
                  };
                  return (
                    <div key={f.side} style={{ position: 'absolute', bottom, width: pframe, height: pframe, opacity: cfg.circleOpacity ?? 1, ...posStyle }}>
                      <AvatarCircleViz config={cfg} face={f} size={psize} frame={pframe} getFrame={getFrame} />
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
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
      setImgUrl(URL.createObjectURL(blob)); // previous URL revoked by the cleanup effect below
      setScale(1); setOffset({ x: 0, y: 0 });
    } catch (e) { setErr((e as Error).message); }
    finally { setLoadingFrame(false); }
  }, [projectId]);

  useEffect(() => { loadFrame(time); /* initial */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke the object URL when it changes or on unmount, so loading new frames and
  // cancelling the dialog mid-capture don't leak blob URLs.
  useEffect(() => {
    return () => { if (imgUrl) URL.revokeObjectURL(imgUrl); };
  }, [imgUrl]);

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
function RangeNumber({ label: l, value, min, max, step, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (v: number) => void; }) {
  const precision = step < 1 ? Math.ceil(Math.abs(Math.log10(step))) : 0;
  const display = `${precision ? value.toFixed(precision) : Math.round(value)}${suffix}`;
  const commit = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(Math.min(max, Math.max(min, next)));
  };
  return (
    <div style={controlTile}>
      <div style={{ ...rowBetween, marginBottom: 7 }}>
        <span style={label}>{l}</span>
        <span style={valueBadge}>{display}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 76px', gap: 8, alignItems: 'center' }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => commit(e.target.value)} style={{ width: '100%', accentColor: '#6366f1' }} />
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => commit(e.target.value)} style={{ ...input, width: '100%', textAlign: 'right' }} />
      </div>
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
    <div style={optionTile}>
      <span style={label}>{l}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, border: '1px solid #cbd5e1', background: value, display: 'inline-block' }} />
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 28, border: '1px solid #e2e8f0', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
      </div>
    </div>
  );
}

function Toggle({ label: l, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void; }) {
  return (
    <label style={{ ...optionTile, cursor: 'pointer' }}>
      <span style={label}>{l}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#6366f1', cursor: 'pointer' }} />
    </label>
  );
}

const label: React.CSSProperties = { fontSize: 12, color: '#475569', fontWeight: 600 };
const labelStrong: React.CSSProperties = { fontSize: 13, color: '#0f172a', fontWeight: 700 };
const rowBetween: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const input: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 8px', fontSize: 12, color: '#0f172a', outline: 'none' };
const select: React.CSSProperties = { ...input, cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid #dbe3ef', background: '#fff', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' };
const pillActive: React.CSSProperties = { background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff', border: '1px solid transparent' };
const iconBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 16px', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const settingsShell = (compact: boolean): React.CSSProperties => ({
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: compact ? 'column' : 'row',
  background: '#f8fafc',
});
const settingsAside = (compact: boolean): React.CSSProperties => ({
  width: compact ? '100%' : 470,
  maxHeight: compact ? '52dvh' : undefined,
  flexShrink: 0,
  overflowY: 'auto',
  padding: compact ? 14 : '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  borderRight: compact ? 'none' : '1px solid #e2e8f0',
  borderBottom: compact ? '1px solid #e2e8f0' : 'none',
  background: '#f8fafc',
  boxSizing: 'border-box',
});
const demoPane = (compact: boolean): React.CSSProperties => ({
  flex: 1,
  minHeight: compact ? 280 : 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: '#ffffff',
});
const sectionPanel: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#fff', boxShadow: '0 1px 2px rgba(15,23,42,0.04)', display: 'flex', flexDirection: 'column', gap: 12 };
const sectionHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 };
const segmented: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' };
const faceActionRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 };
const controlStack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const controlTile: React.CSSProperties = { border: '1px solid #edf2f7', borderRadius: 8, background: '#f8fafc', padding: 10, minWidth: 0 };
const optionStack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const optionTile: React.CSSProperties = { border: '1px solid #edf2f7', borderRadius: 8, background: '#f8fafc', padding: '10px 11px', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const valueBadge: React.CSSProperties = { fontSize: 11, color: '#4f46e5', fontWeight: 800, fontVariantNumeric: 'tabular-nums' };
const demoHeader: React.CSSProperties = { flexShrink: 0, padding: 14, borderBottom: '1px solid #e2e8f0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, background: '#fff' };
const demoSurface: React.CSSProperties = { flex: 1, minHeight: 0, padding: 18, background: '#eef2f7', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const demoFrame: React.CSSProperties = { position: 'relative', width: 'min(100%, 820px)', aspectRatio: '16/9', maxHeight: '100%', background: '#0f172a', borderRadius: 8, overflow: 'hidden', boxShadow: '0 18px 46px rgba(15,23,42,0.18)' };
const faceHeadCard: React.CSSProperties = { minWidth: 0, border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#f8fafc', display: 'grid', gridTemplateColumns: '58px minmax(0, 1fr)', gap: 10, alignItems: 'start', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' };
const faceHeadPreview: React.CSSProperties = { width: 58, height: 58, borderRadius: '50%', overflow: 'hidden', background: '#0f172a', border: '2px solid #fff', boxShadow: '0 3px 10px rgba(15,23,42,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const faceHeadBody: React.CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const faceHeadTop: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 112px', alignItems: 'center', gap: 8 };
const faceSelect: React.CSSProperties = { ...input, height: 30, padding: '0 8px', cursor: 'pointer', fontSize: 11, fontWeight: 700, background: '#fff' };
const faceActionBtn: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', borderRadius: 8, border: '1px solid #dbe3ef', background: '#fff', color: '#475569', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const faceNameInput: React.CSSProperties = { ...input, height: 30, padding: '0 8px', fontSize: 11, background: '#fff' };
const demoPlayFloating: React.CSSProperties = { position: 'absolute', top: 10, left: 10, zIndex: 2, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', backdropFilter: 'blur(8px)' };
const previewAsk: React.CSSProperties = { position: 'absolute', right: 12, bottom: 12, minHeight: 36, padding: '0 14px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 800, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 8px 18px rgba(99,102,241,0.38)' };
