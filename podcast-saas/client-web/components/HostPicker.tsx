'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Host } from 'shared';

interface Props {
  selectedAId: string;
  selectedBId: string;
  onSelectA: (id: string) => void;
  onSelectB: (id: string) => void;
}

const DEFAULT_HOSTS: Pick<Host, 'id' | 'name' | 'role' | 'persona_text'>[] = [
  {
    id: 'preset-expert',
    name: 'Alex Chen',
    role: 'Domain Expert',
    persona_text: 'Knowledgeable, precise, loves going deep on nuances',
  },
  {
    id: 'preset-curious',
    name: 'Sam Rivera',
    role: 'Curious Learner',
    persona_text: 'Asks great questions, keeps things accessible, warmly skeptical',
  },
  {
    id: 'preset-skeptic',
    name: 'Jordan Park',
    role: 'Skeptic',
    persona_text: 'Challenges assumptions, devil\'s advocate, sharp and direct',
  },
  {
    id: 'preset-storyteller',
    name: 'Casey Morgan',
    role: 'Storyteller',
    persona_text: 'Brings narratives, analogies, and human context to any topic',
  },
];

export function HostPicker({ selectedAId, selectedBId, onSelectA, onSelectB }: Props) {
  const [hosts, setHosts] = useState<typeof DEFAULT_HOSTS>(DEFAULT_HOSTS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.listHosts()
      .then((res) => {
        if (res.length > 0) {
          setHosts([...DEFAULT_HOSTS, ...res]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const HostCard = ({
    host,
    label,
    selected,
    onSelect,
    disabled,
  }: {
    host: (typeof DEFAULT_HOSTS)[0];
    label: 'A' | 'B';
    selected: boolean;
    onSelect: () => void;
    disabled: boolean;
  }) => (
    <button
      onClick={onSelect}
      disabled={disabled && !selected}
      className={`w-full text-left p-4 rounded-xl border transition-colors ${
        selected
          ? 'border-primary bg-primary/10'
          : disabled
          ? 'border-border bg-card/50 opacity-40 cursor-not-allowed'
          : 'border-border bg-card hover:border-primary/50'
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
            selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'
          }`}
        >
          {selected ? label : host.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{host.name}</div>
          <div className="text-xs text-muted-foreground truncate">{host.role}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{host.persona_text}</p>
    </button>
  );

  return (
    <div className="space-y-6">
      {['A', 'B'].map((label) => {
        const selectedId = label === 'A' ? selectedAId : selectedBId;
        const otherId = label === 'A' ? selectedBId : selectedAId;
        const onSelect = label === 'A' ? onSelectA : onSelectB;

        return (
          <div key={label}>
            <h3 className="text-sm font-medium mb-3">
              Host {label}{' '}
              {selectedId && (
                <span className="text-primary text-xs">
                  — {hosts.find((h) => h.id === selectedId)?.name}
                </span>
              )}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {hosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  label={label as 'A' | 'B'}
                  selected={selectedId === host.id}
                  onSelect={() => onSelect(host.id)}
                  disabled={otherId === host.id}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
