'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Search, ArrowDownUp, X, Maximize2, Pencil, Sparkles, Trash2, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  getProjectLibrary, generateLibraryImage, generateLibrarySimulation,
  patchLibraryVisual, deleteLibraryVisual, editLibrarySimulation, uploadLibraryFiles, type LibraryItem,
} from './avatarApi';
import { EquationRenderer } from './renderers/EquationRenderer';
import { ChartRenderer } from './renderers/ChartRenderer';
import { DiagramRenderer } from './renderers/DiagramRenderer';
import './avatar.css';

interface Props { open: boolean; onClose: () => void; projectId: string; characterId?: string; }

const TYPE_PILLS = [
  { key: '',           label: 'All',         color: '#888',    bg: 'rgba(120,120,120,0.12)', border: '#bbb' },
  { key: 'image',      label: 'Images',      color: '#c2185b', bg: 'rgba(240,98,146,0.15)',  border: '#f06292' },
  { key: 'simulation', label: 'Simulations', color: '#e65100', bg: 'rgba(255,183,77,0.18)',  border: '#ffb74d' },
  { key: 'chart',      label: 'Charts',      color: '#0288d1', bg: 'rgba(79,195,247,0.15)',  border: '#4fc3f7' },
  { key: 'diagram',    label: 'Diagrams',    color: '#388e3c', bg: 'rgba(129,199,132,0.15)', border: '#81c784' },
  { key: 'equation',   label: 'Equations',   color: '#ab47bc', bg: 'rgba(206,147,216,0.15)', border: '#ce93d8' },
];
const TYPE_COLORS: Record<string, string> = { equation: '#ce93d8', chart: '#4fc3f7', diagram: '#81c784', simulation: '#ffb74d', image: '#f06292' };

