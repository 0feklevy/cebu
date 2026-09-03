'use client';

import { ConfirmDialog } from './ConfirmDialog';
import { usePosterCapture } from './usePosterCapture';
import type { SimAspectProfile } from 'shared/src/sim/simIdentity';
import {
  SECTION_STEPS_BROLL, SECTION_STEPS_CLIP, SECTION_STEPS_GENERATED, SECTION_STEPS_IMAGE,
  SECTION_STEPS_SIM_ATTACHED, SECTION_STEPS_SIM_PICK, toTourSteps,
} from '@/lib/tours/steps';
import { tourAnchor } from '@/lib/tours/anchors';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getAuth } from 'firebase/auth';
import { Archive, Check, ChevronDown, ChevronUp, Copy, Download, Maximize2, Minimize2, Play, Square } from 'lucide-react';
import type { TimelineSection, Simulation, VideoFile, VideoGenerationJob, SimFile, SimMeta, ImageFile, GuidanceEntry, GuidanceMeta, GuidanceStatus, BridgePreset, BridgePresetFit } from 'shared/src/generated/client-v1';
import { api } from '../lib/api';
import {
  getStoredSelection, kindLabel, mergeScans, normalizeSelection, sanitizeControls,
  type SimUiControl, type SimUiControlKind, type SimStartScriptParams, type SimUiSelection,
} from '../lib/simUiControls';
import { SimSurface } from '../lib/sim/SimSurface';
import { useSimRuntime } from '../lib/sim/useSimRuntime';
import { acquireSimulationLease, shouldFirePickerActivation } from '../lib/sim/simulationLease';
import { useSimAuthoring } from '../hooks/useSimAuthoring';
import { GuidedTour, type TourStep } from './GuidedTour';
import { TourButton } from './TourButton';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

const GUIDANCE_LANGS: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'he', label: 'עברית' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ar', label: 'العربية' },
  { code: 'zh', label: '中文' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
];

type GenModel = 'kling' | 'seedance' | 'veo';

const GEN_MODELS: Record<GenModel, string> = {
  kling: 'kling',
  seedance: 'seedance',
  veo: 'veo',
};

const JOB_STATUS_LABEL: Record<string, string> = {
  queued:      'Waiting…',
  enhancing:   'Enhancing prompt…',
  submitting:  'Submitting to model…',
  generating:  'Generating video…',
  downloading: 'Downloading…',
  transcoding: 'Transcoding HLS…',
  ready:       'Done! Video added to library',
  failed:      'Failed',
};

function getClipOffset(videos: VideoFile[], videoFileId: string): number {
  const sorted = [...videos].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let offset = 0;
  for (const v of sorted) {
    if (v.id === videoFileId) return offset;
    offset += v.duration_sec ?? 0;
  }
  return 0;
}

