'use client';

import type { DialogueTurn } from 'shared';

interface Props {
  turn: DialogueTurn;
  index: number;
  isSelected: boolean;
  hostAName: string;
  hostBName: string;
  onSelect: () => void;
}

const EMOTION_COLORS: Record<string, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  enthusiastic: 'bg-yellow-500/20 text-yellow-400',
  thoughtful: 'bg-blue-500/20 text-blue-400',
  agreeing: 'bg-green-500/20 text-green-400',
  analytical: 'bg-purple-500/20 text-purple-400',
  amused: 'bg-orange-500/20 text-orange-400',
  surprised: 'bg-pink-500/20 text-pink-400',
};

export function DialogueTurnCard({
  turn,
  index,
  isSelected,
  hostAName,
  hostBName,
  onSelect,
}: Props) {
  const isHostA = turn.speaker === 'host_a';
  const name = isHostA ? hostAName : hostBName;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-4 rounded-xl border transition-all ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border bg-card hover:border-primary/30'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
            isHostA ? 'bg-blue-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {name[0]}
        </div>
        <span className="text-sm font-medium">{name}</span>
        {turn.is_hook && (
          <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded font-mono">HOOK</span>
        )}
        <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${EMOTION_COLORS[turn.emotion] ?? 'bg-secondary text-secondary-foreground'}`}>
          {turn.emotion}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-foreground/90 line-clamp-4">{turn.text}</p>

      {turn.audio_tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {turn.audio_tags.map((tag) => (
            <span key={tag} className="text-xs bg-secondary/50 text-muted-foreground px-1.5 py-0.5 rounded font-mono">
              [{tag}]
            </span>
          ))}
        </div>
      )}

      {turn.b_roll && (
        <div className="mt-2 text-xs text-muted-foreground bg-secondary/30 rounded px-2 py-1">
          B-roll: {turn.b_roll.type} {turn.b_roll.prompt ? `— "${turn.b_roll.prompt}"` : ''}
        </div>
      )}
    </button>
  );
}