// Editor-facing gallery (styled to match darwin-avatar's Visual Library) to follow
// & organize the avatar's Library. Basic = assets you put in the video; Extended =
// visuals the avatar generated. Both are preferred over fresh generation at runtime.
export function ExtendedLibraryModal({ open, onClose, projectId, characterId = 'einstein' }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'' | 'basic' | 'extended'>('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'most-used'>('newest');
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<{ tone: 'ok' | 'warn' | 'error'; message: string; details?: string[] } | null>(null);
  const dragDepthRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getProjectLibrary(projectId, { scope: scope || undefined, type: type || undefined, q: q || undefined });
      setItems(res.items);
      setTypeCounts(res.typeCounts);
      setTotal(res.total);
    } finally { setLoading(false); }
  }, [projectId, scope, type, q]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const sorted = useMemo(() => {
    if (sortBy === 'most-used') return [...items].sort((a, b) => b.use_count - a.use_count);
    return items;
  }, [items, sortBy]);

  if (!open) return null;

  const run = async (tag: string, fn: () => Promise<unknown>) => {
    setBusy(tag);
    try { await fn(); await load(); } catch (e) { alert((e as Error).message); } finally { setBusy(null); }
  };
  const doGenImage = () => { const p = window.prompt('Describe the image to generate:'); if (p) run('gen-image', () => generateLibraryImage(projectId, { prompt: p, characterId, scope: 'extended' })); };
  const doGenSim = () => { const p = window.prompt('Describe the interactive simulation to generate:'); if (p) run('gen-sim', () => generateLibrarySimulation(projectId, { prompt: p, characterId, scope: 'extended' })); };
  const doDelete = async (id: string) => { await deleteLibraryVisual(projectId, id); setItems((p) => p.filter((i) => i.id !== id)); setTotal((t) => Math.max(0, t - 1)); };
  const doToggleScope = async (item: LibraryItem) => { const next = item.scope === 'basic' ? 'extended' : 'basic'; await patchLibraryVisual(projectId, item.id, { scope: next }); setItems((p) => p.map((i) => (i.id === item.id ? { ...i, scope: next } : i))); };
  const doEditCaption = async (item: LibraryItem, caption: string) => { await patchLibraryVisual(projectId, item.id, { caption }); setItems((p) => p.map((i) => (i.id === item.id ? { ...i, caption } : i))); };
  const doEditSim = (item: LibraryItem) => { const ins = window.prompt('How should the avatar change this simulation?'); if (ins) run('edit-sim', () => editLibrarySimulation(projectId, item.id, ins)); };
  const isFileDrag = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types).includes('Files');
  const onLibraryDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };
  const onLibraryDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onLibraryDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };
  const onLibraryDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    void handleLibraryFiles(e.dataTransfer.files);
  };
  const handleLibraryFiles = async (rawFiles: FileList | File[]) => {
    const files = Array.from(rawFiles).filter((file) => file.size > 0);
    if (files.length === 0 || uploadingFiles) return;
    setUploadingFiles(true);
    setDropFeedback(null);
    try {
      const res = await uploadLibraryFiles(projectId, files, { characterId, scope: 'extended' });
      await load();
      const types = Array.from(new Set(res.accepted.map((item) => item.visualType)));
      if (res.accepted.length > 0) {
        setScope('extended');
        setType(types.length === 1 ? types[0] : '');
      }
      const rejectedDetails = res.rejected.slice(0, 4).map((item) => `${item.filename}: ${item.reason}`);
      setDropFeedback({
        tone: res.accepted.length > 0 ? (res.rejected.length > 0 ? 'warn' : 'ok') : 'error',
        message: `${res.accepted.length} added${res.rejected.length ? ` · ${res.rejected.length} rejected` : ''}`,
        details: rejectedDetails.length ? rejectedDetails : undefined,
      });
    } catch (e) {
      setDropFeedback({ tone: 'error', message: (e as Error).message || 'Upload failed' });
    } finally {
      setUploadingFiles(false);
    }
  };

  return (
    <div className="avatar-gallery" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="avatar-gallery__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Library"
        onDragEnter={onLibraryDragEnter}
        onDragOver={onLibraryDragOver}
        onDragLeave={onLibraryDragLeave}
        onDrop={onLibraryDrop}
      >
        {/* Header */}
        <div className="avatar-gallery__header">
          <div>
            <h2 className="avatar-gallery__title">Extended (Avatar) Library</h2>
            <p className="avatar-gallery__hint">Basic = this video&apos;s materials (auto-synced) · Extended = the global pool every viewer&apos;s avatar contributes to</p>
          </div>
          <span className="avatar-gallery__count">{total} item{total !== 1 ? 's' : ''}</span>
          <div className="avatar-gallery__create-group">
            <button className="avatar-g-create" onClick={doGenImage} disabled={busy === 'gen-image'}><Sparkles size={13} />{busy === 'gen-image' ? '…' : 'Generate image'}</button>
            <button className="avatar-g-create" onClick={doGenSim} disabled={busy === 'gen-sim'}><Sparkles size={13} />{busy === 'gen-sim' ? '…' : 'Generate simulation'}</button>
          </div>
          <button className="avatar-gallery__close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {(dragOver || uploadingFiles) && (
          <div className={`avatar-gallery-drop-overlay${dragOver ? ' is-over' : ''}${uploadingFiles ? ' is-uploading' : ''}`}>
            <div className="avatar-gallery-drop-target">
              <span className="avatar-gallery-drop-target__icon">
                {uploadingFiles ? <span className="avatar-spinner" /> : <Upload size={24} />}
              </span>
              <p>{uploadingFiles ? 'Organizing files...' : 'Drop files anywhere in the Library'}</p>
              <span>Images, HTML/ZIP simulations, CSV charts, LaTeX equations, or JSON visual specs</span>
            </div>
          </div>
        )}
        {dropFeedback && (
          <div className={`avatar-gallery-feedback is-${dropFeedback.tone}`}>
            {dropFeedback.tone === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{dropFeedback.message}</span>
          </div>
        )}
        {dropFeedback?.details && (
          <div className="avatar-gallery-drop-details">
            {dropFeedback.details.map((detail) => <p key={detail}>{detail}</p>)}
          </div>
        )}

        {/* Filters */}
        <div className="avatar-gallery-filters">
          <div className="avatar-g-search">
            <Search size={15} className="avatar-g-search__icon" />
            <input className="avatar-g-search__input" type="search" placeholder="Search…" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
          </div>
          <div className="avatar-g-tabs">
            {TYPE_PILLS.map((t) => {
              const count = t.key === '' ? total : (typeCounts[t.key] ?? 0);
              const active = type === t.key;
              return (
                <button key={t.key} className={`avatar-g-tab${active ? ' avatar-g-tab--active' : ''}`}
                  style={active ? { background: t.bg, borderColor: t.border, color: t.color } : undefined}
                  onClick={() => setType(t.key)}>
                  {count > 0 && <span className="avatar-g-tab__count" style={{ background: t.color }}>{count}</span>}
                  {t.label}
                </button>
              );
            })}
          </div>
          <select className="avatar-g-select" value={scope} onChange={(e) => setScope(e.target.value as '' | 'basic' | 'extended')}>
            <option value="">All library</option>
            <option value="basic">Basic (this video)</option>
            <option value="extended">Extended (global)</option>
          </select>
          <div className="avatar-g-sort">
            <ArrowDownUp size={13} style={{ color: '#888', flexShrink: 0 }} />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'newest' | 'most-used')}>
              <option value="newest">Newest</option>
              <option value="most-used">Most used</option>
            </select>
          </div>
        </div>

        {/* Body */}
        <div className="avatar-gallery__body">
          {loading ? (
            <div className="avatar-g-empty"><span className="avatar-spinner" /></div>
          ) : sorted.length === 0 ? (
            <div className="avatar-g-empty">No visuals yet. Import your project assets or generate new ones above.</div>
          ) : (
            <div className="avatar-g-grid">
              {sorted.map((item) => (
                <GalleryCard key={item.id} item={item}
                  onDelete={() => doDelete(item.id)} onToggleScope={() => doToggleScope(item)}
                  onEditCaption={(c) => doEditCaption(item, c)} onEditSim={() => doEditSim(item)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Lazy iframe — mounts only when scrolled into view (keeps many sim previews cheap).
function LazyIframe({ src, srcDoc }: { src?: string; srcDoc?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '120px' });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {visible && (
        <iframe src={src} srcDoc={srcDoc} title="preview" sandbox={src ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
          style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none', display: 'block', background: '#fff' }} />
      )}
    </div>
  );
}

function MiniPreview({ item }: { item: LibraryItem }) {
  const spec = item.visual_spec as Record<string, unknown> | null;
  const t = item.visual_type;
  if (t === 'equation' && spec?.latex) {
    return <div className="avatar-gc__preview avatar-gc__preview--eq"><div style={{ transform: 'scale(0.6)' }}><EquationRenderer latex={spec.latex as string} /></div></div>;
  }
  if (t === 'chart' && spec?.labels) {
    return <div className="avatar-gc__preview"><ChartRenderer chartType={(spec.chartType as 'bar' | 'line' | 'pie') ?? 'bar'} title="" labels={spec.labels as string[]} datasets={(spec.datasets as never[]) ?? []} height="100%" /></div>;
  }
  if (t === 'diagram' && spec?.html) {
    return <div className="avatar-gc__preview"><DiagramRenderer html={spec.html as string} iframeHeight={150} /></div>;
  }
  if (t === 'simulation') {
    if (item.sim_entry_url) return <div className="avatar-gc__preview"><LazyIframe src={item.sim_entry_url} /></div>;
    if (typeof spec?.html === 'string') return <div className="avatar-gc__preview"><LazyIframe srcDoc={spec.html as string} /></div>;
    return <div className="avatar-gc__preview avatar-gc__preview--sim"><span>▶ Interactive</span></div>;
  }
  if (item.image_url) return <div className="avatar-gc__preview"><img src={item.image_url} alt={item.alt_text ?? ''} loading="lazy" /></div>;
  return <div className="avatar-gc__preview avatar-gc__preview--empty">—</div>;
}

function FullScreen({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
  const spec = item.visual_spec as Record<string, unknown> | null;
  return (
    <div className="avatar-gfs" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="avatar-gfs__close" onClick={onClose}><X size={18} /></button>
      {item.visual_type === 'image' && item.image_url && <img src={item.image_url} alt={item.alt_text ?? ''} className="avatar-gfs__img" />}
      {item.visual_type === 'simulation' && (item.sim_entry_url
        ? <iframe src={item.sim_entry_url} title="sim" sandbox="allow-scripts allow-same-origin" className="avatar-gfs__frame" />
        : typeof spec?.html === 'string' ? <iframe srcDoc={spec.html as string} title="sim" sandbox="allow-scripts" className="avatar-gfs__frame" /> : null)}
      {item.visual_type === 'equation' && !!spec?.latex && <div className="avatar-gfs__dark"><EquationRenderer latex={spec.latex as string} />{item.caption && <p className="avatar-gfs__cap">{item.caption}</p>}</div>}
      {item.visual_type === 'chart' && !!spec?.labels && <div className="avatar-gfs__dark avatar-gfs__chart"><ChartRenderer chartType={(spec.chartType as 'bar' | 'line' | 'pie') ?? 'bar'} title={(spec.title as string) ?? ''} labels={spec.labels as string[]} datasets={(spec.datasets as never[]) ?? []} height="100%" />{item.caption && <p className="avatar-gfs__cap">{item.caption}</p>}</div>}
      {item.visual_type === 'diagram' && !!spec?.html && <div className="avatar-gfs__dark"><DiagramRenderer html={spec.html as string} iframeHeight={520} />{item.caption && <p className="avatar-gfs__cap">{item.caption}</p>}</div>}
    </div>
  );
}

function GalleryCard({ item, onDelete, onToggleScope, onEditCaption, onEditSim }: {
  item: LibraryItem; onDelete: () => void; onToggleScope: () => void; onEditCaption: (c: string) => void; onEditSim: () => void;
}) {
  const color = TYPE_COLORS[item.visual_type] ?? '#e0e0e0';
  const spec = item.visual_spec as Record<string, unknown> | null;
  const canEditSim = item.visual_type === 'simulation' && !!item.sim_entry_url && spec?.source !== 'zip';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [fs, setFs] = useState(false);
  const date = item.created_at ? new Date(item.created_at).toLocaleDateString() : '';

  return (
    <div className="avatar-gc">
      <div className="avatar-gc__accent" style={{ background: color }} />
      <div style={{ position: 'relative' }}>
        <MiniPreview item={item} />
        <button className="avatar-gc__fs" onClick={() => setFs(true)} title="Full screen"><Maximize2 size={13} /></button>
      </div>
      <div className="avatar-gc__body">
        <div className="avatar-gc__meta">
          <span className="avatar-gc__badge" style={{ background: color + '33', color }}>{item.visual_type}</span>
          <span className="avatar-gc__scope" style={{ background: item.scope === 'basic' ? 'rgba(99,102,241,0.15)' : 'rgba(120,120,120,0.12)', color: item.scope === 'basic' ? '#6366f1' : '#888' }}>{item.scope}</span>
          {date && <span className="avatar-gc__date">{date}</span>}
        </div>
        {editing ? (
          <div className="avatar-gc__edit">
            <textarea className="avatar-gc__edit-ta" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Caption" />
            <div className="avatar-gc__edit-actions">
              <button className="avatar-g-create" onClick={() => { onEditCaption(draft); setEditing(false); }}>Save</button>
              <button className="avatar-gc__icon" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="avatar-gc__cap">{item.caption || item.alt_text || '(no caption)'}</p>
        )}
        <div className="avatar-gc__footer">
          <span className="avatar-gc__uses">Used {item.use_count}×</span>
          <div className="avatar-gc__actions">
            <button className="avatar-gc__icon" onClick={onToggleScope} title="Move basic/extended">→{item.scope === 'basic' ? 'ext' : 'basic'}</button>
            {canEditSim && <button className="avatar-gc__icon avatar-gc__icon--ai" onClick={onEditSim} title="Edit with AI"><Sparkles size={13} /></button>}
            {!editing && <button className="avatar-gc__icon" onClick={() => { setDraft(item.caption ?? item.alt_text ?? ''); setEditing(true); }} title="Edit caption"><Pencil size={13} /></button>}
            {confirmDelete ? (
              <>
                <button className="avatar-gc__icon avatar-gc__icon--danger" onClick={onDelete}>Yes</button>
                <button className="avatar-gc__icon" onClick={() => setConfirmDelete(false)}>No</button>
              </>
            ) : (
              <button className="avatar-gc__icon avatar-gc__icon--danger" onClick={() => setConfirmDelete(true)} title="Delete"><Trash2 size={13} /></button>
            )}
          </div>
        </div>
      </div>
      {fs && createPortal(<FullScreen item={item} onClose={() => setFs(false)} />, document.body)}
    </div>
  );
}
