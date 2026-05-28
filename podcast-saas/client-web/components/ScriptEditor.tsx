'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Script, DialogueTurn, AudioTag, Emotion } from 'shared';
import { AudioTagSchema, EmotionSchema } from 'shared';
import { DialogueTurnCard } from './DialogueTurnCard';
import { api } from '../lib/api';

interface VersionSummary {
  version: number;
  status: string;
  approved_at: string | null;
  created_at: string;
}

interface Props {
  projectId: string;
  version: number;
  script: Script;
  hostAName: string;
  hostBName: string;
  isApproved: boolean;
  versions?: VersionSummary[];
}

export function ScriptEditor({
  projectId,
  version,
  script,
  hostAName,
  hostBName,
  isApproved,
  versions = [],
}: Props) {
  const router = useRouter();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [regenHint, setRegenHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(version);
  const [currentScript, setCurrentScript] = useState(script);
  const [currentTurn, setCurrentTurn] = useState<DialogueTurn | null>(null);

  const selectTurn = (i: number) => {
    setSelectedIndex(i);
    const turn = currentScript.turns[i];
    setCurrentTurn(turn);
    setEditText(turn.text);
    setRegenHint('');
  };

  const applyNewVersion = (newVersion: number, newTurns: DialogueTurn[]) => {
    setCurrentVersion(newVersion);
    setCurrentScript((s) => ({ ...s, turns: newTurns }));
  };

  const handleSaveTurn = async () => {
    if (selectedIndex === null || !currentTurn) return;
    setSaving(true);
    try {
      const res = await api.updateTurn(projectId, currentVersion, selectedIndex, {
        text: editText,
        emotion: currentTurn.emotion,
        audio_tags: currentTurn.audio_tags,
      });
      const turns = [...currentScript.turns];
      turns[selectedIndex] = { ...currentTurn, text: editText };
      applyNewVersion(res.new_version, turns);
      setCurrentTurn(turns[selectedIndex]);
    } finally {
      setSaving(false);
    }
  };

  const handleRegenTurn = async () => {
    if (selectedIndex === null) return;
    setSaving(true);
    try {
      const res = await api.regenerateTurn(projectId, currentVersion, selectedIndex, {
        hint: regenHint || undefined,
      });
      const turns = [...currentScript.turns];
      turns[selectedIndex] = res.turn;
      applyNewVersion(res.new_version, turns);
      setCurrentTurn(res.turn);
      setEditText(res.turn.text);
    } finally {
      setSaving(false);
    }
  };

  const handleSwapSpeaker = async () => {
    if (selectedIndex === null || !currentTurn) return;
    setSaving(true);
    try {
      const newSpeaker: 'host_a' | 'host_b' = currentTurn.speaker === 'host_a' ? 'host_b' : 'host_a';
      const res = await api.updateTurn(projectId, currentVersion, selectedIndex, {
        speaker: newSpeaker,
      });
      const turns = [...currentScript.turns];
      turns[selectedIndex] = { ...currentTurn, speaker: newSpeaker };
      applyNewVersion(res.new_version, turns);
      setCurrentTurn(turns[selectedIndex]);
    } finally {
      setSaving(false);
    }
  };

  const handleSplit = async () => {
    if (selectedIndex === null || !currentTurn) return;
    const words = editText.trim().split(/\s+/);
    const mid = Math.ceil(words.length / 2);
    const partA = words.slice(0, mid).join(' ');
    const partB = words.slice(mid).join(' ');
    if (!partA || !partB) return;

    setSaving(true);
    try {
      const turns = [...currentScript.turns];
      turns[selectedIndex] = { ...currentTurn, text: partA };
      const newTurn: DialogueTurn = {
        ...currentTurn,
        text: partB,
        is_hook: false,
        audio_tags: [],
        b_roll: null,
      };
      turns.splice(selectedIndex + 1, 0, newTurn);
      const res = await api.replaceTurns(projectId, currentVersion, turns);
      applyNewVersion(res.new_version, turns);
      setCurrentTurn(turns[selectedIndex]);
      setEditText(partA);
    } finally {
      setSaving(false);
    }
  };

  const handleMergeWithNext = async () => {
    if (selectedIndex === null || !currentTurn) return;
    const nextTurn = currentScript.turns[selectedIndex + 1];
    if (!nextTurn) return;

    setSaving(true);
    try {
      const merged: DialogueTurn = {
        ...currentTurn,
        text: `${currentTurn.text} ${nextTurn.text}`,
      };
      const turns = [...currentScript.turns];
      turns[selectedIndex] = merged;
      turns.splice(selectedIndex + 1, 1);
      const res = await api.replaceTurns(projectId, currentVersion, turns);
      applyNewVersion(res.new_version, turns);
      setCurrentTurn(merged);
      setEditText(merged.text);
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      await api.approveScript(projectId, currentVersion);
      router.refresh();
    } finally {
      setApproving(false);
    }
  };

  const handleVersionSwitch = async (v: number) => {
    if (v === currentVersion) return;
    try {
      const res = await api.getScriptVersion(projectId, v);
      if (res.body_json) {
        setCurrentVersion(v);
        setCurrentScript(res.body_json as Script);
        setSelectedIndex(null);
        setCurrentTurn(null);
      }
    } catch {
      // ignore
    }
  };

  const totalTurns = currentScript.turns.length;
  const hostATurns = currentScript.turns.filter((t) => t.speaker === 'host_a').length;
  const hostBTurns = totalTurns - hostATurns;
  const isLastTurn = selectedIndex !== null && selectedIndex === totalTurns - 1;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border gap-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-lg truncate">{currentScript.title}</h1>
          <p className="text-xs text-muted-foreground">
            {totalTurns} turns · ~{Math.round(currentScript.total_estimated_seconds / 60)} min
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Version history dropdown */}
          {versions.length > 1 && (
            <select
              value={currentVersion}
              onChange={(e) => handleVersionSwitch(parseInt(e.target.value, 10))}
              className="text-sm rounded-lg border border-border bg-card px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}{v.approved_at ? ' ✓' : ''} — {v.status}
                </option>
              ))}
            </select>
          )}

          {isApproved ? (
            <span className="text-sm text-green-400 bg-green-400/10 px-3 py-1.5 rounded-lg border border-green-400/20">
              ✓ Approved
            </span>
          ) : (
            <button
              onClick={handleApprove}
              disabled={approving}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {approving ? 'Approving…' : 'Approve & Generate Video'}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: script list */}
        <div className="w-[55%] overflow-y-auto p-4 space-y-2 border-r border-border">
          <div className="flex items-center gap-3 px-2 mb-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-blue-600 inline-block" /> {hostAName}: {hostATurns}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-emerald-600 inline-block" /> {hostBName}: {hostBTurns}
            </span>
          </div>

          {currentScript.turns.map((turn, i) => (
            <DialogueTurnCard
              key={i}
              turn={turn}
              index={i}
              isSelected={selectedIndex === i}
              hostAName={hostAName}
              hostBName={hostBName}
              onSelect={() => selectTurn(i)}
            />
          ))}
        </div>

        {/* Right: detail panel */}
        <div className="w-[45%] overflow-y-auto p-6">
          {selectedIndex === null || !currentTurn ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm text-center">
              <div className="text-4xl mb-3">👆</div>
              <p>Select a turn to edit it</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Turn {selectedIndex + 1}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-mono ${
                      currentTurn.speaker === 'host_a'
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-emerald-500/20 text-emerald-400'
                    }`}
                  >
                    {currentTurn.speaker === 'host_a' ? hostAName : hostBName}
                  </span>
                </div>

                {/* Quick actions */}
                <div className="flex items-center gap-1.5">
                  <ActionButton onClick={handleSwapSpeaker} disabled={saving} title="Swap speaker">
                    ⇄
                  </ActionButton>
                  <ActionButton
                    onClick={handleSplit}
                    disabled={saving || editText.trim().split(/\s+/).length < 4}
                    title="Split into two turns"
                  >
                    ✂
                  </ActionButton>
                  <ActionButton
                    onClick={handleMergeWithNext}
                    disabled={saving || isLastTurn}
                    title="Merge with next turn"
                  >
                    ⊕
                  </ActionButton>
                </div>
              </div>

              {/* Text editor */}
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1.5">Text</label>
                <textarea
                  className="w-full rounded-lg border border-input bg-card p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring min-h-32"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                />
              </div>

              {/* Emotion */}
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1.5">Emotion</label>
                <div className="flex flex-wrap gap-1.5">
                  {EmotionSchema.options.map((e) => (
                    <button
                      key={e}
                      onClick={() => setCurrentTurn({ ...currentTurn, emotion: e as Emotion })}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${
                        currentTurn.emotion === e
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/40'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              {/* Audio tags */}
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1.5">Audio tags</label>
                <div className="flex flex-wrap gap-1.5">
                  {AudioTagSchema.options.map((tag) => {
                    const active = currentTurn.audio_tags.includes(tag as AudioTag);
                    return (
                      <button
                        key={tag}
                        onClick={() => {
                          const tags = active
                            ? currentTurn.audio_tags.filter((t) => t !== tag)
                            : [...currentTurn.audio_tags, tag as AudioTag];
                          setCurrentTurn({ ...currentTurn, audio_tags: tags });
                        }}
                        className={`text-xs px-2.5 py-1 rounded-full border font-mono transition-colors ${
                          active
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-primary/40'
                        }`}
                      >
                        [{tag}]
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Save */}
              <button
                onClick={handleSaveTurn}
                disabled={saving || editText === currentTurn.text}
                className="w-full py-2.5 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>

              {/* Regenerate */}
              <div className="border-t border-border pt-4 space-y-3">
                <label className="text-xs text-muted-foreground font-medium block">
                  Regenerate with AI
                </label>
                <input
                  type="text"
                  placeholder="Optional hint (e.g. make this funnier)"
                  value={regenHint}
                  onChange={(e) => setRegenHint(e.target.value)}
                  className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={handleRegenTurn}
                  disabled={saving}
                  className="w-full py-2.5 bg-primary/20 border border-primary/30 text-primary rounded-lg text-sm font-medium hover:bg-primary/30 transition-colors disabled:opacity-40"
                >
                  {saving ? 'Regenerating…' : '✦ Regenerate'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-7 h-7 flex items-center justify-center rounded border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