function elapsed(createdAt: string): string {
  const secs = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// 'clip' is no longer a top-level type in the UI — it lives inside 'video' as a sub-mode
const TYPES = [
  { value: 'video',      label: 'Video',      color: '#3b82f6', bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  { value: 'simulation', label: 'Simulation', color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d', text: '#92400e' },
] as const;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function fmtTimeLong(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  const ms = Math.round((sec % 1) * 10);
  return `${m}:${s}.${ms}`;
}

function parseTime(str: string): number | null {
  const parts = str.split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseFloat(parts[1]);
  if (isNaN(m) || isNaN(s)) return null;
  return m * 60 + s;
}

/**
 * Read one SSE frame's `data`, or null if it isn't the JSON we expect.
 *
 * SSE frames are just text, and anything between the browser and the app — a proxy, an ingress, an
 * auth layer — can write HTML or a plain sentence into an open stream. Every consumer of this is an
 * event listener, and an exception thrown inside a listener does NOT reach the code that dispatched
 * it: the browser reports it and moves on, silently skipping whatever the rest of that handler was
 * going to do (close the stream, clear the busy flag). `lib/sse-client.ts` already parses the
 * project stream this way; the EventSource path here did not. (frontend-002)
 */
function parseStreamFrame<T>(data: unknown): T | null {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data) as T; } catch { return null; }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

// Kind-chip palette for the Minimal-UI control picker rows
const UI_KIND_CHIP: Record<SimUiControlKind, { bg: string; fg: string }> = {
  slider: { bg: '#e0f2fe', fg: '#0369a1' },
  toggle: { bg: '#f3e8ff', fg: '#7c3aed' },
  button: { bg: '#fef3c7', fg: '#b45309' },
  select: { bg: '#dcfce7', fg: '#15803d' },
  input:  { bg: '#e0e7ff', fg: '#4338ca' },
  other:  { bg: '#f3f4f6', fg: '#6b7280' },
};

// Stable identities for the memoized SimSurface: it resolves the src from `src` + `bootHide` on
// every render it is not memoized through, so a fresh [] / style object each render would re-run
// resolveSimUrl needlessly. NO_BOOT_HIDE is "cloak nothing" (still emits the #simboot fragment).
const NO_BOOT_HIDE: string[] = [];
const SIM_PREVIEW_FRAME_STYLE: React.CSSProperties = {
  border: 'none', width: '100%', height: '100%', backgroundColor: 'hsl(var(--card))',
};

const CAMERA_MOVEMENTS = [
  { value: 'zoom_in',   label: 'Zoom In'     },
  { value: 'zoom_out',  label: 'Zoom Out'    },
  { value: 'pan_right', label: 'Pan Right'   },
  { value: 'pan_left',  label: 'Pan Left'    },
  { value: 'dolly_in',  label: 'Dolly In'    },
  { value: 'drift',     label: 'Drift'       },
] as const;

interface Props {
  section: TimelineSection;
  projectId: string;
  /** The project's frame — a portrait project captures and looks up portrait posters (night run §6). */
  posterAspect?: SimAspectProfile;
  simulations: Simulation[];
  videos: VideoFile[];
  videoUrls: Record<string, string>;
  images?: ImageFile[];
  onUpdate: (s: TimelineSection) => void;
  onDelete: (id: string) => void;
  onSimulationUpdate?: (sim: Simulation) => void;
  onClose: () => void;
}

/**
 * Where the control list came from, as ONE fact.
 *
 * `live`  — the authoring channel answered: the real document, whatever its package's age.
 * `gate`  — the old in-package scanner answered (pre-authoring packages that still have a v3+ gate).
 * `static`— only the server-side HTML parse answered; JS-built controls are invisible to it.
 */
type UiScanSource = 'live' | 'gate' | 'static';

type UiScanOutcome =
  | { phase: 'idle' }
  /** Restored from what the last generation saved — not a scan. */
  | { phase: 'stored' }
  | { phase: 'busy' }
  | { phase: 'done'; source: UiScanSource; count: number; truncated: boolean }
  /** Every layer that ANSWERED said there are none. Not the same as nobody answering. */
  | { phase: 'empty'; scanned: UiScanSource[] }
  /** Nothing answered at all — no preview, no gate, no endpoint. */
  | { phase: 'unreachable' };

export function SectionEditor({
  section, projectId, simulations, videos, videoUrls, images = [],
  onUpdate, onDelete, onSimulationUpdate, onClose, posterAspect = 'wide',
}: Props) {
  const isBroll = section.track === 'broll';
  const knownTypes = TYPES.map(t => t.value) as string[];
  // 'clip' maps to 'video' in the switcher (it's a sub-mode), preserve it internally for save
  const initialType = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : section.type === 'clip' ? 'clip' : 'video');

  const [type, setType]         = useState(initialType);
  const [label, setLabel]       = useState(section.label ?? '');
  const [simId, setSimId]       = useState(section.simulation_id ?? '');
  const [simPrompt, setSimPrompt]   = useState(section.sim_prompt ?? '');
  const [simpleUi, setSimpleUi]     = useState(section.simple_ui ?? false);
  const [autoScript, setAutoScript] = useState(section.auto_script ?? true);
  const [tourOpen, setTourOpen]     = useState(false);
  const [showTiming, setShowTiming]   = useState(false);
  const [brollVolume, setBrollVolume] = useState<number>(
    (section as unknown as { broll_volume?: number }).broll_volume ?? 1.0
  );
  const [generating, setGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [simGenError, setSimGenError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Sim generation now streams over a fetch-POST SSE body (the selection travels in the body,
  // so there is no URL-length cap); this AbortController is how Cancel stops it.
  const genAbortRef = useRef<AbortController | null>(null);

  // ── Minimal-UI control picker (Advanced · UI controls) ────────────────────
  const [uiPanelOpen, setUiPanelOpen]   = useState(false);
  const [uiControls, setUiControls]     = useState<SimUiControl[]>([]);
  // Unchecked = HIDDEN in Minimal UI. Tracking the unchecked set means controls that are
  // new to a rescan default to checked (visible) without any bookkeeping.
  const [uiUnchecked, setUiUnchecked]   = useState<Set<string>>(new Set());
  // Untouched panel (never changed) ⇒ generation sends NOTHING and the AI decides —
  // exactly the pre-picker behavior. Only user picks (checkbox/All/None) set this.
  const [uiDirty, setUiDirty]           = useState(false);
  /**
   * ONE value describes the scan, and that is the point.
   *
   * This used to be three independent pieces of state (`busy`, `source`, `empty`), and an empty
   * scan updated only one of them — so the header read "Not scanned yet" while the body two lines
   * below read "No controls detected", simultaneously, and neither was the whole truth. A
   * discriminated union makes that pair unrepresentable: every message the panel shows is derived
   * from this single value.
   *
   * `empty` carries WHICH layers answered, because "the live document has no controls" and "we
   * could only reach the stored HTML, which lists none" are different things to tell an author.
   */
  const [uiScan, setUiScan] = useState<UiScanOutcome>({ phase: 'idle' });
  /** Controls the Auto Script appeared to drive — a heuristic, labelled as one wherever shown. */
  const [uiScriptTouched, setUiScriptTouched] = useState<Set<string>>(new Set());
  /** Toggle history for Undo (ADR D10). LIFO of the selectors whose mark changed. */
  const [uiUndoStack, setUiUndoStack] = useState<string[]>([]);

  // ── Saved setups ("save setup" / "load setup", migration 079 calls them saved_bridges) ───────
  // Transient UI state only — the presets themselves live server-side, user-scoped.
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);
  const [presetLabel, setPresetLabel] = useState('');
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  // Where the keyboard was before a setup dialog opened. Both dialogs are portaled to <body>, so
  // closing one otherwise drops focus onto <body> and the next Tab restarts at the top of the
  // page — a long way back to the button that was just pressed.
  const setupDialogReturnFocus = useRef<HTMLElement | null>(null);
  const [presets, setPresets] = useState<BridgePreset[] | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<BridgePreset | null>(null);
  // The server-composed sentence for the selected preset — which path a load would take and why.
  const [presetFit, setPresetFit] = useState<BridgePresetFit | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  // A recipe-path load that was applied MECHANICALLY (no LLM). We adopted the preset's settings
  // and kept the current simulation rendering; regenerating the script for THIS simulation is the
  // one thing that needs the LLM, so it is offered here as an explicit, labelled opt-in instead of
  // being spent automatically on load (FIX B — never auto-LLM on load).
  const [pendingRecipeRegen, setPendingRecipeRegen] = useState<{
    label: string; prompt: string; simpleUi: boolean; autoScript: boolean; selection: SimUiSelection | null;
  } | null>(null);

  // Checked selectors = stays-visible set (fed to normalizeSelection on Generate).
  const uiCheckedSelectors = useMemo(
    () => new Set(uiControls.filter(c => !uiUnchecked.has(c.selector)).map(c => c.selector)),
    [uiControls, uiUnchecked],
  );

  // hideSelectors for every startScript this editor posts: the live panel picks once
  // customized (an empty array is meaningful — it clears previous hides), else the
  // selection persisted by the last generation (omitted when absent/empty).
  const effectiveHideSelectors = useMemo<string[] | null>(() => {
    if (uiDirty && uiControls.length > 0) {
      return uiControls.filter(c => uiUnchecked.has(c.selector)).map(c => c.selector);
    }
    const storedHide = getStoredSelection(section.sim_meta)?.hide;
    return storedHide && storedHide.length > 0 ? storedHide : null;
  }, [uiDirty, uiControls, uiUnchecked, section.sim_meta]);

  // The Minimal-UI selection Generate will send: a customized panel sends live picks; an
  // untouched panel RE-SENDS the stored selection (so the backend keeps it — sending nothing
  // reads as "removed" and wipes it); a never-picked section sends nothing (the AI decides).
  const genSelection = useMemo<SimUiSelection | null>(() => (
    (uiDirty && uiControls.length > 0)
      ? normalizeSelection(uiControls, uiCheckedSelectors)
      : ((section.simulation_id ?? '') === simId ? getStoredSelection(section.sim_meta) : null)
  ), [uiDirty, uiControls, uiCheckedSelectors, section.simulation_id, section.sim_meta, simId]);
  const hasGenSelection = !!(genSelection && (genSelection.show.length || genSelection.hide.length));
  // Generate is allowed with EITHER a prompt (LLM) OR a UI selection (zero-LLM "minimize UI
  // only" — owner direction: "generate without prompt ⇒ only minimize the ui like what was chosen").
  const canGenerate = !!simPrompt.trim() || hasGenSelection;

  // ── Guided Simulation (mother-sim-level voice guidance) ───────────────────
  const [guidanceLang, setGuidanceLang]         = useState('en');
  const [guidance, setGuidance]                 = useState<GuidanceEntry[] | null>(null);
  const [guidanceStatus, setGuidanceStatus]     = useState<GuidanceStatus>('none');
  const [guidanceMeta, setGuidanceMeta]         = useState<GuidanceMeta | null>(null);
  const [guidanceBusy, setGuidanceBusy]         = useState<false | 'analyzing' | 'publishing'>(false);
  const [guidanceStatusMsg, setGuidanceStatusMsg] = useState<string | null>(null);
  const [guidanceError, setGuidanceError]       = useState<string | null>(null);
  const guidanceEsRef = useRef<EventSource | null>(null);
  const [startStr, setStartStr] = useState(fmtTime(section.start_sec));
  const [endStr, setEndStr]     = useState(fmtTime(section.end_sec));
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Video generation state
  const [genPrompt, setGenPrompt]   = useState('');
  const [genModel, setGenModel]     = useState<GenModel>('kling');
  const [genEnhance, setGenEnhance] = useState(true);
  const [genBusy, setGenBusy]       = useState(false);
  const [genError, setGenError]     = useState<string | null>(null);
  const [genJob, setGenJob]         = useState<VideoGenerationJob | null>(null);

  // Preview iframe control (simulation)
  //
  // Hoisted above the runtime binding (it used to sit with the other derived values further
  // down): useSimRuntime needs the document identity, and hooks must be declared before the
  // effects that drive them. `readySims`/`activeSim` depend only on the `simulations` prop and
  // the `simId` state, both of which are already in scope here.
  const readySims = simulations.filter(s => s.status === 'ready');
  const activeSim = readySims.find(s => s.id === simId) ?? null;
  // (P1.1b) Preview identity follows the USER'S CHOICE. The persisted section keeps priority only
  // while the picker agrees with it (or is untouched): once the user picks a DIFFERENT ready sim,
  // the preview must mount THAT sim's document. The old `section.simulation_url ?? …` short-circuit
  // kept the previous simulation's document on screen while the picker-reset and file-list effects
  // (both keyed on simId) already showed the new one — panel and preview disagreed until Generate.
  // Keying semantics are preserved: `key={simPreviewUrl}` below, so a divergent pick is a document
  // change and remounts the frame exactly like any other URL change.
  const previewPickerDiverges = !!simId && simId !== (section.simulation_id ?? '');
  // (audit §9.6) THE SERVED URL, not the stored one. `simulation_url` is what THIS section last
  // published; every other section of the same package rewrites the package's active-revision
  // pointer when IT publishes, and a rollback moves it for everyone. So two sections sharing one
  // simulation — generate A, generate B (retiring A's revision), regenerate A (retiring B's) — leave
  // B's row naming a revision withdrawn two publications ago. Once that revision falls outside
  // `keepLastN` and `RevisionService.collect` deletes it, this iframe 404s and the author's only
  // view of their own simulation is permanently blank, while the timeline slot beside it — which
  // has resolved the pointer since Stage 0 — shows the live revision correctly.
  //
  // This was the last sim surface reading the stored value: the viewer resolves it in
  // `buildPlayerConfig`, the editor timeline resolves it in `VideoEditor`, and the field has been
  // present on the very object this component receives all along (`selectedSection` comes from
  // VideoEditor's bootstrap `sections` state). `?? section.simulation_url` keeps the pre-migration
  // behaviour for a legacy package, a locally-constructed row, or an older backend.
  const simPreviewUrl = previewPickerDiverges
    ? (activeSim?.entry_file ?? null)
    : (section.simulation_served_url ?? section.simulation_url ?? activeSim?.entry_file ?? null);
  // Script identity follows the document: the persisted sim_script was generated against the
  // persisted document and cannot exist on a divergent pick's raw entry — use the 'main' default,
  // the same identity a fresh (never-generated) pick has always previewed with.
  const previewScript = previewPickerDiverges ? 'main' : (section.sim_script ?? 'main');

  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const simPreviewShellRef = useRef<HTMLDivElement>(null);
  const rightVideoRef = useRef<HTMLVideoElement>(null);

  // The shared simulation runtime owns this preview's lifecycle: the message listener (with its
  // e.source check, so the timeline player's frame can never drive this one), readiness, ack
  // matching, and disposal. The document key is the RAW stored URL — the same value the iframe is
  // keyed on; SimSurface does the resolveSimUrl/#simboot resolution internally.
  const { state: simState, runtime: simRuntime, frameRef: simFrameRef, onFrameLoad: simOnFrameLoad } =
    useSimRuntime(simPreviewUrl);

  // The Minimal-UI control scanner speaks a DIFFERENT protocol on its own channel and needs the
  // element, so keep the element ref alongside the runtime's ref callback.
  const previewFrameRef = useCallback((el: HTMLIFrameElement | null) => {
    previewIframeRef.current = el;
    simFrameRef(el);
  }, [simFrameRef]);

  // Kept as component state rather than derived from simState.currentScript: the section-change
  // reset effect below clears it even when the document itself does NOT change (two sections can
  // point at the same simulation_url), and the runtime has no notion of that. Every transition it
  // had before is preserved — set on activate, cleared on stop, on frame load, and on reset.
  const [previewRunning, setPreviewRunning] = useState(false);

  // (P1.1a) Activation EPOCH for deferred preview activations. Any scheduled activation (the
  // debounced picker re-apply below) captures the epoch at schedule time and drops itself at fire
  // time unless the epoch is unchanged AND the live gating state still allows it. Bumped by every
  // teardown of the preview's identity or run-state: stopPreview, the section-change reset, the
  // picker reset, a document (simPreviewUrl) change, and a generation landing (applyDone). This is
  // caller-side arbitration of WHICH activations may still be posted — the runtime keeps sole
  // ownership of how an accepted activation is applied, acked and revealed.
  const previewEpochRef = useRef(0);
  // Live values for fire-time reads. A 150ms-old closure must never drive the (possibly new)
  // document with values captured at schedule time — that stale drive is exactly the race the
  // epoch kills. Render-phase mirror, same pattern as useSimRuntime's cbsRef.
  const pickerFireStateRef = useRef({ previewRunning, simpleUi, autoScript, effectiveHideSelectors, previewScript });
  pickerFireStateRef.current = { previewRunning, simpleUi, autoScript, effectiveHideSelectors, previewScript };

  // Right-panel tabs (simulation only)
  const [rightTab, setRightTab]               = useState<'preview' | 'files'>('preview');

  /**
   * The mark set the in-document badges render from — derived, never a second source of truth.
   *
   * `uiUnchecked` remains the ONE place a decision lives; this is a projection of it. A badge and
   * its row can therefore never disagree, because there is nothing for them to disagree about.
   */
  const uiMarks = useMemo(
    () => uiControls.map(c => ({
      selector: c.selector,
      mark: (uiUnchecked.has(c.selector) ? 'hide' : 'keep') as 'hide' | 'keep',
    })),
    [uiControls, uiUnchecked],
  );

  /** Flip one control's mark, from either the checkbox or its badge. Records an Undo step. */
  const toggleUiControl = useCallback((selector: string) => {
    setUiUnchecked(prev => {
      const next = new Set(prev);
      if (next.has(selector)) next.delete(selector); else next.add(selector);
      return next;
    });
    setUiUndoStack(prev => [...prev, selector]);
    setUiDirty(true);
  }, []);

  const undoUiToggle = useCallback(() => {
    setUiUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      // Re-applying the same toggle IS the undo — every step in this stack is its own inverse.
      setUiUnchecked(u => {
        const next = new Set(u);
        if (next.has(last)) next.delete(last); else next.add(last);
        return next;
      });
      return prev.slice(0, -1);
    });
  }, []);

  /**
   * Keep exactly the script-driven controls and hide the rest of THIS SCAN.
   *
   * Scoped to `uiControls` on purpose: a control the scan never saw must not be hidden by a
   * suggestion derived from a list it was absent from. The button is disabled outright unless the
   * latest scan completed and was not capped — the ADR requires the suggestion to fall back to
   * nothing rather than act on a partial view.
   */
  const keepScriptUsed = useCallback(() => {
    setUiUnchecked(new Set(
      uiControls.filter(c => !uiScriptTouched.has(c.selector)).map(c => c.selector),
    ));
    setUiDirty(true);
    setUiUndoStack([]);   // a bulk change is not undoable step-by-step; say so by clearing.
  }, [uiControls, uiScriptTouched]);

  // `handlePreviewFrameLoad` is defined above this hook (it is wired into the surface further up),
  // so it reaches the session through a ref rather than forcing a reorder of two unrelated blocks.
  const authoringRef = useRef<ReturnType<typeof useSimAuthoring> | null>(null);

  const authoring = useSimAuthoring({
    frameRef: previewIframeRef,
    documentKey: simPreviewUrl,
    // Sessions exist only while the author is picking. A viewer never opens this panel, and the
    // in-document half stays dormant until one does.
    enabled: uiPanelOpen && rightTab === 'preview' && !!simPreviewUrl,
    marks: uiMarks,
    onMarkToggled: (sel) => toggleUiControl(sel),
    onScriptTouched: (sels) => setUiScriptTouched(prev => {
      const next = new Set(prev);
      for (const x of sels) next.add(x);
      return next;
    }),
    onEscape: () => setUiPanelOpen(false),
  });

  const [simFiles, setSimFiles]               = useState<SimFile[]>([]);
  const [simFilesLoading, setSimFilesLoading] = useState(false);
  const [simFilesError, setSimFilesError]     = useState<string | null>(null);
  const [activeFileKey, setActiveFileKey]     = useState<string | null>(null);
  const [fileContent, setFileContent]         = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [copiedFile, setCopiedFile] = useState(false);
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [zipDownloadBusy, setZipDownloadBusy] = useState(false);

  // ── Clip section state ─────────────────────────────────────────────────────
  const [localVideos, setLocalVideos]   = useState<VideoFile[]>(videos);
  const [localClipUrls, setLocalClipUrls] = useState<Record<string, string>>({});
  const [clipSourceVideoId, setClipSourceVideoId] = useState(section.clip_source_video_id ?? '');
  const [clipSourceImageId, setClipSourceImageId] = useState(section.clip_source_image_id ?? '');
  const [cameraMovement, setCameraMovement] = useState(section.camera_movement ?? 'zoom_in');
  // 'visual' sub-mode: 'video' = existing video clip, 'image' = uploaded still image
  const [clipVisualMode, setClipVisualMode] = useState<'video' | 'image'>(
    section.clip_source_image_id ? 'image' : 'video',
  );
  const [clipInSec, setClipInSec]       = useState(section.clip_in_sec ?? 0);
  const [clipCurrentTime, setClipCurrentTime] = useState(section.clip_in_sec ?? 0);
  const [clipPlaying, setClipPlaying]   = useState(false);
  const [clipUploading, setClipUploading] = useState(false);
  const [clipUploadPct, setClipUploadPct] = useState<number | null>(null);
  const [clipUploadErr, setClipUploadErr] = useState<string | null>(null);
  const clipVideoRef   = useRef<HTMLVideoElement>(null);
  const clipScrubRef   = useRef<HTMLDivElement>(null);
  const clipFileInputRef = useRef<HTMLInputElement>(null);
  // drag state: null = no drag; mode=window → dragging selection; mode=scrub → scrubbing
  const clipDragRef = useRef<{ mode: 'window' | 'scrub'; windowOffsetSec: number } | null>(null);

  const labelRef = useRef<HTMLInputElement>(null);
  const [isCompactModal, setIsCompactModal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 900px), (max-height: 680px)');
    const sync = () => setIsCompactModal(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    // (P1.1a) New section identity: any deferred preview activation scheduled against the
    // previous section is void, even when both sections share a document URL.
    previewEpochRef.current += 1;
    const t = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : section.type === 'clip' ? 'clip' : 'video');
    setType(t);
    setLabel(section.label ?? '');
    setSimId(section.simulation_id ?? '');
    setSimPrompt(section.sim_prompt ?? '');
    setSimpleUi(section.simple_ui ?? false);
    setAutoScript(section.auto_script ?? true);
    setSimGenError(null);
    setGenerating(false);
    setGenerationStatus(null);
    setShowTiming(false);
    setBrollVolume((section as unknown as { broll_volume?: number }).broll_volume ?? 1.0);
    // Close any active SSE stream when section changes
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setStartStr(fmtTime(section.start_sec));
    setEndStr(fmtTime(section.end_sec));
    setSaveError(null);
    setGenPrompt('');
    setGenError(null);
    setGenBusy(false);
    setGenJob(null);
    setRightTab('preview');
    setPreviewRunning(false);
    setSimFiles([]);
    setActiveFileKey(null);
    setFileContent(null);
    setCopiedFile(false);
    setFileDownloadBusy(false);
    setZipDownloadBusy(false);
    // Clip state reset
    setClipSourceVideoId(section.clip_source_video_id ?? '');
    setClipSourceImageId(section.clip_source_image_id ?? '');
    setCameraMovement(section.camera_movement ?? 'zoom_in');
    setClipVisualMode(section.clip_source_image_id ? 'image' : 'video');
    setClipInSec(section.clip_in_sec ?? 0);
    setClipCurrentTime(section.clip_in_sec ?? 0);
    setClipPlaying(false);
    setClipUploadErr(null);
    setTimeout(() => labelRef.current?.focus(), 80);
    // A notice about the PREVIOUS section is a statement about work the viewer is no longer
    // looking at.
    setPresetNotice(null);
    setPresetError(null);
    // A pending regenerate-with-AI offer belongs to the section it was raised on.
    setPendingRecipeRegen(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  // Reset + restore the Minimal-UI control picker whenever the section or the attached
  // simulation changes. A selection persisted by a previous generation renders
  // immediately (source 'stored'); the first panel open refreshes it with a live scan.
  // Intentionally NOT keyed on sim_meta: a generation that persists the current picks
  // must not clobber the user's in-flight panel state.
  useEffect(() => {
    // (P1.1a) The picker state a pending debounced re-apply was scheduled from is being reset —
    // that timer must never fire against the new section/simulation.
    previewEpochRef.current += 1;
    uiAutoScanRef.current = false;
    setUiPanelOpen(false);
    setUiDirty(false);
    setUiScriptTouched(new Set());
    setUiUndoStack([]);
    const stored = simId && simId === (section.simulation_id ?? '')
      ? getStoredSelection(section.sim_meta)
      : null;
    setUiControls(stored?.controls ?? []);
    setUiUnchecked(new Set(stored?.hide ?? []));
    setUiScan(stored ? { phase: 'stored' } : { phase: 'idle' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id, simId]);

  // Sync localVideos whenever the parent videos prop changes (e.g., new uploads or status changes).
  // Merge: locally uploaded clips take precedence; prop additions are appended.
  useEffect(() => {
    setLocalVideos(prev => {
      const propMap = new Map(videos.map(v => [v.id, v]));
      const merged = prev.map(v => propMap.get(v.id) ?? v);
      for (const v of videos) {
        if (!merged.find(m => m.id === v.id)) merged.push(v);
      }
      return merged;
    });
  }, [videos]);

  // Poll active generation job
  useEffect(() => {
    if (!genJob || genJob.status === 'ready' || genJob.status === 'failed') return;
    const poll = async () => {
      try {
        const updated = await api.getBrollJob(projectId, genJob.id);
        setGenJob(updated);
      } catch { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genJob?.id, genJob?.status]);

  // Escape closes the TOPMOST thing, not the whole editor. Both setup dialogs are portaled to
  // <body>, so a listener on window still hears their keystrokes: before this, pressing Escape to
  // back out of "name this setup" shut the entire section editor instead, losing the panel the
  // author was working in.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (presetSaveOpen) { setPresetSaveOpen(false); return; }
      if (loadOpen) { setLoadOpen(false); return; }
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, presetSaveOpen, loadOpen]);

  // Remember where the keyboard was, and put it back when the dialog closes — by Escape, by
  // Cancel, by the backdrop, or by a save that succeeded. Without this the caret lands on <body>
  // and the next Tab starts again at the top of the page.
  const setupDialogOpen = presetSaveOpen || loadOpen;
  useEffect(() => {
    if (setupDialogOpen) {
      const active = document.activeElement;
      setupDialogReturnFocus.current = active instanceof HTMLElement ? active : null;
      return;
    }
    const back = setupDialogReturnFocus.current;
    setupDialogReturnFocus.current = null;
    // Only if it is still on the page: the button can be gone if the section re-rendered around it.
    if (back && back.isConnected) back.focus();
  }, [setupDialogOpen]);

  // Close SSE stream / abort the in-flight generation on unmount
  useEffect(() => {
    return () => { eventSourceRef.current?.close(); genAbortRef.current?.abort(); };
  }, []);

  // 'i' key → mark in-point (clip type only)
  useEffect(() => {
    if (type !== 'clip') return;
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        setClipInSec(clipCurrentTime);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [type, clipCurrentTime]);

  // Document-level mouse handlers for clip scrubber drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = clipDragRef.current;
      const scrub = clipScrubRef.current;
      if (!drag || !scrub) return;

      const rect = scrub.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
      const sectionDuration = section.end_sec - section.start_sec;

      if (drag.mode === 'scrub') {
        const time = frac * sourceDuration;
        if (clipVideoRef.current) clipVideoRef.current.currentTime = time;
        setClipCurrentTime(time);
      } else {
        // window drag: shift in-point
        const rawIn = frac * sourceDuration - drag.windowOffsetSec;
        const maxIn = Math.max(0, sourceDuration - sectionDuration);
        const newIn = Math.max(0, Math.min(rawIn, maxIn));
        setClipInSec(newIn);
        if (clipVideoRef.current) clipVideoRef.current.currentTime = newIn;
        setClipCurrentTime(newIn);
      }
    };

    const onMouseUp = () => {
      clipDragRef.current = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
   
  }, [clipSourceVideoId, localVideos, section.end_sec, section.start_sec]);

  // Load simulation file list
  useEffect(() => {
    if (rightTab !== 'files' || !simId) return;
    setSimFilesLoading(true);
    setSimFiles([]);
    setSimFilesError(null);
    setActiveFileKey(null);
    setFileContent(null);
    api.listSimFiles(projectId, simId)
      .then(files => {
        setSimFiles(files);
        const firstText = files.find(f => f.isText) ?? files[0] ?? null;
        if (firstText) setActiveFileKey(firstText.key);
      })
      .catch(err => setSimFilesError((err as Error).message ?? 'Failed to load files'))
      .finally(() => setSimFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, simId, section.simulation_url]);

  // Load sim file content
  useEffect(() => {
    if (!activeFileKey || !simId) { setFileContent(null); return; }
    const activeFile = simFiles.find(f => f.key === activeFileKey);
    if (activeFile && !activeFile.isText) { setFileContent(null); return; }
    setFileContentLoading(true);
    setFileContent(null);
    setCopiedFile(false);
    api.getSimFileContent(projectId, simId, activeFileKey)
      .then(text => setFileContent(text))
      .catch(() => setFileContent('/* could not load file */'))
      .finally(() => setFileContentLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileKey]);

  const handleGenerateVideo = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setGenBusy(true);
    setGenError(null);
    setGenJob(null);
    try {
      const clipOffset = getClipOffset(videos, section.video_file_id);
      const duration = section.end_sec - section.start_sec;
      const globalOffset = clipOffset + section.start_sec;
      const result = await api.generateBroll(projectId, {
        prompt: genPrompt.trim(),
        model: genModel as 'kling' | 'seedance' | 'veo',
        enhance: genEnhance,
        target_duration_sec: Math.max(4, duration),
        target_global_offset_sec: globalOffset,
      });
      const job = await api.getBrollJob(projectId, result.jobId);
      setGenJob(job);
    } catch (err) {
      setGenError((err as Error).message ?? 'Generation failed');
    } finally {
      setGenBusy(false);
    }
  }, [projectId, section, videos, genPrompt, genModel, genEnhance]);

  // The params every "run this section now" activation carries. Identical to the object the old
  // hand-rolled startScript posts built: the LIVE toggle state (not the saved props, so the
  // preview reflects what the viewer just toggled and what Save will persist — frontend-005),
  // plus the hide set only when there is one.
  const livePreviewParams = useCallback((): SimStartScriptParams => ({
    simpleUi, autoScript,
    ...(effectiveHideSelectors ? { hideSelectors: effectiveHideSelectors } : {}),
  }), [simpleUi, autoScript, effectiveHideSelectors]);

  // "Run this section now" — one activation + the Run/Stop chrome flag, shared by the handshake,
  // the toggle re-apply and the Run button. Script identity is previewScript: the stored
  // sim_script with its 'main' fallback, or plain 'main' when the picker diverges (P1.1b).
  const runPreview = useCallback(() => {
    simRuntime.activate({ script: previewScript, params: livePreviewParams() });
    setPreviewRunning(true);
  }, [simRuntime, previewScript, livePreviewParams]);

  const stopPreview = useCallback(() => {
    // (P1.1a) Stop orphans any deferred activation: without the bump, a picker re-apply
    // scheduled up to 150ms ago would restart the sim the user just stopped.
    previewEpochRef.current += 1;
    // Immediate teardown: this surface has no fade, so there is nothing to defer the stopScript
    // behind (deactivate's deferral exists precisely for surfaces that do fade).
    simRuntime.stopNow();
    setPreviewRunning(false);
  }, [simRuntime]);

  // The runtime resets every per-document flag on a native load; the local chrome flag follows,
  // exactly as the old `onLoad={() => setPreviewRunning(false)}` did.
  // True once the current preview document has loaded — the poster capture waits on it.
  const [previewLoaded, setPreviewLoaded] = useState(false);
  useEffect(() => { setPreviewLoaded(false); }, [simPreviewUrl]);
  const handlePreviewFrameLoad = useCallback(() => {
    simOnFrameLoad();
    setPreviewLoaded(true);
    // The transferred port died with the previous document, and the control list describes a DOM
    // that no longer exists. Reconnecting here is what closes the race the old picker lost: it
    // scanned once on panel open and never retried, so a scan that beat the frame's load simply
    // failed forever.
    authoringRef.current?.notifyFrameLoad();
    setPreviewRunning(false);
  }, [simOnFrameLoad]);

  // The poster for this section's simulation is captured HERE, in the creator's browser, from the
  // preview that is already drawing (usePosterCapture.ts). Once per document per session; the
  // "Refresh banner" button forces a new one.
  // The banner is captured from the preview automatically — there is no button for it any
  // more (owner ruling 2026-09-03): the editor sweep and this hook keep every simulation
  // picture current without anyone asking for it.
  usePosterCapture({
    projectId,
    sectionId: section.id,
    simulationUrl: simPreviewUrl,
    frame: () => previewIframeRef.current,
    loaded: previewLoaded,
    aspect: posterAspect,
    enabled: Boolean(simId),
  });

  // Auto-run on handshake. The runtime owns the 'message' listener (and its e.source check — the
  // timeline player mounts its own sim frame at the same time, and its SIM_READY used to be
  // answered by restarting the preview sim (audited)); this effect is the same rule expressed
  // against runtime state: when THIS document handshakes, start the section script.
  useEffect(() => {
    if (!simState.ready) return;
    runPreview();
  // Fires once per handshake, exactly like the old SIM_READY message handler. The params are
  // read fresh from this render's values — the closure is rebuilt every render, only the *firing*
  // is gated on `ready`. Adding the param deps here would restart the sim on every toggle, which
  // is the next effect's job.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simState.ready]);

  // Live-apply toggle flips to a RUNNING preview.
  //
  // (P1.2) POLICY, NOT ACTIVATION. This used to call runPreview(), i.e. a full activation: on v2
  // that falls through the bridge's stopScript (cleanup runs, every tracked timer dies, the body
  // re-runs) and on v3 it mints a new configHash, which IS a new activation by construction.
  // Either way, hiding a slider reset the physics and threw away wherever the demonstration had
  // got to. setPolicy moves the chrome and the automation and touches nothing else.
  //
  // The fallback is the runtime's, not ours: a package whose bridge predates the policy handlers
  // (every package published before this) is re-activated by setPolicy itself, which reports the
  // reason. 'no-activation' is the one case this surface must handle — the preview chrome says it
  // is running but the runtime has no live section, so a real activation is what is wanted.
  useEffect(() => {
    if (!previewRunning) return;
    const outcome = simRuntime.setPolicy({
      simpleUi,
      autoScript,
      // The deliberate difference from the picker effect below, PRESERVED: `null` here means "no
      // mechanical hide set", which on the restart path leaves the body's own generated hide logic
      // to decide. The picker sends `[]`, which is the stronger "the user re-checked everything".
      // On the policy path the two are equivalent (the body is not re-run, so it never sees the
      // value) — but the fallback restart does re-run it, and there the distinction is real.
      hideSelectors: effectiveHideSelectors,
    });
    if (outcome === 'no-activation') runPreview();
  // Only re-fire on toggle changes — previewRunning/sim_script/hideSelectors are read fresh but
  // must not retrigger here (the debounced picker effect below owns hide-selection changes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simpleUi, autoScript]);

  // (P1.1a) A document change orphans every deferred activation scheduled against the previous
  // document — including the cases no other reset covers (a generation replacing simulation_url,
  // a divergent picker choice swapping the mounted entry). Declared BEFORE the debounced picker
  // effect so a same-commit document change bumps first and the timer scheduled in that commit
  // (if any) belongs to the new epoch.
  useEffect(() => {
    previewEpochRef.current += 1;
  }, [simPreviewUrl]);

  // Live-preview the picker: when the checked set changes (debounced ~150ms), re-apply the
  // CURRENT params with hideSelectors so the user sees hides apply/clear
  // immediately where the bridge's wrap template supports it. Only meaningful while the
  // preview is running and Minimal UI is on; old bridges ignore the param harmlessly.
  useEffect(() => {
    if (!uiDirty || !previewRunning || !simpleUi) return;
    const scheduledEpoch = previewEpochRef.current;
    const timer = window.setTimeout(() => {
      // (P1.1a) Re-decide from LIVE state, never from the schedule-time closure. The epoch
      // catches every teardown that does not touch uiUnchecked (stop, section/picker resets,
      // document changes, a generation landing) — the runtime keeps ONE client across document
      // changes, so before this check a stale timer's activate() drove the NEW document with the
      // OLD script/params. previewRunning/simpleUi are re-read because Stop alone flips them
      // without any reset running. uiDirty needs no re-check: it only flips false in the picker
      // reset, which bumps the epoch.
      const live = pickerFireStateRef.current;
      if (!shouldFirePickerActivation({
        scheduledEpoch,
        currentEpoch: previewEpochRef.current,
        previewRunning: live.previewRunning,
        simpleUi: live.simpleUi,
      })) return;
      // hideSelectors is ALWAYS an array here (unlike the toggle effect above): an empty array is
      // the meaningful "clear every hide" instruction when the user re-checks every control.
      //
      // (P1.2) A hide-selection change is pure chrome, so it goes as POLICY. It used to re-activate
      // — the picker's whole purpose is to let the author watch hides apply and clear while the
      // demonstration runs, and re-running the body every 150ms debounce is precisely what stopped
      // that from being watchable. setPolicy owns the restart fallback for packages that cannot
      // take it; 'no-activation' is the only outcome this surface has to answer for itself.
      const outcome = simRuntime.setPolicy({
        simpleUi: live.simpleUi,
        autoScript: live.autoScript,
        hideSelectors: live.effectiveHideSelectors ?? [],
      });
      if (outcome === 'no-activation') {
        const params: SimStartScriptParams = {
          simpleUi: live.simpleUi,
          autoScript: live.autoScript,
          hideSelectors: live.effectiveHideSelectors ?? [],
        };
        simRuntime.activate({ script: live.previewScript, params });
      }
    }, 150);
    return () => window.clearTimeout(timer);
  // Re-fire only when the picks change — a picker change while running re-applies once, 150ms
  // debounced. Everything else is read fresh AT FIRE TIME through pickerFireStateRef and
  // previewEpochRef; listing those values here would re-schedule on unrelated renders and defeat
  // both the debounce and the single-re-apply behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiUnchecked]);

  const [isSimFullscreen, setIsSimFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsSimFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleSimFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      simPreviewShellRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const openFullscreen = useCallback((target: HTMLElement | null) => {
    target?.requestFullscreen?.().catch(() => {});
  }, []);

  const handleCopyActiveFile = useCallback(async () => {
    const file = simFiles.find(f => f.key === activeFileKey) ?? null;
    if (!file || !simId) return;
    const content = fileContent ?? await api.getSimFileContent(projectId, simId, file.key);
    await copyTextToClipboard(content);
    setCopiedFile(true);
    window.setTimeout(() => setCopiedFile(false), 1400);
  }, [activeFileKey, fileContent, projectId, simFiles, simId]);

  const handleDownloadActiveFile = useCallback(async () => {
    const file = simFiles.find(f => f.key === activeFileKey) ?? null;
    if (!file || !simId) return;
    setFileDownloadBusy(true);
    try {
      const content = fileContent ?? await api.getSimFileContent(projectId, simId, file.key);
      saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), file.filename);
    } catch { /* ignore */ }
    finally {
      setFileDownloadBusy(false);
    }
  }, [activeFileKey, fileContent, projectId, simFiles, simId]);

  const handleDownloadSimulationZip = useCallback(async () => {
    if (!simId) return;
    setZipDownloadBusy(true);
    try {
      const blob = await api.downloadSimZip(projectId, simId);
      const simName = simulations.find(s => s.id === simId)?.name ?? 'simulation';
      const safeName = simName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'simulation';
      saveBlob(blob, `${safeName}.zip`);
    } catch (err) {
      alert(`ZIP download failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setZipDownloadBusy(false);
    }
  }, [projectId, simulations, simId]);

  // Apply a PERSISTED section to the editor + live preview. Extracted from the generate stream's
  // `done` handler so the saved-bridge apply path resyncs through the exact same code — two copies
  // of this logic is how the toggles and the live document start disagreeing.
  const applyPersistedSection = useCallback((s: TimelineSection) => {
    onUpdate(s);
    previewEpochRef.current += 1;
    setSimpleUi(s.simple_ui ?? false);
    setAutoScript(s.auto_script ?? true);
    const doneSelection = getStoredSelection(s.sim_meta);
    setUiControls(doneSelection?.controls ?? []);
    setUiUnchecked(new Set(doneSelection?.hide ?? []));
    setUiDirty(false);
    setUiScan(doneSelection ? { phase: 'stored' } : { phase: 'idle' });
    const mountedDoc = simRuntime.getState().documentKey;
    const nextDoc = s.simulation_served_url ?? s.simulation_url;
    const remountCovers = !!nextDoc && nextDoc !== mountedDoc;
    if (!remountCovers) {
      const doneHide = doneSelection?.hide ?? null;
      const doneParams: SimStartScriptParams = {
        simpleUi:   s.simple_ui ?? false,
        autoScript: s.auto_script ?? true,
        ...(doneHide ? { hideSelectors: doneHide } : {}),
      };
      simRuntime.activate({ script: s.sim_script ?? 'main', params: doneParams });
    }
    setPreviewRunning(true);
  }, [onUpdate, simRuntime]);

  const handleGenerateScript = useCallback(async (overrides?: {
    prompt?: string; simpleUi?: boolean; autoScript?: boolean; selection?: SimUiSelection | null;
  }) => {
    if (!simId) return;
    const prompt = (overrides?.prompt ?? simPrompt).trim();
    const effSimpleUi = overrides?.simpleUi ?? simpleUi;
    const effAutoScript = overrides?.autoScript ?? autoScript;
    const sel = overrides?.selection !== undefined ? overrides.selection : genSelection;
    const sendSel = !!(sel && (sel.show.length || sel.hide.length));
    // Generate needs EITHER a prompt (LLM) OR a UI selection (mechanical minimize-UI, no prompt).
    if (!prompt && !sendSel) return;

    // Any real generation supersedes a standing "regenerate this recipe for me?" offer.
    setPendingRecipeRegen(null);

    // Ensure section is set to simulation type first
    if (section.type !== 'simulation' || section.simulation_id !== simId) {
      try {
        const patched = await api.updateSection(projectId, section.id, {
          type: 'simulation',
          simulation_id: simId,
        });
        onUpdate(patched);
      } catch (err) {
        setSimGenError((err as Error).message ?? 'Failed to update section');
        return;
      }
    }

    genAbortRef.current?.abort();
    const abort = new AbortController();
    genAbortRef.current = abort;
    setGenerating(true);
    setGenerationStatus(prompt ? 'Starting…' : 'Applying minimal UI…');
    setSimGenError(null);

    // POST stream: the Minimal-UI selection travels in the request BODY (no URL-length cap —
    // the old "Too many UI controls" error was purely the ?ui_controls= query ceiling), and
    // auth uses the Authorization header. Real HTTP status codes surface validation failures
    // that EventSource could only report as a generic "connection lost".
    let errorHandled = false;

    const applyDone = applyPersistedSection;

    const dispatch = (event: string, dataStr: string) => {
      if (event === 'status') {
        try { setGenerationStatus((JSON.parse(dataStr) as { status: string }).status); } catch { /* ignore */ }
      } else if (event === 'token') {
        setGenerationStatus(prev => (prev && !prev.endsWith('…') ? prev + '…' : (prev ?? 'Generating bridge script…')));
      } else if (event === 'done') {
        errorHandled = true;
        try { applyDone((JSON.parse(dataStr) as { section: TimelineSection }).section); } catch { /* ignore */ }
      } else if (event === 'error') {
        errorHandled = true;
        let msg = 'Generation failed';
        try { msg = (JSON.parse(dataStr) as { error: string }).error || msg; } catch { /* ignore */ }
        setSimGenError(msg);
      }
    };

    try {
      // Inside the try so a token-refresh rejection is caught (shows an error + resets the
      // spinner) instead of escaping with generating stuck true.
      const idToken = await getAuth().currentUser?.getIdToken();
      const res = await fetch(
        `${API_URL}/api/v1/projects/${projectId}/sections/${section.id}/generate-sim-script/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            prompt,
            simple_ui: effSimpleUi,
            auto_script: effAutoScript,
            ...(sendSel ? { ui_controls: sel } : {}),
          }),
          signal: abort.signal,
        },
      );
      if (!res.ok || !res.body) {
        let msg = 'Generation failed';
        try { msg = ((await res.json()) as { message?: string }).message ?? msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }

      // Minimal SSE reader over the fetch body: frames are separated by a blank line; each frame
      // has optional `event:` + one or more `data:` lines; lines starting with `:` are keep-alives.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (!line || line.startsWith(':')) continue;          // keep-alive / comment
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length || event !== 'message') dispatch(event, dataLines.join('\n'));
        }
      }
    } catch (err) {
      if (!errorHandled && (err as Error).name !== 'AbortError') {
        setSimGenError((err as Error).message || 'Connection lost. Please try again.');
      }
    } finally {
      // Only clear UI state if THIS run is still the current one. A superseding Generate
      // (which aborted `abort` and installed its own controller) must keep the spinner up —
      // otherwise this aborted run's finally would re-enable the button mid-generation.
      if (genAbortRef.current === abort) {
        genAbortRef.current = null;
        setGenerating(false);
        setGenerationStatus(null);
      }
    }
  }, [projectId, section, simId, simPrompt, simpleUi, autoScript, genSelection, onUpdate, applyPersistedSection]);

  // ── Saved-bridge handlers ───────────────────────────────────────────────────────────────────

  const handleSavePreset = useCallback(async () => {
    const label = presetLabel.trim();
    if (!label || presetBusy) return;
    setPresetBusy(true);
    setPresetError(null);
    try {
      await api.saveBridgePreset(projectId, section.id, label);
      setPresetSaveOpen(false);
      setPresetLabel('');
      setPresetNotice(`Saved as “${label}”`);
    } catch (e) {
      setPresetError((e as Error).message || 'Could not save this bridge');
    } finally {
      setPresetBusy(false);
    }
  }, [presetLabel, presetBusy, projectId, section.id]);

  const openLoadPicker = useCallback(async () => {
    setLoadOpen(true);
    setSelectedPreset(null);
    setPresetFit(null);
    setPresetError(null);
    setPresets(null);
    try {
      const r = await api.listBridgePresets();
      // The client contract in `shared/src/generated/client-v1.ts` is hand-maintained, so a
      // backend that stops sending `presets` breaks nothing at build time and throws HERE, inside
      // render, taking the whole editor down with it. An empty list is the honest fallback.
      setPresets(Array.isArray(r?.presets) ? r.presets : []);
    } catch (e) {
      setPresetError((e as Error).message || 'Could not load your saved bridges');
      setPresets([]);
    }
  }, []);

  const handleSelectPreset = useCallback(async (p: BridgePreset) => {
    setSelectedPreset(p);
    setPresetFit(null);
    setFitLoading(true);
    try {
      setPresetFit(await api.bridgePresetFit(projectId, section.id, p.id));
    } catch {
      // No fit answer is not a dead end: the confirm falls back to the recipe path, which is
      // always available. The sentence just cannot promise "instantly".
      setPresetFit(null);
    } finally {
      setFitLoading(false);
    }
  }, [projectId, section.id]);

  /**
   * Bring the preset's source simulation into THIS project, then point the section at it.
   *
   * The composition the feature was described as: save a bridge on one video, load it on another.
   * Since migration 080 the bytes already exist and the import writes only rows — so the sentence
   * on the button ("nothing is stored twice") is a fact about the system, not a reassurance.
   */
  const importPresetSimulation = useCallback(async (p: BridgePreset) => {
    if (!p.source_simulation_id || presetBusy) return;
    setPresetBusy(true);
    setPresetError(null);
    try {
      const sim = await api.importSimulation(projectId, p.source_simulation_id);
      onSimulationUpdate?.(sim);
      // Point this section at what just arrived, so the load has something to apply to. Done
      // through the normal section update rather than local state: the preset apply that follows
      // reads the PERSISTED section.
      const patched = await api.updateSection(projectId, section.id, { type: 'simulation', simulation_id: sim.id });
      onUpdate(patched);
      setSimId(sim.id);
      setPresetNotice(`Brought in “${sim.name}” — nothing was stored twice.`);
      // Re-judge against the simulation that now exists; the previous verdict was about a
      // different one, or about none.
      await handleSelectPreset(p);
    } catch (e) {
      setPresetError((e as Error).message || 'Could not bring in that simulation');
    } finally {
      setPresetBusy(false);
    }
  }, [presetBusy, projectId, section.id, onUpdate, onSimulationUpdate, handleSelectPreset]);

  const handleConfirmLoad = useCallback(async () => {
    const p = selectedPreset;
    if (!p || presetBusy) return;
    setPresetBusy(true);
    setPresetError(null);
    try {
      // A section with NO simulation gets the setup's own package in the same request: the load
      // IS the import (owner ruling 2026-09-03 — a setup travels between projects). The server
      // attaches a copy this project already has rather than making another.
      const bringIt = !simId && presetFit?.bring?.needed === true && presetFit.bring.possible;
      const adoptBrought = (brought: { simulation: Simulation } | null | undefined) => {
        if (!brought) return;
        onSimulationUpdate?.(brought.simulation);
        setSimId(brought.simulation.id);
      };

      if (presetFit?.path === 'artifact' || bringIt) {
        try {
          const r = await api.applyBridgePreset(projectId, section.id, p.id, bringIt);
          adoptBrought(r.brought);
          applyPersistedSection(r.section);
          setPendingRecipeRegen(null);
          setLoadOpen(false);
          setPresetNotice(`Loaded “${p.label}”`);
          return;
        } catch (e) {
          // 409 is an INSTRUCTION: the fit changed between /fit and /apply (a replace can
          // activate a new revision in between) and the server refused the paste. Everything
          // else — auth, network, 5xx — is a real failure and must not quietly become an LLM
          // spend the user did not ask for.
          if ((e as { status?: number }).status !== 409) throw e;
          // A 409 means the script did not fit — but if the package came along, it is in this
          // project and on this section NOW, and the recipe path below must regenerate against
          // IT, not against the nothing that was here before.
          adoptBrought((e as { body?: { brought?: { simulation: Simulation } | null } }).body?.brought);
        }
      }
      // ── The RECIPE path: a load that does NOT fit as an artifact ────────────────────────────
      // A saved script body binds BY NAME to one simulation's DOM ids / label texts / window API;
      // pasted onto a different simulation it finds nothing and silently no-ops — which is exactly
      // how a load blacks the screen. Regenerating the script for THIS simulation is the only
      // technical option and it costs an LLM call, so it is NEVER spent automatically here (FIX B).
      // Instead: adopt the preset's settings, apply only the MECHANICAL (zero-LLM) parts, keep the
      // current simulation rendering, and offer regeneration as an explicit, labelled opt-in below.
      const sel = p.ui_controls && ((p.ui_controls.show?.length ?? 0) || (p.ui_controls.hide?.length ?? 0))
        ? { controls: [], show: p.ui_controls.show ?? [], hide: p.ui_controls.hide ?? [] }
        : null;
      setSimPrompt(p.sim_prompt ?? '');
      setSimpleUi(p.simple_ui);
      setAutoScript(p.auto_script);
      if (sel) {
        setUiUnchecked(new Set(sel.hide));
        setUiScan({ phase: 'stored' });
      }
      setLoadOpen(false);

      // MECHANICAL apply — no LLM, never touches the working simulation's body:
      //   • with a UI selection → the existing minimize-UI path (empty prompt ⇒ applyMinimalUiOnly),
      //     which persists simple_ui / auto_script / the selection and PRESERVES the current body;
      //   • without one → persist just the toggles through a plain section update.
      if (sel) {
        await handleGenerateScript({ prompt: '', simpleUi: p.simple_ui, autoScript: p.auto_script, selection: sel });
      } else {
        try {
          const patched = await api.updateSection(projectId, section.id, { simple_ui: p.simple_ui, auto_script: p.auto_script });
          onUpdate(patched);
        } catch { /* the toggles are a convenience; a failed persist must not block the opt-in below */ }
      }

      // Offer AI regeneration as a deliberate choice — only when there is a prompt to regenerate
      // FROM. A settings/selection-only preset has nothing to author, so no spend is offered.
      const regenPrompt = (p.sim_prompt ?? '').trim();
      if (regenPrompt) {
        setPendingRecipeRegen({ label: p.label, prompt: regenPrompt, simpleUi: p.simple_ui, autoScript: p.auto_script, selection: sel });
        setPresetNotice(`Loaded “${p.label}” settings. Its saved script was written for a different simulation, so this one is unchanged — regenerate it for this simulation below if you want it adapted.`);
      } else {
        setPendingRecipeRegen(null);
        setPresetNotice(`Loaded “${p.label}” settings.`);
      }
    } catch (e) {
      setPresetError((e as Error).message || 'Could not load this bridge');
    } finally {
      setPresetBusy(false);
    }
  }, [selectedPreset, presetBusy, presetFit, projectId, section.id, applyPersistedSection, handleGenerateScript, onUpdate]);

  // The explicit, opt-in AI regeneration for a recipe-path load (FIX B). This is the ONLY place a
  // load turns into an LLM spend, and only ever from the user's click on the labelled button.
  const handleRegenerateForThisSim = useCallback(async () => {
    const r = pendingRecipeRegen;
    if (!r || presetBusy || generating) return;
    setPendingRecipeRegen(null);
    setPresetNotice(null);
    await handleGenerateScript({ prompt: r.prompt, simpleUi: r.simpleUi, autoScript: r.autoScript, selection: r.selection });
  }, [pendingRecipeRegen, presetBusy, generating, handleGenerateScript]);


  const handleCancelGeneration = useCallback(() => {
    genAbortRef.current?.abort();
    genAbortRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setGenerating(false);
    setGenerationStatus(null);
  }, []);

  // ── Guided Simulation handlers ────────────────────────────────────────────
  // Sync local guidance state when the user picks a different simulation.
  // We track whether guidance state was already populated from a live server response
  // so we don't overwrite it with stale props when simulations array reference changes.
  const guidanceInitializedForSimRef = useRef<string | null>(null);
  useEffect(() => {
    if (guidanceInitializedForSimRef.current === simId) return;  // already live-synced, don't stomp
    guidanceInitializedForSimRef.current = simId;
    const s = simulations.find(x => x.id === simId);
    setGuidance(s?.guidance ?? null);
    setGuidanceStatus(s?.guidance_status ?? 'none');
    setGuidanceMeta(s?.guidance_meta ?? null);
    setGuidanceError(null);
    if (s?.guidance_meta?.language) setGuidanceLang(s.guidance_meta.language);
  // Only re-run when simId changes (not on every stale simulations prop update)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simId]);

  useEffect(() => () => { guidanceEsRef.current?.close(); }, []);

  const applyGuidanceSim = (sim: Simulation) => {
    guidanceInitializedForSimRef.current = sim.id;  // mark as live-synced so useEffect won't stomp
    setGuidance(sim.guidance ?? null);
    setGuidanceStatus(sim.guidance_status ?? 'none');
    setGuidanceMeta(sim.guidance_meta ?? null);
    onSimulationUpdate?.(sim);  // propagate up so VideoEditor's simulations state stays current
  };

  const runGuidanceStream = async (kind: 'generate' | 'publish') => {
    if (!simId) return;
    guidanceEsRef.current?.close();
    setGuidanceBusy(kind === 'generate' ? 'analyzing' : 'publishing');
    setGuidanceStatusMsg(kind === 'generate' ? 'Starting analysis…' : 'Starting…');
    setGuidanceError(null);

    const idToken = await getAuth().currentUser?.getIdToken();
    const path = kind === 'generate' ? 'generate-guidance/stream' : 'publish-guidance/stream';
    const url = new URL(`${API_URL}/api/v1/projects/${projectId}/simulations/${simId}/${path}`);
    if (kind === 'generate') url.searchParams.set('language', guidanceLang);
    if (idToken) url.searchParams.set('token', idToken);

    const es = new EventSource(url.toString());
    guidanceEsRef.current = es;
    let handled = false;

    // Every exit from the run goes through here, so there is exactly one place that can leave the
    // panel busy or the stream open — and it always does neither. (frontend-002)
    const finish = (error: string | null) => {
      if (handled) return;
      handled = true;
      setGuidanceError(error);
      setGuidanceBusy(false);
      setGuidanceStatusMsg(null);
      es.close();
      guidanceEsRef.current = null;
    };

    es.addEventListener('status', (e: MessageEvent) => {
      // A junk progress line is not a reason to abandon a run that is still going.
      const data = parseStreamFrame<{ status?: string }>(e.data);
      if (data?.status) setGuidanceStatusMsg(data.status);
    });
    es.addEventListener('done', (e: MessageEvent) => {
      const data = parseStreamFrame<{ simulation?: Simulation }>(e.data);
      if (!data?.simulation) {
        finish('The server ended the run with an unreadable response. Please try again.');
        return;
      }
      applyGuidanceSim(data.simulation);
      finish(null);
    });
    es.addEventListener('error', (e: MessageEvent) => {
      // No `data` ⇒ this is EventSource's own transport error, which `onerror` below owns.
      if (!e.data) return;
      finish(parseStreamFrame<{ error?: string }>(e.data)?.error || 'Guidance generation failed');
    });
    es.onerror = () => finish('Connection lost. Please try again.');
  };

  const saveGuidanceDraft = async (entries: GuidanceEntry[]) => {
    const idToken = await getAuth().currentUser?.getIdToken();
    await fetch(`${API_URL}/api/v1/projects/${projectId}/simulations/${simId}/guidance`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify({ entries }),
    }).catch(() => { /* best-effort; publish re-reads from DB */ });
  };

  const handlePublishGuidance = async () => {
    if (guidance) await saveGuidanceDraft(guidance);   // persist edits before TTS
    await runGuidanceStream('publish');
  };

  const handleCancelGuidance = () => {
    guidanceEsRef.current?.close();
    guidanceEsRef.current = null;
    setGuidanceBusy(false);
    setGuidanceStatusMsg(null);
  };

  const setEntryNarration = (id: string, text: string) =>
    setGuidance(g => (g ? g.map(e => (e.id === id ? { ...e, narration: text } : e)) : g));
  const toggleEntryEnabled = (id: string) =>
    setGuidance(g => (g ? g.map(e => (e.id === id ? { ...e, enabled: !e.enabled } : e)) : g));

  // ── Clip source upload ─────────────────────────────────────────────────────

  const handleClipUpload = useCallback(async (file: File) => {
    setClipUploading(true);
    setClipUploadPct(0);
    setClipUploadErr(null);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');
      const formData = new FormData();
      formData.append('file_size', String(file.size));
      formData.append('file', file, file.name);
      const video = await new Promise<VideoFile>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) setClipUploadPct(Math.round(e.loaded / e.total * 100));
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as VideoFile); }
            catch { reject(new Error('Upload response parse failed')); }
          } else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.open('POST', `${API_URL}/api/v1/projects/${projectId}/videos/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });
      setLocalVideos(prev => [...prev.filter(v => v.id !== video.id), video]);
      if (video.raw_url) setLocalClipUrls(prev => ({ ...prev, [video.id]: video.raw_url! }));
      setClipSourceVideoId(video.id);
      setClipInSec(0);
      setClipCurrentTime(0);
    } catch (err) {
      setClipUploadErr((err as Error).message);
    } finally {
      setClipUploading(false);
      setClipUploadPct(null);
    }
  }, [projectId]);

  // ── Clip scrubber mouse handlers ───────────────────────────────────────────

  const handleScrubMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = clipScrubRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
    if (!sourceDuration) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = frac * sourceDuration;
    clipDragRef.current = { mode: 'scrub', windowOffsetSec: 0 };
    if (clipVideoRef.current) clipVideoRef.current.currentTime = time;
    setClipCurrentTime(time);
  }, [clipSourceVideoId, localVideos]);

  const handleWindowMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = clipScrubRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
    if (!sourceDuration) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const clickedAtSec = frac * sourceDuration;
    const offsetInWindow = clickedAtSec - clipInSec;
    clipDragRef.current = { mode: 'window', windowOffsetSec: offsetInWindow };
  }, [clipSourceVideoId, localVideos, clipInSec]);

  const handleMarkIn = useCallback(() => {
    setClipInSec(clipCurrentTime);
  }, [clipCurrentTime]);

  const handlePlaySection = useCallback(async () => {
    const video = clipVideoRef.current;
    if (!video) return;
    if (clipPlaying) {
      video.pause();
      setClipPlaying(false);
      return;
    }
    video.currentTime = clipInSec;
    try { await video.play(); setClipPlaying(true); } catch { /* autoplay blocked */ }
  }, [clipInSec, clipPlaying]);

  const handleSave = async () => {
    const start_sec = parseTime(startStr);
    const end_sec   = parseTime(endStr);
    if (start_sec == null || end_sec == null || start_sec >= end_sec) {
      setSaveError('Invalid time range');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
      const sectionDuration = end_sec - start_sec;
      const safeClipIn = sourceDuration > 0
        ? Math.max(0, Math.min(clipInSec, sourceDuration - sectionDuration))
        : clipInSec;

      const updated = await api.updateSection(projectId, section.id, {
        type,
        label: label.trim() || undefined,
        simulation_id: simId || undefined,
        // Persist what the user actually edited: the AI prompt text and the toggle state, so a
        // plain Save no longer discards them (frontend-001 / sim-persistence fix). sim_script is
        // NOT sent — it's owned by the generate endpoint, and the old frozen-state copy here used
        // to stamp a stale value across section switches. canReuse safety: the generate endpoint
        // compares against sim_meta.prompt (the prompt that BUILT the bridge), not sim_prompt,
        // so saving a new prompt can't cause a wrong bridge reuse.
        sim_prompt: simPrompt.trim() || null,
        simple_ui: simpleUi,
        auto_script: autoScript,
        start_sec,
        end_sec,
        ...(type === 'clip' ? {
          clip_source_video_id: clipVisualMode === 'video' ? (clipSourceVideoId || null) : null,
          clip_in_sec: clipVisualMode === 'video' ? safeClipIn : 0,
          clip_source_image_id: clipVisualMode === 'image' ? (clipSourceImageId || null) : null,
          camera_movement: cameraMovement,
        } : {}),
        ...(isBroll ? { broll_volume: brollVolume } as Record<string, unknown> : {}),
      });
      onUpdate(updated);
      onClose();
    } catch (err) {
      const msg = (err as Error).message ?? 'Save failed';
      if (msg.toLowerCase().includes('not found')) { onDelete(section.id); return; }
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteSection(projectId, section.id);
      onDelete(section.id);
    } catch {
      onDelete(section.id);
    } finally {
      setDeleting(false);
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────

  // 'clip' is a sub-mode of 'video' — use video colors in the switcher
  const activeTypeDef = TYPES.find(t => t.value === (type === 'clip' ? 'video' : type)) ?? TYPES[0];
  // readySims / activeSim / simPreviewUrl are declared with the preview refs above — the runtime
  // binding needs the document identity before the effects that drive it.
  const activeSimFile = simFiles.find(f => f.key === activeFileKey) ?? null;
  const videoUrl = videoUrls[section.video_file_id] ?? null;
  const simMeta = section.sim_meta as SimMeta | null | undefined ?? null;

  // (D6) The first-paint Minimal-UI cloak for the preview frame. SimSurface turns this into the
  // resolved src (origin rebase + device hints + the always-present #simboot fragment); the
  // iframe `key` and every canReuse/save comparison keep using the RAW simPreviewUrl /
  // section.simulation_url — the resolved URL is never persisted or compared.
  //
  // hideSelectors ride the URL FRAGMENT (see simUrl.ts), so a selection change never reloads a
  // live preview — it only affects the first-paint cloak of a freshly mounted iframe. The
  // fragment is emitted even when nothing is hidden (SimSurface guarantees that): REMOVING it
  // (Simple-UI toggled off, or every control re-checked) is a full navigation, which hard-reloaded
  // the live preview. Memoized so the memoized surface is not handed a new array every render.
  const previewBootHide = useMemo(
    // THE PICKER SUSPENDS THE HIDE. Minimal UI hides an unchecked control, and a hidden control
    // has no box to anchor a badge to — so with the policy live, marking something red would make
    // it vanish along with the only affordance for changing your mind, and a control stored as
    // red would never appear at all. While the panel is open the preview shows everything; the
    // badges carry the state instead, and closing the panel puts the real policy back.
    () => (uiPanelOpen ? NO_BOOT_HIDE
      : simpleUi && effectiveHideSelectors?.length ? effectiveHideSelectors : NO_BOOT_HIDE),
    [uiPanelOpen, simpleUi, effectiveHideSelectors],
  );

  // (P1.1c) Page-wide arbitration: while the preview is actually RUNNING — not merely tab-open,
  // the old gating, which suspended the timeline sim even for a stopped preview and never
  // released when the user hit Stop — this editor holds the page's 'preview-visible' lease. The
  // timeline player consults the lease before every activate/resume, so two concurrent WebGL
  // sims stay impossible without any effect over there having to remember to listen. The
  // 'sim-preview-active' CustomEvent remains as the compatibility pact with VideoPlayer and is
  // now a lease-driven side effect: it fires exactly when the lease is acquired/released.
  // Releasing in the cleanup covers Stop (previewRunning → false), section changes (the reset
  // effect clears previewRunning) and unmount — the lease can never outlive its owner.
  useEffect(() => {
    if (!previewRunning) return;
    const lease = acquireSimulationLease({ id: 'section-editor-preview', priority: 'preview-visible' });
    window.dispatchEvent(new CustomEvent('sim-preview-active', { detail: { active: true } }));
    return () => {
      // Release BEFORE announcing: a pact listener re-evaluating on the event must already see
      // the freed lease, or it would no-op and wait for a broker notification that already ran.
      lease.release();
      window.dispatchEvent(new CustomEvent('sim-preview-active', { detail: { active: false } }));
    };
  }, [previewRunning]);

  // ── Minimal-UI control picker: scanning ───────────────────────────────────
  //
  // THREE LAYERS, TRIED IN ORDER, AND EACH ANSWER IS TAGGED.
  //
  //   live   — the authoring channel. Injected at SERVE time, so it reaches every package that
  //            already exists. This is the layer that fixes the reported bug.
  //   gate   — the scanner baked into the package at publication. Only packages published with a
  //            v3+ gate answer it at all, which is why it could not be the primary path.
  //   static — the server parses the stored HTML. Cannot see a control JavaScript built.
  //
  // "The scanner answered with nothing" and "nothing answered" are different facts and must stay
  // different values all the way to the UI. They used to collapse into `null` two layers before
  // the panel, which is how the header and the body ended up contradicting each other.

  authoringRef.current = authoring;

  /** A tagged result. `null` means this layer did not answer at all. */
  type LayerResult = { controls: SimUiControl[] } | null;

  const requestRuntimeControls = useCallback((): Promise<LayerResult> => {
    return new Promise(resolve => {
      const win = previewIframeRef.current?.contentWindow;
      if (!win) { resolve(null); return; }
      let settled = false;
      let timer = 0;
      const onMsg = (e: MessageEvent) => {
        if (e.source !== previewIframeRef.current?.contentWindow) return;
        const data = e.data as { type?: string; controls?: unknown } | null;
        if (!data || typeof data !== 'object' || data.type !== 'simControlsList') return;
        // A REPLY carrying nothing is an answer: this document has no controls. Only the timeout
        // below means "did not answer". `?? []` is what keeps those apart — sanitizeControls maps
        // an empty list to null, and passing that on would have made an answer look like silence.
        finish({ controls: sanitizeControls(data.controls) ?? [] });
      };
      const finish = (result: LayerResult) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(result);
      };
      timer = window.setTimeout(() => finish(null), 2000);
      window.addEventListener('message', onMsg);
      try { win.postMessage({ type: 'listSimControls' }, '*'); } catch { finish(null); }
    });
  }, []);

  const fetchStaticControls = useCallback(async (): Promise<LayerResult> => {
    if (!simId) return null;
    try {
      const idToken = await getAuth().currentUser?.getIdToken();
      const res = await fetch(
        `${API_URL}/api/v1/projects/${projectId}/simulations/${simId}/ui-controls`,
        { headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined },
      );
      if (!res.ok) return null;
      const body = await res.json() as unknown;
      const raw = Array.isArray(body) ? body : (body as { controls?: unknown } | null)?.controls;
      return { controls: sanitizeControls(raw) ?? [] };
    } catch {
      return null;
    }
  }, [projectId, simId]);

  /** Guards against an older scan landing after a newer one and overwriting it. */
  const uiScanTokenRef = useRef(0);

  const runUiScan = useCallback(async () => {
    if (!simId) return;
    const token = ++uiScanTokenRef.current;
    setUiScan({ phase: 'busy' });

    // The authoring layer first — it is the only one that works regardless of a package's age.
    let live: LayerResult = null;
    if (authoring.status === 'live') {
      try {
        const r = await authoring.scan();
        live = { controls: sanitizeControls(r.controls) ?? [] };
        if (token === uiScanTokenRef.current && live.controls.length > 0) {
          setUiControls(live.controls);
          setUiScan({ phase: 'done', source: 'live', count: live.controls.length, truncated: r.truncated });
          return;
        }
      } catch {
        live = null;   // timed out — fall through to the older layers
      }
    }

    // The old gate is a FALLBACK, not a second opinion. If the authoring layer answered at all —
    // even to say "this document has no controls" — it read the live DOM, and asking the
    // in-package scanner as well can only add a 2s timeout to an answer already in hand.
    const askGate = live === null && rightTab === 'preview' && !!simPreviewUrl;
    const [gate, staticRes] = await Promise.all([
      askGate ? requestRuntimeControls() : Promise.resolve(null),
      fetchStaticControls(),
    ]);
    // A late result for a superseded scan is dropped, never merged: the author has asked a newer
    // question and this one's answer would silently replace it.
    if (token !== uiScanTokenRef.current) return;

    const merged = mergeScans(staticRes?.controls ?? null, gate?.controls ?? null);
    if (merged.length > 0) {
      setUiControls(merged);
      setUiScan({
        phase: 'done',
        source: gate && gate.controls.length > 0 ? 'gate' : 'static',
        count: merged.length,
        truncated: false,
      });
      return;
    }

    // Nothing found. WHICH layers answered is the difference between "this sim has no controls"
    // and "we could not reach anything that knows".
    const answered: UiScanSource[] = [];
    if (live) answered.push('live');
    if (gate) answered.push('gate');
    if (staticRes) answered.push('static');
    setUiScan(answered.length > 0 ? { phase: 'empty', scanned: answered } : { phase: 'unreachable' });
  }, [simId, rightTab, simPreviewUrl, requestRuntimeControls, fetchStaticControls, authoring]);

  // Auto-scan on panel open, and again whenever the authoring channel becomes live — the second
  // trigger is what fixes the old race, where the scan fired before the frame had finished
  // loading and then never retried.
  const uiAutoScanRef = useRef(false);
  useEffect(() => {
    if (!uiPanelOpen) { uiAutoScanRef.current = false; return; }
    if (!simId) return;
    if (uiAutoScanRef.current && authoring.status !== 'live') return;
    if (authoring.status === 'connecting') return;
    uiAutoScanRef.current = true;
    void runUiScan();
    // runUiScan is intentionally omitted: it changes identity with `authoring`, and including it
    // would re-scan on every status transition rather than on the two that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiPanelOpen, simId, authoring.status]);

  // Clip trimmer derived values
  const clipSourceVideo  = localVideos.find(v => v.id === clipSourceVideoId) ?? null;
  const clipUrl          = localClipUrls[clipSourceVideoId] ?? videoUrls[clipSourceVideoId] ?? null;
  const clipSourceDur    = clipSourceVideo?.duration_sec ?? 0;
  const sectionDuration  = section.end_sec - section.start_sec;
  const clipOutSec       = clipInSec + sectionDuration;
  const winLeft          = clipSourceDur > 0 ? (clipInSec / clipSourceDur) * 100 : 0;
  const winWidth         = clipSourceDur > 0 ? Math.min((sectionDuration / clipSourceDur) * 100, 100 - winLeft) : 100;
  const playheadLeft     = clipSourceDur > 0 ? (clipCurrentTime / clipSourceDur) * 100 : 0;

  // ── Style helpers ──────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 38, padding: '0 12px', borderRadius: 8,
    border: '1.5px solid #e5e7eb', backgroundColor: 'hsl(var(--card))',
    fontSize: 13, color: 'hsl(var(--foreground))', outline: 'none',
    boxSizing: 'border-box', fontFamily: 'system-ui, -apple-system, sans-serif',
  };

  /** The picker's small text actions, so three call sites cannot drift apart. */
  const pickerLinkStyle: React.CSSProperties = {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: '#b45309', fontSize: 10, fontWeight: 700, textDecoration: 'underline',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'hsl(var(--muted-foreground))',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    display: 'block', marginBottom: 6,
  };

  /**
   * A card in this editor: the app surface, with a coloured top edge that names it. The colours
   * used to be baked into every card (amber text on an amber wash), which read as a separate,
   * light-only product inside a dark editor.
   */
  const cardStyle = (accent: string): React.CSSProperties => ({
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderTop: `3px solid ${accent}`,
    borderRadius: 12,
    boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)',
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  });

  // Per-type walkthrough (lib/tours/steps.ts): each section kind gets the steps that exist in
  // the current UI state.
  const sectionTourSteps: TourStep[] = toTourSteps(
    isBroll ? SECTION_STEPS_BROLL
    : type === 'simulation' ? [...SECTION_STEPS_SIM_PICK, ...(simId ? SECTION_STEPS_SIM_ATTACHED : [])]
    : type === 'clip' && clipVisualMode === 'image' ? SECTION_STEPS_IMAGE
    : type === 'clip' ? SECTION_STEPS_CLIP
    : SECTION_STEPS_GENERATED,
  );

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          backgroundColor: 'rgba(2,6,23,0.55)',
          backdropFilter: 'blur(10px)', zIndex: 800,
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: isCompactModal ? 0 : '50%',
          left: isCompactModal ? 0 : '50%',
          transform: isCompactModal ? 'none' : 'translate(-50%, -50%)',
          zIndex: 801,
          width: isCompactModal ? '100vw' : '90vw',
          height: isCompactModal ? '100dvh' : 'min(820px, 92dvh)',
          maxHeight: '100dvh',
          display: 'flex', flexDirection: 'column',
          backgroundColor: 'hsl(var(--card))', borderRadius: isCompactModal ? 0 : 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          flexShrink: 0, padding: isCompactModal ? '12px 14px' : '16px 24px',
          borderBottom: '1px solid hsl(var(--shell-border))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12, background: 'hsl(var(--shell))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px', flexWrap: 'wrap' }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              backgroundColor: isBroll ? '#06b6d4' : activeTypeDef.color,
              display: 'inline-block', flexShrink: 0,
              boxShadow: `0 0 0 4px ${isBroll ? 'rgba(6,182,212,0.18)' : 'rgba(99,102,241,0.18)'}`,
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'hsl(var(--shell-foreground))' }}>
              {isBroll ? 'B-Roll Clip' : 'Edit Section'}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600, color: 'hsl(var(--shell-muted))',
              backgroundColor: 'var(--shell-hover)', borderRadius: 6, padding: '2px 8px',
              fontFamily: 'monospace',
            }}>
              {fmtTime(section.start_sec)} → {fmtTime(section.end_sec)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <TourButton
              onClick={() => setTourOpen(true)}
              title="Walk me through this section"
              aria-label="Walk me through this section"
            />
            <button
              onClick={onClose}
              style={{
                width: 30, height: 30, borderRadius: 8,
                border: 'none', backgroundColor: 'transparent',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'hsl(var(--shell-muted))',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--shell-hover)'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-foreground))'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-muted))'; }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <GuidedTour steps={sectionTourSteps} open={tourOpen} onClose={() => setTourOpen(false)} />
        </div>

        {/* ── Body: two-column ── */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: isCompactModal ? 'column' : 'row' }}>

          {/* LEFT: Controls */}
          <div style={{
            width: isCompactModal ? '100%' : 380,
            maxHeight: isCompactModal ? '44dvh' : undefined,
            flexShrink: 0, overflowY: 'auto',
            padding: isCompactModal ? '14px' : '20px 24px',
            display: 'flex', flexDirection: 'column', gap: isCompactModal ? 14 : 20,
            borderRight: isCompactModal ? 'none' : '1px solid #e2e8f0',
            borderBottom: isCompactModal ? '1px solid #e2e8f0' : 'none',
            backgroundColor: 'hsl(var(--card))',
            boxSizing: 'border-box',
          }}>

            {/* Type switcher — Video / Simulation only; Clip is a sub-mode inside Video */}
            {!isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={labelStyle}>Type</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {TYPES.map(t => {
                    const active = (type === t.value) || (t.value === 'video' && type === 'clip');
                    return (
                      <button
                        key={t.value}
                        onClick={() => setType(t.value)}
                        style={{
                          flex: 1, height: 36, borderRadius: 9,
                          border: `1.5px solid ${active ? t.color : '#e5e7eb'}`,
                          backgroundColor: active ? t.bg : '#f9fafb',
                          color: active ? t.text : '#6b7280',
                          fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          transition: 'all 0.12s',
                        }}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: active ? t.color : '#d1d5db', display: 'inline-block', flexShrink: 0 }} />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                {/* Clip sub-mode selector inside Video */}
                {(type === 'video' || type === 'clip') && (
                  <div
                    role="group"
                    aria-label="Video section mode"
                    style={{
                      display: 'flex',
                      width: '100%',
                      height: 36,
                      borderRadius: 9,
                      border: '1.5px solid #bfdbfe',
                      backgroundColor: 'hsl(var(--card))',
                      padding: 2,
                      boxSizing: 'border-box',
                    }}
                  >
                    {[
                      { key: 'video', label: 'Generate B-Roll'  },
                      { key: 'clip',  label: 'Existing Visual'  },
                    ].map(({ key, label: subLabel }) => (
                      <button
                        key={key}
                        onClick={() => setType(key as 'video' | 'clip')}
                        aria-pressed={type === key}
                        style={{
                          flex: 1,
                          height: '100%',
                          borderRadius: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                          border: 'none',
                          backgroundColor: type === key ? '#dbeafe' : 'transparent',
                          color: type === key ? '#1d4ed8' : '#6b7280',
                          transition: 'background-color 0.12s, color 0.12s, box-shadow 0.12s',
                          boxShadow: type === key ? '0 1px 3px rgba(59,130,246,0.18)' : 'none',
                        }}
                      >
                        {subLabel}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Label */}
            <div>
              <label style={labelStyle}>{isBroll ? 'Clip Label' : 'Label'}</label>
              <input
                ref={labelRef}
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
                placeholder={isBroll ? 'B-roll clip description…' : 'e.g. Introduction, Demo…'}
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = '#93c5fd'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
              />
            </div>

            {/* ── CLIP SOURCE PICKER (Existing Visual) ── */}
            {type === 'clip' && !isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ height: 1, backgroundColor: '#f3f4f6' }} />

                <div style={{
                  backgroundColor: 'hsl(var(--card))', border: '1px solid #f1f5f9', borderTop: '3px solid #10b981',
                  borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>{clipVisualMode === 'image' ? '🖼' : '🎞'}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>Clip Source</span>
                    <span style={{ fontSize: 10, color: '#059669', backgroundColor: '#d1fae5', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                      {fmtTime(sectionDuration)} slot
                    </span>
                  </div>

                  {/* Visual type toggle: Video clip vs Still image */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['video', 'image'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setClipVisualMode(mode)}
                        style={{
                          flex: 1, padding: '5px 0', borderRadius: 7, border: '1.5px solid',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          borderColor: clipVisualMode === mode ? '#10b981' : '#e5e7eb',
                          background: clipVisualMode === mode ? '#d1fae5' : '#f9fafb',
                          color: clipVisualMode === mode ? '#065f46' : '#6b7280',
                        }}
                      >
                        {mode === 'video' ? 'Video Clip' : 'Still Image'}
                      </button>
                    ))}
                  </div>

                  {/* ── IMAGE MODE ── */}
                  {clipVisualMode === 'image' && (
                    <>
                      <div>
                        <label style={{ ...labelStyle, color: '#059669' }}>Select Image</label>
                        {images.length === 0 ? (
                          <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
                            Upload images in the Library panel first.
                          </p>
                        ) : (
                          <select
                            value={clipSourceImageId}
                            onChange={e => setClipSourceImageId(e.target.value)}
                            style={{ ...inputStyle, borderColor: '#6ee7b7', color: clipSourceImageId ? '#111827' : '#9ca3af' }}
                          >
                            <option value="">— choose an image —</option>
                            {images.map(img => (
                              <option key={img.id} value={img.id}>{img.filename}</option>
                            ))}
                          </select>
                        )}
                        {/* Selected image preview */}
                        {clipSourceImageId && (() => {
                          const img = images.find(i => i.id === clipSourceImageId);
                          if (!img) return null;
                          return (
                            <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', aspectRatio: '16/9', background: '#000', position: 'relative' }}>
                              <img
                                src={img.original_url}
                                alt={img.filename}
                                style={{
                                  position: 'absolute',
                                  width: `${(1 / (img.crop_w || 1)) * 100}%`,
                                  height: `${(1 / (img.crop_h || 1)) * 100}%`,
                                  left: `${(-img.crop_x / (img.crop_w || 1)) * 100}%`,
                                  top: `${(-img.crop_y / (img.crop_h || 1)) * 100}%`,
                                  objectFit: 'fill',
                                }}
                              />
                            </div>
                          );
                        })()}
                      </div>

                      {/* Camera Movement */}
                      <div {...tourAnchor('sec-camera')}>
                        <label style={{ ...labelStyle, color: '#059669' }}>Camera Movement</label>
                        <select
                          value={cameraMovement}
                          onChange={e => setCameraMovement(e.target.value)}
                          style={{ ...inputStyle, borderColor: '#6ee7b7', color: 'hsl(var(--foreground))' }}
                        >
                          {CAMERA_MOVEMENTS.map(m => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                        <p style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                          Animation runs for the full section duration ({fmtTime(sectionDuration)}).
                        </p>
                      </div>
                    </>
                  )}

                  {/* ── VIDEO MODE ── */}
                  {clipVisualMode === 'video' && (<>
                  {/* Library picker */}
                  <div {...tourAnchor('sec-video')}>
                    <label style={{ ...labelStyle, color: '#059669' }}>From Library</label>
                    <select
                      value={clipSourceVideoId}
                      onChange={e => {
                        setClipSourceVideoId(e.target.value);
                        setClipInSec(0);
                        setClipCurrentTime(0);
                        setClipPlaying(false);
                      }}
                      style={{
                        ...inputStyle,
                        cursor: 'pointer',
                        color: clipSourceVideoId ? '#111827' : '#9ca3af',
                        borderColor: '#6ee7b7',
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = '#10b981'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#6ee7b7'; }}
                    >
                      <option value="">— choose a video —</option>
                      {localVideos.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.filename ?? v.id.slice(0, 8)} {v.duration_sec ? `· ${fmtTime(v.duration_sec)}` : ''}
                        </option>
                      ))}
                    </select>
                    {localVideos.length === 0 && (
                      <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>Upload a video below to get started</p>
                    )}
                  </div>

                  {/* Divider + Upload */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#a7f3d0' }} />
                    <span style={{ fontSize: 10, color: '#6ee7b7', fontWeight: 600 }}>OR</span>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#a7f3d0' }} />
                  </div>

                  <div>
                    <label style={{ ...labelStyle, color: '#059669' }}>Upload New Clip</label>
                    <input
                      ref={clipFileInputRef}
                      type="file"
                      accept=".mp4,.mov,.webm,.mkv,.avi,.m4v"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleClipUpload(file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => clipFileInputRef.current?.click()}
                      disabled={clipUploading}
                      style={{
                        width: '100%', height: 38, borderRadius: 9,
                        border: '1.5px dashed #6ee7b7', backgroundColor: '#f0fdf4',
                        color: '#059669', fontSize: 12, fontWeight: 600,
                        cursor: clipUploading ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        opacity: clipUploading ? 0.7 : 1,
                        transition: 'background-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!clipUploading) (e.currentTarget as HTMLElement).style.backgroundColor = '#dcfce7'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f0fdf4'; }}
                    >
                      {clipUploading ? (
                        <>
                          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #6ee7b7', borderTopColor: '#059669', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          {clipUploadPct != null ? `Uploading ${clipUploadPct}%` : 'Uploading…'}
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                            <path d="M6.5 9V4M4 6.5l2.5-2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <rect x="1.5" y="9.5" width="10" height="2" rx="1" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                          Upload Video
                        </>
                      )}
                    </button>
                    {clipUploadErr && (
                      <p style={{ fontSize: 10, color: '#dc2626', marginTop: 4 }}>{clipUploadErr}</p>
                    )}
                  </div>

                  {/* Selected clip info */}
                  {clipSourceVideo && (
                    <div style={{
                      backgroundColor: '#d1fae5', borderRadius: 8, padding: '10px 12px',
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#065f46', margin: 0 }}>
                        {clipSourceVideo.filename ?? 'Untitled'}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: '#059669' }}>
                          Duration: {clipSourceVideo.duration_sec != null ? fmtTime(clipSourceVideo.duration_sec) : '…'}
                        </span>
                        <span style={{ fontSize: 10, color: '#059669' }}>
                          Clip: {fmtTime(clipInSec)} → {fmtTime(clipOutSec)}
                        </span>
                      </div>
                      {clipSourceDur > 0 && clipSourceDur < sectionDuration && (
                        <p style={{ fontSize: 10, color: '#b45309', margin: 0 }}>
                          ⚠ Source shorter than section slot ({fmtTime(clipSourceDur)} vs {fmtTime(sectionDuration)})
                        </p>
                      )}
                    </div>
                  )}
                  </>) /* end clipVisualMode === 'video' */}
                </div>
              </div>
            )}

            {/* ── SIMULATION CONTROLS ── */}
            {type === 'simulation' && !isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ height: 1, backgroundColor: '#f3f4f6' }} />

                <div {...tourAnchor('sec-sim-select')}>
                  <label style={labelStyle}>Simulation</label>
                  <select
                    value={simId}
                    onChange={e => setSimId(e.target.value)}
                    style={{ ...inputStyle, cursor: 'pointer', color: simId ? '#111827' : '#9ca3af' }}
                    onFocus={e => { e.currentTarget.style.borderColor = '#fcd34d'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
                  >
                    <option value="">— none —</option>
                    {readySims.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {readySims.length === 0 && (
                    <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>Upload a simulation in the panel →</p>
                  )}
                </div>

                {simId && (
                  <div style={cardStyle('#f59e0b')}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span aria-hidden style={{ fontSize: 14 }}>✦</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--foreground))' }}>This moment</span>
                      </div>
                      <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', margin: '4px 0 0', lineHeight: 1.5 }}>
                        What the viewer sees and can touch while this section plays. Describe it, or just
                        choose which controls stay — or both.
                      </p>
                    </div>

                    {/* ① Describe it */}
                    <div {...tourAnchor('sec-sim-prompt')}>
                      <label style={labelStyle} htmlFor={`sim-prompt-${section.id}`}>1 · Describe it <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, opacity: 0.75 }}>— optional</span></label>
                      <textarea
                        id={`sim-prompt-${section.id}`}
                        value={simPrompt}
                        onChange={e => setSimPrompt(e.target.value)}
                        placeholder="e.g. Show the lattice-size slider and start the simulation running"
                        rows={3}
                        maxLength={1000}
                        style={{
                          width: '100%', padding: '10px 12px', borderRadius: 8,
                          border: '1.5px solid hsl(var(--border))', backgroundColor: 'hsl(var(--background))',
                          fontSize: 13, color: 'hsl(var(--foreground))', outline: 'none',
                          resize: 'vertical', boxSizing: 'border-box',
                          fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5,
                        }}
                        onFocus={e => { e.currentTarget.style.borderColor = '#f59e0b'; }}
                        onBlur={e => { e.currentTarget.style.borderColor = 'hsl(var(--border))'; }}
                      />
                      <p style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', textAlign: 'right', margin: '3px 0 0' }}>{simPrompt.length}/1000</p>
                    </div>

                    {/* ② Choose the controls (the Minimal-UI picker) */}
                    <div style={{ marginTop: -4 }} {...tourAnchor('sec-sim-controls')}>
                      <label style={labelStyle}>2 · Choose the controls <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, opacity: 0.75 }}>— optional</span></label>
                      <button
                        type="button"
                        onClick={() => setUiPanelOpen(v => {
                          // Opening it switches to Preview: the badges are drawn in that frame,
                          // and a picker whose visual half is behind another tab is the feature
                          // not working.
                          if (!v) setRightTab('preview');
                          return !v;
                        })}
                        aria-expanded={uiPanelOpen}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                          height: 34, padding: '0 10px', borderRadius: 8,
                          border: '1.5px solid hsl(var(--border))', background: 'hsl(var(--background))',
                          cursor: 'pointer', color: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600,
                        }}
                      >
                        <ChevronDown
                          size={14}
                          strokeWidth={2}
                          aria-hidden
                          style={{ transform: uiPanelOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                        />
                        {/* The label does NOT change on click: a control that renames itself when
                            pressed makes the reader re-read it to find out what just happened. The
                            chevron and aria-expanded carry the state. */}
                        <span>Pick which controls the viewer keeps</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}>
                          {uiControls.length === 0
                            ? 'not scanned'
                            : `${uiControls.length - uiUnchecked.size} of ${uiControls.length} kept`}
                        </span>
                      </button>

                      {uiPanelOpen && (
                        <div style={{
                          marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 10,
                          backgroundColor: 'hsl(var(--card))', padding: 10,
                          display: 'flex', flexDirection: 'column', gap: 8,
                          maxHeight: 300, boxSizing: 'border-box',
                        }}>
                          {/*
                            ONE status line, derived from ONE value. The previous panel kept three
                            independent pieces of state and could render "Not scanned yet" directly
                            above "No controls detected" — each true about a different one of them.
                          */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
                            <span style={{ fontSize: 10.5, color: '#6b7280', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              {uiScan.phase === 'busy' && <span className="ui-scan-dot" aria-hidden />}
                              {uiScan.phase === 'idle' ? 'Open the preview to scan this simulation'
                                : uiScan.phase === 'stored' ? 'Showing your last saved picks'
                                : uiScan.phase === 'busy' ? 'Scanning the live simulation…'
                                : uiScan.phase === 'done'
                                  ? `${uiScan.count} control${uiScan.count === 1 ? '' : 's'} · ${
                                      uiScan.source === 'live' ? 'from the live preview'
                                      : uiScan.source === 'gate' ? 'from the running package'
                                      : 'from the stored HTML'}${uiScan.truncated ? ' · list is capped' : ''}`
                                : uiScan.phase === 'empty' ? 'This simulation exposes no controls'
                                : 'Could not reach the control scanner'}
                            </span>
                            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              {uiUndoStack.length > 0 && (
                                <button type="button" onClick={undoUiToggle} style={pickerLinkStyle} title="Undo the last change">
                                  ↺ Undo
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => { void runUiScan(); }}
                                disabled={uiScan.phase === 'busy'}
                                style={{
                                  height: 22, padding: '0 8px', borderRadius: 6,
                                  border: '1px solid #e5e7eb', backgroundColor: 'hsl(var(--background))',
                                  color: '#6b7280', fontSize: 10, fontWeight: 700,
                                  cursor: uiScan.phase === 'busy' ? 'not-allowed' : 'pointer',
                                  opacity: uiScan.phase === 'busy' ? 0.6 : 1,
                                }}
                              >
                                {uiScan.phase === 'busy' ? 'Scanning…' : '⟳ Rescan'}
                              </button>
                              <button type="button" onClick={() => { setUiUnchecked(new Set()); setUiDirty(true); }} style={pickerLinkStyle}>
                                Keep all
                              </button>
                              <button type="button" onClick={() => { setUiUnchecked(new Set(uiControls.map(c => c.selector))); setUiDirty(true); }} style={pickerLinkStyle}>
                                Hide all
                              </button>
                            </div>
                          </div>

                          {uiControls.length === 0 ? (
                            <div style={{ padding: '14px 4px 6px', textAlign: 'center' }}>
                              <p style={{ fontSize: 11.5, color: '#6b7280', margin: '0 0 3px', fontWeight: 600 }}>
                                {uiScan.phase === 'busy' ? 'Scanning…'
                                  : uiScan.phase === 'empty' ? 'No controls to choose from'
                                  : uiScan.phase === 'unreachable' ? 'The scanner did not answer'
                                  : 'Nothing scanned yet'}
                              </p>
                              <p style={{ fontSize: 10, color: '#9ca3af', margin: '0 0 9px', lineHeight: 1.5 }}>
                                {uiScan.phase === 'empty'
                                  ? 'This simulation has no buttons or sliders for Minimal UI to hide.'
                                  : uiScan.phase === 'unreachable'
                                    ? 'The preview may still be loading — try again in a moment.'
                                    : 'The preview has to be open for the picker to read the simulation.'}
                              </p>
                              {uiScan.phase !== 'busy' && (
                                <button
                                  type="button"
                                  onClick={() => { setRightTab('preview'); void runUiScan(); }}
                                  style={{
                                    height: 26, padding: '0 12px', borderRadius: 7, border: 'none',
                                    backgroundColor: '#f59e0b', color: '#fff', fontSize: 11,
                                    fontWeight: 700, cursor: 'pointer',
                                  }}
                                >
                                  Open preview &amp; scan
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="fine-scrollbar" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {(() => {
                                const renderRow = (c: SimUiControl) => {
                                  const keep = !uiUnchecked.has(c.selector);
                                  const chip = UI_KIND_CHIP[c.kind] ?? UI_KIND_CHIP.other;
                                  const usedByScript = uiScriptTouched.has(c.selector);
                                  return (
                                    <label
                                      key={c.selector}
                                      title={c.selector}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 7,
                                        padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                                        backgroundColor: keep ? 'transparent' : 'rgba(220,38,38,0.05)',
                                        opacity: c.hidden ? 0.72 : 1,
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={keep}
                                        onChange={() => toggleUiControl(c.selector)}
                                        style={{ accentColor: '#16a34a', cursor: 'pointer', flexShrink: 0 }}
                                      />
                                      {/*
                                        Icon AND word, matching the badge drawn on the control
                                        itself — never colour alone (ADR D10), so the state survives
                                        a colour-blind reader and a screenshot.
                                      */}
                                      <span style={{
                                        fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4,
                                        flexShrink: 0, minWidth: 46, textAlign: 'center',
                                        backgroundColor: keep ? 'hsl(var(--success) / 0.14)' : 'hsl(var(--destructive) / 0.14)',
                                        color: keep ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
                                      }}>
                                        {keep ? '✓ Keep' : '✕ Hide'}
                                      </span>
                                      <span style={{
                                        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                                        backgroundColor: chip.bg, color: chip.fg, flexShrink: 0,
                                      }}>
                                        {kindLabel(c.kind)}
                                      </span>
                                      <span style={{
                                        fontSize: 11.5, color: keep ? 'hsl(var(--foreground))' : '#9ca3af',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                        minWidth: 0, flex: 1,
                                      }}>
                                        {c.label}
                                      </span>
                                      {usedByScript && (
                                        <span
                                          title="Detected from events the script dispatched — a control set directly, with no event, cannot be seen this way"
                                          style={{
                                            flexShrink: 0, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.03em',
                                            padding: '1px 5px', borderRadius: 4,
                                            backgroundColor: 'rgba(99,102,241,0.12)', color: '#4f46e5',
                                          }}
                                        >
                                          script?
                                        </span>
                                      )}
                                      {c.hidden && (
                                        <span style={{
                                          flexShrink: 0, fontSize: 8.5, fontWeight: 700,
                                          padding: '1px 5px', borderRadius: 4,
                                          border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
                                        }}>
                                          hidden
                                        </span>
                                      )}
                                    </label>
                                  );
                                };
                                const visibleRows = uiControls.filter(c => !c.hidden);
                                const hiddenRows = uiControls.filter(c => c.hidden);
                                return (
                                  <>
                                    {visibleRows.map(renderRow)}
                                    {hiddenRows.length > 0 && (
                                      <div style={{ margin: '6px 0 1px', padding: '0 6px', fontSize: 9.5, fontWeight: 600, color: '#9ca3af' }}>
                                        Hidden by the simulation — no badge in the preview, pick them here
                                      </div>
                                    )}
                                    {hiddenRows.map(renderRow)}
                                  </>
                                );
                              })()}
                            </div>
                          )}

                          {uiScriptTouched.size > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              <span style={{ fontSize: 10, color: '#4f46e5', flex: 1, minWidth: 0 }}>
                                {uiScriptTouched.size} control{uiScriptTouched.size === 1 ? '' : 's'} looked script-driven
                              </span>
                              <button
                                type="button"
                                onClick={keepScriptUsed}
                                // Disabled on a capped or unscanned list: acting on it would hide
                                // controls the scan never saw (ADR §14.7).
                                disabled={uiScan.phase !== 'done' || uiScan.truncated}
                                title={uiScan.phase === 'done' && !uiScan.truncated
                                  ? 'Keep the script-driven controls visible and hide the rest'
                                  : 'Needs a complete scan of this simulation first'}
                                style={{
                                  height: 22, padding: '0 9px', borderRadius: 6, border: 'none',
                                  backgroundColor: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 700,
                                  cursor: uiScan.phase === 'done' && !uiScan.truncated ? 'pointer' : 'not-allowed',
                                  opacity: uiScan.phase === 'done' && !uiScan.truncated ? 1 : 0.45,
                                }}
                              >
                                Keep only those
                              </button>
                            </div>
                          )}

                          {!simpleUi && (
                            <p style={{ fontSize: 10, color: '#b45309', margin: 0, flexShrink: 0 }}>
                              Simple UI is off — your picks are saved and apply when it&rsquo;s on.
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    <div style={{ marginTop: -4 }}>
                      {/* NOT "Apply them": the apply is the button below, and numbering a
                          setting as the final step told the reader they were finished one
                          control early. Three numbered inputs, then the action. */}
                      <label style={labelStyle}>3 · How it behaves</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
                      {([
                        { key: 'simpleUi' as const,   label: 'Simple UI',   desc: 'Hides irrelevant controls', on: simpleUi,   set: setSimpleUi },
                        { key: 'autoScript' as const, label: 'Auto Script', desc: 'Animates demonstration',    on: autoScript, set: setAutoScript },
                      ] as const).map(({ key, label: tLabel, desc, on, set }) => (
                        <button
                          key={key}
                          type="button"
                          role="switch"
                          aria-checked={on}
                          onClick={() => set((v: boolean) => !v)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', borderRadius: 9,
                            border: `1.5px solid ${on ? '#f59e0b' : 'hsl(var(--border))'}`,
                            // A translucent wash rather than a hex one: it reads as the card's
                            // amber over a light ground AND over a dark one.
                            backgroundColor: on ? 'rgba(245,158,11,0.12)' : 'hsl(var(--muted))',
                            cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                          }}
                        >
                          <span style={{
                            width: 36, height: 20, borderRadius: 10, flexShrink: 0,
                            backgroundColor: on ? '#f59e0b' : 'hsl(var(--muted-foreground))',
                            opacity: on ? 1 : 0.35,
                            position: 'relative', display: 'inline-block', transition: 'background-color 0.15s',
                          }}>
                            <span style={{
                              position: 'absolute', top: 3,
                              left: on ? 18 : 3, width: 14, height: 14,
                              borderRadius: '50%', backgroundColor: 'hsl(var(--card))',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                            }} />
                          </span>
                          <div>
                            {/* The label keeps the theme's own foreground in BOTH states: the
                                on-state amber is legible over a dark card and washed out over a
                                light one, and the amber border, track and knob already say which
                                state this is. */}
                            <p style={{ fontSize: 12, fontWeight: on ? 700 : 600, color: 'hsl(var(--foreground))', margin: 0 }}>{tLabel}</p>
                            <p style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', margin: 0 }}>{desc}</p>
                          </div>
                        </button>
                      ))}
                      </div>
                    </div>

                    {simGenError && (
                      <div style={{ backgroundColor: 'hsl(var(--destructive) / 0.12)', border: '1px solid hsl(var(--destructive) / 0.4)', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 11, color: 'hsl(var(--destructive))', margin: 0 }}>{simGenError}</p>
                      </div>
                    )}

                    {simMeta && !generating && (
                      <div style={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderLeft: '3px solid hsl(var(--success))', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--success))' }}>Last generation</span>
                          {simMeta.confidence != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                              backgroundColor: simMeta.confidence >= 0.8 ? 'hsl(var(--success) / 0.16)' : simMeta.confidence >= 0.5 ? 'hsl(var(--warning) / 0.16)' : 'hsl(var(--destructive) / 0.16)',
                              color: simMeta.confidence >= 0.8 ? 'hsl(var(--success))' : simMeta.confidence >= 0.5 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))',
                            }}>
                              {Math.round(simMeta.confidence * 100)}% confidence
                            </span>
                          )}
                        </div>
                        {/* Render any/all sim_meta fields safely — handles both old BridgePlan shape and new Phase 4 shape */}
                        {(() => {
                          const m = simMeta as unknown as Record<string, unknown>;
                          const provider = m.provider as string | undefined;
                          const model    = m.model    as string | undefined;
                          const targetId = m.targetControlId as string | undefined;
                          const hidden   = [
                            ...((m.hideControlIds    as string[] | undefined) ?? []).map(id => `#${id}`),
                            ...((m.hideButtonIds     as string[] | undefined) ?? []).map(id => `#${id}`),
                            ...((m.hideSelectorStrings as string[] | undefined) ?? []),
                          ];
                          const warns = (m.warnings as string[] | undefined) ?? [];
                          return (
                            <>
                              {provider && (
                                <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                                  Provider: {provider}{model ? ` · ${model}` : ''}
                                </p>
                              )}
                              {targetId && (
                                <p style={{ fontSize: 11, color: '#15803d', margin: 0 }}>
                                  Control: <strong>#{targetId}</strong>
                                </p>
                              )}
                              {hidden.length > 0 && (
                                <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                                  Hidden: {hidden.join(', ')}
                                </p>
                              )}
                              {warns.length > 0 && (
                                <div style={{ backgroundColor: '#fef9c3', border: '1px solid #fde68a', borderRadius: 6, padding: '5px 8px' }}>
                                  {warns.map((w, i) => (
                                    <p key={i} style={{ fontSize: 10, color: '#713f12', margin: 0 }}>⚠ {w}</p>
                                  ))}
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {simMeta.confidence != null && simMeta.confidence < 0.45 && (
                          <div style={{ backgroundColor: 'hsl(var(--destructive) / 0.12)', border: '1px solid hsl(var(--destructive) / 0.4)', borderRadius: 6, padding: '5px 8px' }}>
                            <p style={{ fontSize: 10, color: 'hsl(var(--destructive))', margin: 0 }}>
                              ⚠ Low confidence ({Math.round(simMeta.confidence * 100)}%) — check the script runs correctly before recording
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      {/* WHAT THE BUTTON WILL DO, before it is pressed. The same control used to
                          mean two different things — write a script with AI, or mechanically hide
                          controls — and which one you got depended on whether the prompt happened
                          to be empty. It still does; now it says so. */}
                      <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', margin: '0 0 6px', lineHeight: 1.5 }}>
                        {!canGenerate
                          ? 'Describe the moment, or pick the controls to keep — then apply.'
                          : simPrompt.trim()
                            ? `Uses AI, and counts against your generation limit${hasGenSelection ? '. Also hides the controls you unchecked' : ''}.`
                            : 'Hides the controls you unchecked. No AI, no cost.'}
                      </p>
                      <button
                        {...tourAnchor('sec-sim-generate')}
                        onClick={() => handleGenerateScript()}
                        disabled={generating || !canGenerate}
                        style={{
                          width: '100%', height: 42, borderRadius: 10, border: 'none',
                          background: generating || !canGenerate ? 'hsl(var(--muted))' : 'linear-gradient(135deg,#f59e0b,#d97706)',
                          color: generating || !canGenerate ? 'hsl(var(--muted-foreground))' : '#fff', fontSize: 13, fontWeight: 700,
                          cursor: generating || !canGenerate ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                          transition: 'opacity 0.12s',
                        }}
                        onMouseEnter={e => { if (!generating && canGenerate) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
                        onMouseLeave={e => { if (!generating && canGenerate) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                      >
                        {generating ? (
                          <>
                            <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #ffffff55', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                            {generationStatus ?? 'Working…'}
                          </>
                        ) : !canGenerate ? 'Nothing to apply yet'
                          : simPrompt.trim() ? '✦ Generate with AI'
                          : 'Apply'}
                      </button>
                    </div>
                    {generating && (
                      <button
                        onClick={handleCancelGeneration}
                        style={{
                          width: '100%', height: 32, borderRadius: 8,
                          border: '1.5px solid #fcd34d', backgroundColor: 'transparent',
                          color: '#b45309', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          marginTop: 6,
                        }}
                      >
                        Cancel
                      </button>
                    )}

                  </div>
                )}

                {/* ── Reuse: name this setup, or load one saved elsewhere ──
                    Deliberately OUTSIDE the `simId` gate above. A saved setup carries its own
                    simulation, so a section with nothing in it is exactly where loading one is
                    worth the most — and while this row lived inside that gate the feature was
                    unreachable in the only case it was built for. */}
                {/* A different accent from "This moment" above it. Two cards with the same
                    amber top border read as one card continuing, and these are different
                    features: one writes this section, the other moves it between projects. */}
                <div style={{ ...cardStyle('#0891b2'), gap: 8 }}>
                    <label style={{ ...labelStyle, marginBottom: 0 }}>Reuse this setup</label>
                    <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.5 }}>
                      A saved setup is this section’s whole configuration — the prompt, the script, the
                      kept controls, Simple UI and Auto Script — under a name you can load onto another
                      simulation, in this project or another one.
                    </p>
                    {!simId && (
                      <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, border: '1px dashed hsl(var(--border))' }}>
                        This section has no simulation yet. Loading a saved setup brings its
                        simulation with it — nothing is stored twice.
                      </p>
                    )}
                    <div {...tourAnchor('sec-sim-presets')} style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => { setPresetSaveOpen(true); setPresetLabel(''); setPresetError(null); }}
                        // A bridge worth saving exists once the section HAS a generated setup —
                        // the sim_meta the save snapshots. Before that there is nothing to name.
                        disabled={presetBusy || !simId || !section.sim_meta}
                        title={!section.sim_meta ? 'Apply something first — then this setup can be saved' : 'Save this setup under a name'}
                        style={{
                          flex: 1, height: 30, borderRadius: 8, border: '1.5px solid hsl(var(--border))',
                          backgroundColor: 'transparent', color: 'hsl(var(--foreground))',
                          fontSize: 12, fontWeight: 600,
                          cursor: presetBusy || !simId || !section.sim_meta ? 'not-allowed' : 'pointer',
                          opacity: !simId || !section.sim_meta ? 0.55 : 1,
                        }}
                      >
                        Save setup…
                      </button>
                      <button
                        onClick={openLoadPicker}
                        // A section with NO simulation is exactly where a saved setup is most
                        // useful: it brings its own package with it (owner ruling 2026-09-03).
                        disabled={presetBusy || generating}
                        title="Load a setup you saved — with its simulation, if this section has none"
                        style={{
                          flex: 1, height: 30, borderRadius: 8, border: '1.5px solid hsl(var(--border))',
                          backgroundColor: 'transparent', color: 'hsl(var(--foreground))',
                          fontSize: 12, fontWeight: 600,
                          cursor: presetBusy || generating ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Load setup…
                      </button>
                    </div>
                    {presetNotice && (
                      <div role="status" style={{ marginTop: 6, fontSize: 12, color: 'hsl(var(--success))' }}>{presetNotice}</div>
                    )}
                    {pendingRecipeRegen && (
                      <div
                        role="group"
                        aria-label="Regenerate this setup's script for this simulation"
                        style={{
                          marginTop: 8, padding: 10, borderRadius: 8,
                          border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,0.12)',
                        }}
                      >
                        <div style={{ fontSize: 12, color: 'hsl(var(--foreground))', marginBottom: 8, lineHeight: 1.4 }}>
                          This setup’s script was written for a different simulation, so it was not
                          applied — the current simulation is unchanged. Regenerate it for this one?
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={handleRegenerateForThisSim}
                            disabled={presetBusy || generating}
                            style={{
                              flex: 1, height: 30, borderRadius: 8, border: 'none',
                              background: presetBusy || generating ? '#fcd34d' : 'linear-gradient(135deg,#f59e0b,#d97706)',
                              color: '#fff', fontSize: 12, fontWeight: 700,
                              cursor: presetBusy || generating ? 'not-allowed' : 'pointer',
                            }}
                          >
                            Regenerate for this simulation (uses AI)
                          </button>
                          <button
                            onClick={() => setPendingRecipeRegen(null)}
                            disabled={presetBusy || generating}
                            style={{
                              height: 30, padding: '0 12px', borderRadius: 8,
                              border: '1.5px solid hsl(var(--border))', background: 'transparent',
                              color: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600,
                              cursor: presetBusy || generating ? 'not-allowed' : 'pointer',
                            }}
                          >
                            Not now
                          </button>
                        </div>
                      </div>
                    )}
                </div>

                {/* ── GUIDED SIMULATION (mother-sim-level voice guidance) ── */}
                {simId && (
                  <div style={{ ...cardStyle('#6366f1'), gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span aria-hidden style={{ fontSize: 14 }}>🎙</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--foreground))' }}>Guided Simulation</span>
                      <span style={{ fontSize: 10, color: '#4f46e5', backgroundColor: '#eef2ff', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>Whole simulation</span>
                      {guidanceStatus !== 'none' && (
                        <span style={{
                          marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
                          backgroundColor: guidanceStatus === 'ready' ? '#dcfce7' : guidanceStatus === 'error' ? '#fee2e2' : '#e0e7ff',
                          color: guidanceStatus === 'ready' ? '#166534' : guidanceStatus === 'error' ? '#991b1b' : '#3730a3',
                        }}>{guidanceStatus}</span>
                      )}
                    </div>

                    <p style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.5 }}>
                      Analyzes the whole simulation, writes a 1–2 sentence voice cue per feature and interesting
                      configuration, and plays each once when a viewer first reaches it. Separate from Simple UI / Auto Script.
                    </p>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div style={{ flex: '0 0 auto' }}>
                        <label style={{ ...labelStyle, color: '#4338ca' }}>Language</label>
                        <select
                          value={guidanceLang}
                          onChange={e => setGuidanceLang(e.target.value)}
                          disabled={!!guidanceBusy}
                          style={{ ...inputStyle, cursor: 'pointer', width: 130 }}
                        >
                          {GUIDANCE_LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                        </select>
                      </div>
                      <button
                        onClick={() => runGuidanceStream('generate')}
                        disabled={!!guidanceBusy}
                        style={{
                          flex: 1, height: 42, borderRadius: 10, border: 'none',
                          background: guidanceBusy ? 'linear-gradient(135deg,#c7d2fe,#a5b4fc)' : 'linear-gradient(135deg,#6366f1,#4f46e5)',
                          color: '#fff', fontSize: 13, fontWeight: 700, cursor: guidanceBusy ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        }}
                      >
                        {guidanceBusy === 'analyzing'
                          ? (<><span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #ffffff66', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />{guidanceStatusMsg ?? 'Analyzing…'}</>)
                          : (guidance && guidance.length > 0 ? '↻ Re-analyze' : '✦ Analyze & draft')}
                      </button>
                    </div>

                    {guidanceError && (
                      <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{guidanceError}</p>
                      </div>
                    )}

                    {guidanceMeta && (
                      <p style={{ fontSize: 10, color: '#6b7280', margin: 0 }}>
                        {guidanceMeta.provider ? `${guidanceMeta.provider}${guidanceMeta.model ? ` · ${guidanceMeta.model}` : ''} · ` : ''}
                        {guidanceMeta.entryCount != null ? `${guidanceMeta.entryCount} cues` : ''}
                        {guidanceMeta.droppedCount ? ` · ${guidanceMeta.droppedCount} dropped` : ''}
                        {guidanceMeta.mdUrl ? <> · <a href={guidanceMeta.mdUrl} target="_blank" rel="noreferrer" style={{ color: '#4f46e5' }}>analysis ↗</a></> : null}
                      </p>
                    )}

                    {guidance && guidance.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                        {guidance.map(e => (
                          <div key={e.id} style={{ border: '1px solid #eef2ff', borderRadius: 10, padding: '8px 10px', backgroundColor: e.enabled ? '#fff' : '#f9fafb' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                              <button
                                onClick={() => toggleEntryEnabled(e.id)}
                                title={e.enabled ? 'Enabled' : 'Disabled'}
                                style={{ width: 30, height: 17, borderRadius: 9, border: 'none', flexShrink: 0, backgroundColor: e.enabled ? '#6366f1' : '#d1d5db', position: 'relative', cursor: 'pointer' }}
                              >
                                <span style={{ position: 'absolute', top: 2.5, left: e.enabled ? 15 : 2.5, width: 12, height: 12, borderRadius: '50%', backgroundColor: 'hsl(var(--card))', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left .15s' }} />
                              </button>
                              <span style={{ fontSize: 9, fontWeight: 700, color: e.kind === 'config' ? '#7c3aed' : '#0369a1', backgroundColor: e.kind === 'config' ? '#f3e8ff' : '#e0f2fe', borderRadius: 4, padding: '1px 6px' }}>{e.kind}</span>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                              <span style={{ marginLeft: 'auto', fontSize: 9, color: '#9ca3af' }}>{Math.round((e.confidence ?? 0) * 100)}%</span>
                            </div>
                            <textarea
                              value={e.narration}
                              onChange={ev => setEntryNarration(e.id, ev.target.value)}
                              rows={2}
                              maxLength={400}
                              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 11.5, color: 'hsl(var(--foreground))', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.45, outline: 'none' }}
                            />
                            {e.warnings && e.warnings.length > 0 && (
                              <p style={{ fontSize: 9, color: '#b45309', margin: '3px 0 0' }}>⚠ {e.warnings.join('; ')}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {guidance && guidance.some(e => e.enabled) && (
                      <button
                        onClick={handlePublishGuidance}
                        disabled={!!guidanceBusy}
                        style={{
                          width: '100%', height: 40, borderRadius: 10, border: 'none',
                          background: guidanceBusy ? '#a7f3d0' : 'linear-gradient(135deg,#10b981,#059669)',
                          color: '#fff', fontSize: 13, fontWeight: 700, cursor: guidanceBusy ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        }}
                      >
                        {guidanceBusy === 'publishing'
                          ? (<><span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #ffffff66', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />{guidanceStatusMsg ?? 'Publishing…'}</>)
                          : (guidanceStatus === 'ready' ? '🔊 Update voice guidance' : '🔊 Approve & generate voice')}
                      </button>
                    )}

                    {guidanceBusy && (
                      <button
                        onClick={handleCancelGuidance}
                        style={{ width: '100%', height: 30, borderRadius: 8, border: '1.5px solid #c7d2fe', backgroundColor: 'transparent', color: '#4f46e5', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── VIDEO GENERATION (non-broll video sections) ── */}
            {type === 'video' && !isBroll && (
              <div style={{
                backgroundColor: 'hsl(var(--card))', border: '1px solid #f1f5f9', borderTop: '3px solid #3b82f6',
                borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>🎬</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8' }}>Generate B-Roll</span>
                  <span style={{ fontSize: 10, color: '#2563eb', backgroundColor: '#dbeafe', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>AI Video</span>
                </div>

                <div {...tourAnchor('sec-video-prompt')}>
                  <label style={{ ...labelStyle, color: '#2563eb' }}>Prompt</label>
                  <textarea
                    value={genPrompt}
                    onChange={e => setGenPrompt(e.target.value)}
                    placeholder="Describe the shot… e.g. aerial cityscape at sunset, slow pan"
                    rows={3}
                    maxLength={500}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: '1.5px solid #bfdbfe', backgroundColor: 'hsl(var(--card))',
                      fontSize: 13, color: 'hsl(var(--foreground))', outline: 'none',
                      resize: 'vertical', boxSizing: 'border-box',
                      fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5,
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#bfdbfe'; }}
                  />
                  <p style={{ fontSize: 10, color: '#3b82f6', textAlign: 'right', margin: '3px 0 0', opacity: 0.7 }}>{genPrompt.length}/500</p>
                </div>

                {genError && (
                  <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                    <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{genError}</p>
                  </div>
                )}

                {genJob && (
                  <div style={{
                    borderRadius: 9,
                    border: `1px solid ${genJob.status === 'ready' ? '#6ee7b7' : genJob.status === 'failed' ? '#fca5a5' : '#bfdbfe'}`,
                    backgroundColor: genJob.status === 'ready' ? '#f0fdf4' : genJob.status === 'failed' ? '#fef2f2' : '#f0f9ff',
                    padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    {genJob.status !== 'ready' && genJob.status !== 'failed' && (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#3b82f6', flexShrink: 0, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 600, margin: 0, color: genJob.status === 'ready' ? '#059669' : genJob.status === 'failed' ? '#dc2626' : '#2563eb' }}>
                        {JOB_STATUS_LABEL[genJob.status] ?? genJob.status}
                      </p>
                      {genJob.status !== 'ready' && genJob.status !== 'failed' && (
                        <p style={{ fontSize: 10, color: '#9ca3af', margin: '2px 0 0' }}>{elapsed(genJob.created_at)}</p>
                      )}
                      {genJob.status === 'failed' && genJob.error && (
                        <p style={{ fontSize: 10, color: '#dc2626', margin: '2px 0 0' }}>{genJob.error}</p>
                      )}
                    </div>
                  </div>
                )}

                {(() => {
                  const isVidGenerating = genBusy || (genJob != null && genJob.status !== 'ready' && genJob.status !== 'failed');
                  return (
                    <>
                      <button
                        {...tourAnchor('sec-video-generate')}
                        onClick={handleGenerateVideo}
                        disabled={isVidGenerating || !genPrompt.trim()}
                        style={{
                          width: '100%', height: 42, borderRadius: 10, border: 'none',
                          background: isVidGenerating || !genPrompt.trim() ? 'linear-gradient(135deg,#bfdbfe,#93c5fd)' : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                          color: '#fff', fontSize: 13, fontWeight: 700,
                          cursor: isVidGenerating || !genPrompt.trim() ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                          transition: 'background-color 0.12s',
                        }}
                        onMouseEnter={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
                        onMouseLeave={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                      >
                        {isVidGenerating ? (
                          <>
                            <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                            {genBusy ? 'Queuing…' : 'Generating…'}
                          </>
                        ) : '🎬 Generate Video'}
                      </button>

                      {/* Model dropdown + Enhanced toggle — below generate button */}
                      <div {...tourAnchor('sec-video-options')} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                          value={genModel}
                          onChange={e => setGenModel(e.target.value as GenModel)}
                          style={{
                            flex: 1, height: 34, padding: '0 8px', borderRadius: 8,
                            border: '1.5px solid #bfdbfe', backgroundColor: '#f0f9ff',
                            fontSize: 12, color: '#1d4ed8', fontWeight: 600,
                            cursor: 'pointer', outline: 'none',
                          }}
                        >
                          {(Object.keys(GEN_MODELS) as GenModel[]).map(m => (
                            <option key={m} value={m}>{GEN_MODELS[m]}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => setGenEnhance(v => !v)}
                          title="Enhance prompt with Claude"
                          style={{
                            height: 34, padding: '0 10px', borderRadius: 8, flexShrink: 0,
                            border: `1.5px solid ${genEnhance ? '#3b82f6' : '#e5e7eb'}`,
                            backgroundColor: genEnhance ? '#eff6ff' : '#f9fafb',
                            color: genEnhance ? '#1d4ed8' : '#6b7280',
                            fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 5,
                            transition: 'all 0.12s',
                          }}
                        >
                          <span style={{ width: 26, height: 14, borderRadius: 7, flexShrink: 0, backgroundColor: genEnhance ? '#3b82f6' : '#d1d5db', position: 'relative', display: 'inline-block', transition: 'background-color 0.15s' }}>
                            <span style={{ position: 'absolute', top: 2, left: genEnhance ? 13 : 2, width: 10, height: 10, borderRadius: '50%', backgroundColor: 'hsl(var(--card))', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s' }} />
                          </span>
                          Enhanced
                        </button>
                      </div>
                      {genModel === 'veo' && (section.end_sec - section.start_sec) > 8 && (
                        <p style={{ fontSize: 10, color: '#92400e', margin: 0 }}>Veo max is 8s — generation will be capped.</p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* ── BROLL INFO ── */}
            {isBroll && (
              <div {...tourAnchor('sec-broll-info')} style={{
                backgroundColor: 'hsl(var(--card))', border: '1px solid #f1f5f9', borderTop: '3px solid #06b6d4',
                borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>🎬</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0e7490' }}>AI-Generated B-Roll</span>
                </div>
                {section.label && (
                  <div>
                    <p style={{ fontSize: 10, fontWeight: 600, color: '#0e7490', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 5px' }}>Generation Prompt</p>
                    <p style={{ fontSize: 12, color: '#155e75', margin: 0, lineHeight: 1.55, fontStyle: 'italic' }}>"{section.label}"</p>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: '#0891b2', backgroundColor: '#cffafe', borderRadius: 5, padding: '2px 8px', fontWeight: 600 }}>
                    {fmtTime(section.end_sec - section.start_sec)} clip
                  </span>
                </div>

                {/* Volume control — Premiere-style audio gain */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#0e7490', flexShrink: 0 }}>🔊</span>
                  <input
                    type="range"
                    min={0} max={1} step={0.01}
                    value={brollVolume}
                    onChange={e => setBrollVolume(parseFloat(e.target.value))}
                    onMouseUp={async () => {
                      try {
                        await api.updateSection(projectId, section.id, {
                          broll_volume: brollVolume,
                        } as Parameters<typeof api.updateSection>[2]);
                      } catch { /* ignore */ }
                    }}
                    style={{ flex: 1, accentColor: '#06b6d4', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#0891b2', fontFamily: 'monospace', minWidth: 34 }}>
                    {Math.round(brollVolume * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* ── TIMING (collapsible) ── */}
            <div>
              <button
                onClick={() => setShowTiming(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
                  cursor: 'pointer', padding: '2px 0', width: '100%', textAlign: 'left',
                }}
              >
                <span style={labelStyle as React.CSSProperties}>Timing</span>
                <span style={{
                  width: 28, height: 28, borderRadius: 8, display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', color: '#6b7280',
                  backgroundColor: '#f3f4f6', border: '1px solid #e5e7eb',
                }}>
                  {showTiming ? <ChevronUp size={16} strokeWidth={1.9} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.9} aria-hidden />}
                </span>
                {!showTiming && (
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto', fontFamily: 'monospace' }}>
                    {startStr} → {endStr}
                  </span>
                )}
              </button>
              {showTiming && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                {[
                  { label: 'Start', value: startStr, set: setStartStr },
                  { label: 'End',   value: endStr,   set: setEndStr   },
                ].map(({ label: tLabel, value, set }) => (
                  <div key={tLabel}>
                    <p style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 5px' }}>{tLabel}</p>
                    <input
                      type="text"
                      value={value}
                      onChange={e => set(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'monospace', height: 36, fontSize: 13 }}
                      onFocus={e => { e.currentTarget.style.borderColor = '#93c5fd'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
                    />
                  </div>
                ))}
              </div>
              )}
            </div>

            {saveError && (
              <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{saveError}</p>
              </div>
            )}
          </div>

          {/* RIGHT: Preview / Trimmer / Files */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
            backgroundColor: '#111827', position: 'relative',
          }}>

            {/* ── CLIP TRIMMER (right panel, type=clip) ── */}
            {type === 'clip' && !isBroll && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                {/* Video preview */}
                <div style={{ flex: 1, position: 'relative', backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {clipUrl ? (
                    <video
                      key={clipUrl}
                      ref={clipVideoRef}
                      src={clipUrl}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      preload="metadata"
                      onLoadedMetadata={() => {
                        if (clipVideoRef.current) {
                          clipVideoRef.current.currentTime = clipInSec;
                          setClipCurrentTime(clipInSec);
                        }
                      }}
                      onTimeUpdate={() => {
                        const v = clipVideoRef.current;
                        if (!v) return;
                        setClipCurrentTime(v.currentTime);
                        // Auto-stop at out-point when playing selection
                        if (clipPlaying && v.currentTime >= clipInSec + sectionDuration) {
                          v.pause();
                          v.currentTime = clipInSec;
                          setClipCurrentTime(clipInSec);
                          setClipPlaying(false);
                        }
                      }}
                      onEnded={() => setClipPlaying(false)}
                      onPause={() => setClipPlaying(false)}
                    />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                      <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                        <rect x="4" y="12" width="44" height="28" rx="5" stroke="#374151" strokeWidth="2" />
                        <path d="M20 20l14 6-14 6V20z" fill="#4b5563" />
                      </svg>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                        {clipSourceVideoId ? 'Loading video…' : 'Select a source video'}
                      </p>
                    </div>
                  )}

                  {/* In/Out overlay badges */}
                  {clipUrl && clipSourceDur > 0 && (
                    <div style={{
                      position: 'absolute', bottom: 10, left: 0, right: 0,
                      display: 'flex', justifyContent: 'center', gap: 8, pointerEvents: 'none',
                    }}>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#f59e0b', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace', fontWeight: 700 }}>
                        IN {fmtTimeLong(clipInSec)}
                      </span>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#94a3b8', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace' }}>
                        {fmtTimeLong(clipCurrentTime)}
                      </span>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#f59e0b', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace', fontWeight: 700 }}>
                        OUT {fmtTimeLong(clipOutSec)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Scrubber + controls area */}
                {clipUrl && (
                  <div style={{ flexShrink: 0, backgroundColor: '#0f172a', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                    {/* Time ruler labels */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>
                        {fmtTimeLong(0)}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700 }}>
                          In: {fmtTimeLong(clipInSec)}
                        </span>
                        <span style={{ fontSize: 10, color: '#64748b' }}>·</span>
                        <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                          Dur: {fmtTime(sectionDuration)}
                        </span>
                        <span style={{ fontSize: 10, color: '#64748b' }}>·</span>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700 }}>
                          Out: {fmtTimeLong(clipOutSec)}
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>
                        {clipSourceDur > 0 ? fmtTimeLong(clipSourceDur) : '…'}
                      </span>
                    </div>

                    {/* Scrubber track */}
                    <div
                      ref={clipScrubRef}
                      onMouseDown={handleScrubMouseDown}
                      style={{
                        position: 'relative', height: 48,
                        backgroundColor: '#1e293b', borderRadius: 6,
                        cursor: 'crosshair', userSelect: 'none', overflow: 'visible',
                      }}
                    >
                      {/* Track background grid lines */}
                      <div style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, transparent, transparent calc(10% - 1px), rgba(255,255,255,0.04) calc(10% - 1px), rgba(255,255,255,0.04) 10%)' }} />
                      </div>

                      {/* Selection window */}
                      {clipSourceDur > 0 && (
                        <div
                          onMouseDown={handleWindowMouseDown}
                          style={{
                            position: 'absolute',
                            top: 0, bottom: 0,
                            left: `${winLeft}%`,
                            width: `${winWidth}%`,
                            backgroundColor: 'rgba(245,158,11,0.2)',
                            border: '2px solid #f59e0b',
                            borderRadius: 4,
                            cursor: 'grab',
                            boxSizing: 'border-box',
                          }}
                        >
                          {/* Left in-point handle */}
                          <div style={{
                            position: 'absolute', left: -1, top: 0, bottom: 0, width: 4,
                            backgroundColor: '#f59e0b', borderRadius: '3px 0 0 3px',
                          }} />
                          {/* Right out-point handle */}
                          <div style={{
                            position: 'absolute', right: -1, top: 0, bottom: 0, width: 4,
                            backgroundColor: '#f59e0b', borderRadius: '0 3px 3px 0',
                          }} />
                          {/* Duration label inside window (only if wide enough) */}
                          {winWidth > 10 && (
                            <div style={{
                              position: 'absolute', inset: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              pointerEvents: 'none',
                            }}>
                              <span style={{ fontSize: 9, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700, opacity: 0.8 }}>
                                {fmtTime(sectionDuration)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Red playhead */}
                      {clipSourceDur > 0 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: -5, bottom: -5,
                            left: `${playheadLeft}%`,
                            width: 2,
                            backgroundColor: '#ef4444',
                            borderRadius: 1,
                            pointerEvents: 'none',
                            transform: 'translateX(-1px)',
                          }}
                        >
                          <div style={{
                            position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
                            width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444',
                          }} />
                        </div>
                      )}
                    </div>

                    {/* Controls row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      {/* Mark In button */}
                      <button
                        onClick={handleMarkIn}
                        title="Set in-point to current time (I)"
                        style={{
                          height: 30, padding: '0 12px', borderRadius: 6,
                          border: '1.5px solid #334155', backgroundColor: '#1e293b',
                          color: '#f59e0b', fontSize: 11, fontWeight: 700,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                          transition: 'background-color 0.1s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#334155'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#1e293b'; }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M3 1v8M3 5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        Mark In
                      </button>

                      {/* Play In→Out */}
                      <button
                        onClick={handlePlaySection}
                        disabled={!clipSourceDur}
                        style={{
                          height: 30, padding: '0 14px', borderRadius: 6,
                          border: 'none',
                          backgroundColor: clipPlaying ? '#7c3aed' : '#10b981',
                          color: '#fff', fontSize: 11, fontWeight: 700,
                          cursor: clipSourceDur ? 'pointer' : 'not-allowed',
                          display: 'flex', alignItems: 'center', gap: 5,
                          opacity: clipSourceDur ? 1 : 0.4,
                          transition: 'background-color 0.1s',
                        }}
                        onMouseEnter={e => { if (clipSourceDur) (e.currentTarget as HTMLElement).style.backgroundColor = clipPlaying ? '#6d28d9' : '#059669'; }}
                        onMouseLeave={e => { if (clipSourceDur) (e.currentTarget as HTMLElement).style.backgroundColor = clipPlaying ? '#7c3aed' : '#10b981'; }}
                      >
                        {clipPlaying ? '⏸ Pause' : '▶ Play In→Out'}
                      </button>

                      <div style={{ flex: 1 }} />

                      {/* Current time display */}
                      <span style={{ fontSize: 11, color: '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>
                        {fmtTimeLong(clipCurrentTime)}
                      </span>

                      {/* Keyboard hint */}
                      <span style={{ fontSize: 9, color: '#334155', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 3, padding: '2px 5px', fontFamily: 'monospace' }}>I</span>
                      <span style={{ fontSize: 9, color: '#475569' }}>= mark in</span>
                    </div>
                  </div>
                )}

                {/* Empty state when no video selected */}
                {!clipUrl && (
                  <div style={{ flexShrink: 0, backgroundColor: '#0f172a', padding: '16px 20px' }}>
                    <p style={{ fontSize: 11, color: '#475569', margin: 0, textAlign: 'center' }}>
                      Select or upload a source video on the left to open the clip trimmer
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── SIMULATION right panel ── */}
            {type === 'simulation' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, padding: '10px 12px', borderBottom: '1px solid #e5e7eb', backgroundColor: 'hsl(var(--card))' }}>
                  <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 8, backgroundColor: '#f1f5f9', border: '1px solid #e2e8f0' }}>
                    {(['preview', 'files'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => setRightTab(t)}
                        style={{
                          height: 30, minWidth: 82, padding: '0 12px', borderRadius: 6, border: 'none',
                          backgroundColor: rightTab === t ? '#ffffff' : 'transparent',
                          color: rightTab === t ? '#111827' : '#64748b',
                          boxShadow: rightTab === t ? '0 1px 3px rgba(15,23,42,0.12)' : 'none',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        {t === 'preview' ? 'Preview' : 'Files'}
                      </button>
                    ))}
                  </div>

                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {rightTab === 'preview' && simPreviewUrl && (
                      <>
                        <button
                          onClick={runPreview}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #bbf7d0',
                            backgroundColor: previewRunning ? '#dcfce7' : '#f0fdf4',
                            color: '#166534', fontSize: 11, fontWeight: 800, cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Play size={13} strokeWidth={2.2} aria-hidden />
                          Run
                        </button>
                        <button
                          onClick={stopPreview}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e5e7eb',
                            backgroundColor: 'hsl(var(--card))', color: '#475569', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Square size={12} strokeWidth={2.2} aria-hidden />
                          Stop
                        </button>
                        <button
                          onClick={handleDownloadSimulationZip}
                          disabled={zipDownloadBusy || !simId}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #ede9fe',
                            backgroundColor: '#f5f3ff', color: '#6d28d9', fontSize: 11, fontWeight: 800,
                            cursor: zipDownloadBusy || !simId ? 'not-allowed' : 'pointer', opacity: zipDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Archive size={13} strokeWidth={2} aria-hidden />
                          {zipDownloadBusy ? 'Zipping…' : 'ZIP'}
                        </button>
                      </>
                    )}

                    {rightTab === 'files' && (
                      <>
                        <button
                          onClick={handleCopyActiveFile}
                          disabled={!activeSimFile || fileContentLoading || fileContent == null}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e0f2fe',
                            backgroundColor: copiedFile ? '#dcfce7' : '#f0f9ff',
                            color: copiedFile ? '#166534' : '#0369a1', fontSize: 11, fontWeight: 800,
                            cursor: !activeSimFile || fileContentLoading || fileContent == null ? 'not-allowed' : 'pointer',
                            opacity: !activeSimFile || fileContentLoading || fileContent == null ? 0.5 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          {copiedFile ? <Check size={13} strokeWidth={2.2} aria-hidden /> : <Copy size={13} strokeWidth={2} aria-hidden />}
                          {copiedFile ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          onClick={handleDownloadActiveFile}
                          disabled={!activeSimFile || fileDownloadBusy}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e5e7eb',
                            backgroundColor: 'hsl(var(--card))', color: '#475569', fontSize: 11, fontWeight: 700,
                            cursor: !activeSimFile || fileDownloadBusy ? 'not-allowed' : 'pointer', opacity: fileDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Download size={13} strokeWidth={2} aria-hidden />
                          {fileDownloadBusy ? 'Saving…' : 'File'}
                        </button>
                        <button
                          onClick={handleDownloadSimulationZip}
                          disabled={zipDownloadBusy || !simId}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #ede9fe',
                            backgroundColor: '#f5f3ff', color: '#6d28d9', fontSize: 11, fontWeight: 800,
                            cursor: zipDownloadBusy || !simId ? 'not-allowed' : 'pointer', opacity: zipDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Archive size={13} strokeWidth={2} aria-hidden />
                          {zipDownloadBusy ? 'Zipping…' : 'ZIP'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {rightTab === 'preview' ? (
                  simPreviewUrl ? (
                    <div ref={simPreviewShellRef} style={{ flex: 1, minHeight: 0, backgroundColor: 'hsl(var(--card))', overflow: 'hidden', position: 'relative' }}>
                      <SimSurface
                        // Remount on a real document change, exactly as before.
                        key={simPreviewUrl}
                        src={simPreviewUrl}
                        bootHide={previewBootHide}
                        // NO reveal policy on this surface. The editor preview has never faded:
                        // the frame is simply visible the whole time the Preview tab is open, and
                        // gating it on runtime visibility (which holds a reveal until a paint or
                        // an ack) could leave a working sim hidden behind a blank panel.
                        visible
                        frameRef={previewFrameRef}
                        onLoad={handlePreviewFrameLoad}
                        title={activeSim?.name ?? 'Simulation preview'}
                        // allow-pointer-lock is why this surface passes its own sandbox: sims
                        // driven with a dragged camera need it, and the default set omits it.
                        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                        style={SIM_PREVIEW_FRAME_STYLE}
                      />
                      {/* Fullscreen toggle — always visible, uses fixed when in fullscreen */}
                      <button
                        onClick={toggleSimFullscreen}
                        title={isSimFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                        style={{
                          position: isSimFullscreen ? 'fixed' : 'absolute',
                          top: 8, right: 8,
                          zIndex: 9999,
                          width: 32, height: 32,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.3)',
                          background: 'rgba(0,0,0,0.45)',
                          backdropFilter: 'blur(4px)',
                          color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer',
                          opacity: 0.7,
                          transition: 'opacity 0.15s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                      >
                        {isSimFullscreen
                          ? <Minimize2 size={14} strokeWidth={2} aria-hidden />
                          : <Maximize2 size={14} strokeWidth={2} aria-hidden />
                        }
                      </button>
                    </div>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: 'hsl(var(--card))' }}>
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <circle cx="24" cy="24" r="19" stroke="#cbd5e1" strokeWidth="2" />
                        <path d="M24 14v10l6 4.5" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>Select a simulation to preview</p>
                    </div>
                  )
                ) : (
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: 'hsl(var(--card))' }}>
                    {simFilesLoading ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'spin 0.8s linear infinite' }} />
                      </div>
                    ) : simFilesError ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>Failed to load files</p>
                        <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>{simFilesError}</p>
                      </div>
                    ) : simFiles.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>No source files found</p>
                        <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>Re-upload the simulation to restore files</p>
                      </div>
                    ) : (
                      <>
                        <div className="fine-scrollbar" style={{ display: 'flex', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid #e5e7eb', backgroundColor: 'hsl(var(--card))' }}>
                          {simFiles.map(f => {
                            const isAiBridge = f.filename.startsWith('section_') && f.ext === 'js';
                            const isAiHtml   = f.filename.startsWith('section_') && f.ext === 'html';
                            const isActive   = f.key === activeFileKey;
                            return (
                              <button
                                key={f.key}
                                onClick={() => setActiveFileKey(f.key)}
                                title={f.key}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                                  padding: '9px 12px', fontSize: 11, fontWeight: isActive ? 800 : 600,
                                  color: isActive ? '#1d4ed8' : '#64748b',
                                  background: isActive ? '#eff6ff' : 'transparent',
                                  borderTop: 'none', borderLeft: 'none', borderRight: '1px solid #e5e7eb',
                                  borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                                  cursor: 'pointer', whiteSpace: 'nowrap',
                                }}
                              >
                                {f.filename}
                                {(isAiBridge || isAiHtml) && (
                                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, backgroundColor: '#dbeafe', color: '#1d4ed8' }}>AI</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <div className="fine-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', backgroundColor: 'hsl(var(--card))' }}>
                          {fileContentLoading ? (
                            <div style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'spin 0.8s linear infinite' }} />
                              <span style={{ fontSize: 11, color: '#64748b' }}>Loading…</span>
                            </div>
                          ) : activeSimFile && !activeSimFile.isText ? (
                            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>Binary file — cannot display</p>
                              <a href={activeSimFile.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#3b82f6' }}>Open in new tab ↗</a>
                            </div>
                          ) : fileContent !== null ? (
                            <pre style={{ margin: 0, padding: '16px 18px', fontSize: 11.5, lineHeight: 1.65, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2 }}>
                              {fileContent}
                            </pre>
                          ) : (
                            <div style={{ padding: 20 }}>
                              <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>Select a file above</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── VIDEO / BROLL right panel ── */}
            {(type === 'video' || isBroll) && (
              videoUrl ? (
                <div style={{ flex: 1, position: 'relative', minHeight: 0, backgroundColor: '#111827' }}>
                  <video
                    ref={rightVideoRef}
                    src={videoUrl}
                    controls
                    style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#111827' }}
                  />
                  <button
                    type="button"
                    onClick={() => openFullscreen(rightVideoRef.current)}
                    title="Fullscreen"
                    style={{
                      position: 'absolute', top: 12, right: 12,
                      height: 32, width: 32, borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.16)',
                      backgroundColor: 'rgba(15,23,42,0.74)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
                    }}
                  >
                    <Maximize2 size={15} strokeWidth={2} aria-hidden />
                  </button>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <rect x="4" y="10" width="40" height="28" rx="4" stroke="#374151" strokeWidth="2" />
                    <path d="M18 18l14 6-14 6V18z" fill="#4b5563" />
                  </svg>
                  <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Video preview not available</p>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>HLS transcoding may still be in progress</p>
                </div>
              )
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          flexShrink: 0,
          padding: isCompactModal ? '10px 14px max(10px, env(safe-area-inset-bottom))' : '14px 24px',
          borderTop: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10, backgroundColor: 'hsl(var(--card))',
        }}>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleting}
            style={{
              height: 36, padding: '0 16px', borderRadius: 8,
              border: '1.5px solid #fecaca', backgroundColor: 'hsl(var(--card))',
              color: '#ef4444', fontSize: 13, fontWeight: 500,
              cursor: deleting ? 'not-allowed' : 'pointer',
              opacity: deleting ? 0.5 : 1, transition: 'background-color 0.1s',
            }}
            onMouseEnter={e => { if (!deleting) (e.currentTarget as HTMLElement).style.backgroundColor = '#fef2f2'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fff'; }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <button
              onClick={onClose}
              style={{
                height: 36, padding: '0 16px', borderRadius: 8,
                border: '1.5px solid #e5e7eb', backgroundColor: 'hsl(var(--card))',
                color: '#6b7280', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f9fafb'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fff'; }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                height: 36, padding: '0 22px', borderRadius: 8,
                border: 'none',
                background: saving ? 'linear-gradient(135deg,#93c5fd,#818cf8)' : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', transition: 'background-color 0.12s',
              }}
              onMouseEnter={e => { if (!saving) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
              onMouseLeave={e => { if (!saving) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>

      {/* ── SAVE BRIDGE: name the current setup ─────────────────────────────────────────── */}
      {/* PORTALED to document.body, exactly as ConfirmDialog below does and for the same
          reason: the editor modal sits at zIndex 800/801, and an overlay rendered INSIDE its
          tree at a lower z opens BEHIND it — the click works, the dialog opens, and nobody
          sees it. That was the owner-reported "Save bridge does nothing" bug. */}
      {presetSaveOpen && createPortal(
        <div
          role="dialog" aria-modal="true" aria-label="Save setup"
          style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => !presetBusy && setPresetSaveOpen(false)}
        >
          <form
            onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); handleSavePreset(); }}
            style={{ width: 380, borderRadius: 12, padding: 18, backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Save setup</div>
            <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', margin: '0 0 10px' }}>
              Names this section&apos;s script, toggles and minimal-UI selection so you can load them
              onto another video without setting them up again.
            </p>
            <input
              autoFocus
              value={presetLabel}
              onChange={e => setPresetLabel(e.target.value)}
              maxLength={120}
              placeholder="e.g. plucking a boid with one button"
              style={{ width: '100%', height: 34, borderRadius: 8, border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))', padding: '0 10px', fontSize: 13 }}
            />
            {presetError && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{presetError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPresetSaveOpen(false)} disabled={presetBusy}
                style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid hsl(var(--border))', backgroundColor: 'transparent', color: 'hsl(var(--foreground))', fontSize: 12, cursor: 'pointer' }}>
                Cancel
              </button>
              <button type="submit" disabled={presetBusy || !presetLabel.trim()}
                style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', backgroundColor: '#d97706', color: '#fff', fontSize: 12, fontWeight: 700, cursor: presetBusy || !presetLabel.trim() ? 'not-allowed' : 'pointer' }}>
                {presetBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}

      {/* ── LOAD BRIDGE: pick a saved setup; the server says which path the load takes ────── */}
      {loadOpen && createPortal(
        <div
          role="dialog" aria-modal="true" aria-label="Load setup"
          style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => !presetBusy && setLoadOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 460, maxHeight: '70vh', display: 'flex', flexDirection: 'column', borderRadius: 12, padding: 18, backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Load setup</div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 80 }}>
              {presets === null ? (
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>Loading your saved bridges…</div>
              ) : presets.length === 0 ? (
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                  Nothing saved yet. Set up any section the way you want it and press &ldquo;Save setup&rdquo;.
                </div>
              ) : presets.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleSelectPreset(p)}
                  aria-pressed={selectedPreset?.id === p.id}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4,
                    borderRadius: 8, cursor: 'pointer',
                    border: selectedPreset?.id === p.id ? '1.5px solid #d97706' : '1px solid hsl(var(--border))',
                    backgroundColor: selectedPreset?.id === p.id ? 'rgba(217,119,6,0.08)' : 'transparent',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>
                    {p.has_artifact ? 'script + settings' : 'settings only'}
                    {/* WHICH package it was built against. A preset's label describes what it
                        does ("plucking a boid with one button"); this says what it does it TO,
                        which is what decides whether it will fit here. */}
                    {p.source_simulation_name ? ` · from “${p.source_simulation_name}”` : ''}
                    {p.sim_prompt ? ` · ${p.sim_prompt.slice(0, 60)}${p.sim_prompt.length > 60 ? '…' : ''}` : ''}
                  </div>
                </button>
              ))}
            </div>
            {/* THE PRESET'S PACKAGE, WHEN THIS PROJECT DOES NOT HAVE IT.
                A preset is a configuration FOR a simulation. Loading "plucking a boid with one
                button" onto a video with no boids package leaves the recipe with nothing to cook —
                so when the source is importable and absent here, offer to bring it. Since
                migration 080 that costs no storage: the bytes already exist and the import writes
                only rows. */}
            {selectedPreset?.source_importable
              && !!simId
              && !simulations.some(sim => sim.id === selectedPreset.source_simulation_id) && (
              <div style={{ marginTop: 10, padding: 8, borderRadius: 8, border: '1px solid hsl(var(--border))' }}>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  This preset was built for <strong>{selectedPreset.source_simulation_name}</strong>, which
                  this project does not have.
                </div>
                <button
                  type="button"
                  onClick={() => importPresetSimulation(selectedPreset)}
                  disabled={presetBusy}
                  style={{
                    height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid #d97706',
                    backgroundColor: 'transparent', color: '#b45309', fontSize: 12, fontWeight: 600,
                    cursor: presetBusy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {presetBusy ? 'Bringing it in…' : 'Bring the simulation too'}
                </button>
                <span style={{ marginLeft: 8, fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                  nothing is stored twice
                </span>
              </div>
            )}

            {selectedPreset && !simId && presetFit?.bring?.needed && (
              <div style={{ marginTop: 10, padding: 8, borderRadius: 8, border: '1px solid hsl(var(--border))', fontSize: 12, lineHeight: 1.5 }}>
                This section has no simulation yet. {presetFit.bring.description}
              </div>
            )}

            {selectedPreset && (
              <div role="status" style={{ marginTop: 10, fontSize: 12, color: 'hsl(var(--muted-foreground))', minHeight: 18 }}>
                {fitLoading
                  ? 'Checking compatibility…'
                  // The sentence is SERVER-composed (describeLoadPath) so the promise on this
                  // screen and the decision on the wire cannot drift apart.
                  : presetFit?.description ?? 'Compatibility unknown — loading will regenerate from the saved settings.'}
              </div>
            )}
            {presetError && <div role="alert" style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>{presetError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setLoadOpen(false)} disabled={presetBusy}
                style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid hsl(var(--border))', backgroundColor: 'transparent', color: 'hsl(var(--foreground))', fontSize: 12, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={handleConfirmLoad}
                disabled={presetBusy || !selectedPreset || fitLoading}
                style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', backgroundColor: '#d97706', color: '#fff', fontSize: 12, fontWeight: 700, cursor: presetBusy || !selectedPreset || fitLoading ? 'not-allowed' : 'pointer' }}
              >
                {presetBusy ? 'Loading…'
                  : !simId && presetFit?.bring?.needed && presetFit.bring.possible
                    ? `Bring ${presetFit.bring.source_name ? `“${presetFit.bring.source_name}”` : 'the simulation'} and load`
                  : presetFit?.path === 'artifact' ? 'Apply instantly'
                  : 'Load settings'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title={type === 'simulation' ? 'Delete simulation section?' : type === 'clip' ? 'Delete clip section?' : 'Delete section?'}
          description="This will permanently remove the section from your timeline. This cannot be undone."
          confirmLabel="Delete section"
          onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}
