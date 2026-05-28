'use client';

import { useState, useEffect } from 'react';
import type { TimelineSection } from 'shared/src/generated/client-v1';
import { api } from '../lib/api';

const SECTION_TYPES = [
  { value: 'video', label: 'Video', color: 'bg-blue-500' },
  { value: 'simulation', label: 'Simulation', color: 'bg-amber-500' },
  { value: 'intro', label: 'Intro', color: 'bg-emerald-500' },
  { value: 'outro', label: 'Outro', color: 'bg-violet-500' },
  { value: 'cut', label: 'Cut', color: 'bg-red-500' },
  { value: 'custom', label: 'Custom', color: 'bg-gray-400' },
] as const;

interface Props {
  section: TimelineSection;
  projectId: string;
  onUpdate: (s: TimelineSection) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function parseTime(str: string): number | null {
  const parts = str.split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseFloat(parts[1]);
  if (isNaN(m) || isNaN(s)) return null;
  return m * 60 + s;
}

export function SectionEditor({ section, projectId, onUpdate, onDelete, onClose }: Props) {
  const [type, setType] = useState(section.type);
  const [label, setLabel] = useState(section.label ?? '');
  const [notes, setNotes] = useState(section.notes ?? '');
  const [startStr, setStartStr] = useState(fmtTime(section.start_sec));
  const [endStr, setEndStr] = useState(fmtTime(section.end_sec));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setType(section.type);
    setLabel(section.label ?? '');
    setNotes(section.notes ?? '');
    setStartStr(fmtTime(section.start_sec));
    setEndStr(fmtTime(section.end_sec));
  }, [section.id]);

  const handleSave = async () => {
    const start_sec = parseTime(startStr);
    const end_sec = parseTime(endStr);
    if (start_sec == null || end_sec == null || start_sec >= end_sec) return;

    setSaving(true);
    try {
      const updated = await api.updateSection(projectId, section.id, {
        type, label: label || undefined, notes: notes || undefined, start_sec, end_sec,
      });
      onUpdate(updated);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteSection(projectId, section.id);
      onDelete(section.id);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-72 bg-popover border border-border rounded-xl shadow-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Edit section</p>
        <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Type picker */}
      <div className="grid grid-cols-3 gap-1.5">
        {SECTION_TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setType(t.value)}
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              type === t.value
                ? 'border-primary bg-primary/8 text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${t.color}`} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Times */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground font-medium block mb-1">Start (m:ss.s)</label>
          <input
            type="text"
            value={startStr}
            onChange={(e) => setStartStr(e.target.value)}
            className="w-full h-8 px-2 rounded-lg border border-input bg-card text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground font-medium block mb-1">End (m:ss.s)</label>
          <input
            type="text"
            value={endStr}
            onChange={(e) => setEndStr(e.target.value)}
            className="w-full h-8 px-2 rounded-lg border border-input bg-card text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Label */}
      <input
        type="text"
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-full h-8 px-2.5 rounded-lg border border-input bg-card text-xs focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
      />

      {/* Notes */}
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className="w-full px-2.5 py-2 rounded-lg border border-input bg-card text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
      />

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="h-8 px-3 rounded-lg border border-destructive/30 text-destructive text-xs font-medium hover:bg-destructive/5 transition-colors disabled:opacity-50"
        >
          {deleting ? '…' : 'Delete'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 h-8 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
