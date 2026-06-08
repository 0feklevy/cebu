// UI metadata for the avatar characters. Einstein is the default across all videos.
export interface CharacterMeta {
  id: string;
  displayName: string;
  nametag: string;
  emoji: string;
  portrait: string;
  startingLabel: string;
  leaveLabel: string;
  voiceSensitivity: number;
}

export type CharacterMetaOverride = Partial<Omit<CharacterMeta, 'id'>>;

export const CHARACTER_META: Record<string, CharacterMeta> = {
  einstein: {
    id: 'einstein',
    displayName: 'Albert Einstein',
    nametag: 'Albert Einstein',
    emoji: '🧠',
    portrait: '/avatars/einstein.png',
    startingLabel: 'Connecting to Einstein…',
    leaveLabel: 'End conversation',
    voiceSensitivity: 0.5,
  },
  darwin: {
    id: 'darwin', displayName: 'Charles Darwin', nametag: 'Charles Darwin', emoji: '🪲',
    portrait: '/avatars/darwin.png', startingLabel: 'Connecting to Darwin…', leaveLabel: 'End conversation', voiceSensitivity: 0.5,
  },
  napoleon: {
    id: 'napoleon', displayName: 'Napoleon Bonaparte', nametag: 'Napoleon Bonaparte', emoji: '⚔️',
    portrait: '/avatars/napoleon.png', startingLabel: 'Connecting to Napoleon…', leaveLabel: 'End conversation', voiceSensitivity: 0.3,
  },
  archimedes: {
    id: 'archimedes', displayName: 'Archimedes', nametag: 'Archimedes of Syracuse', emoji: '📐',
    portrait: '/avatars/archimedes.png', startingLabel: 'Connecting to Archimedes…', leaveLabel: 'End conversation', voiceSensitivity: 0.7,
  },
};

export const DEFAULT_CHARACTER_ID = 'einstein';
function compactOverride(overrides?: CharacterMetaOverride): CharacterMetaOverride {
  if (!overrides) return {};
  return {
    ...(overrides.displayName?.trim() ? { displayName: overrides.displayName.trim() } : {}),
    ...(overrides.nametag?.trim() ? { nametag: overrides.nametag.trim() } : {}),
    ...(overrides.emoji?.trim() ? { emoji: overrides.emoji.trim() } : {}),
    ...(overrides.portrait?.trim() ? { portrait: overrides.portrait.trim() } : {}),
    ...(overrides.startingLabel?.trim() ? { startingLabel: overrides.startingLabel.trim() } : {}),
    ...(overrides.leaveLabel?.trim() ? { leaveLabel: overrides.leaveLabel.trim() } : {}),
    ...(typeof overrides.voiceSensitivity === 'number' ? { voiceSensitivity: overrides.voiceSensitivity } : {}),
  };
}

export function characterMeta(id?: string, overrides?: CharacterMetaOverride): CharacterMeta {
  const base = CHARACTER_META[id ?? DEFAULT_CHARACTER_ID] ?? CHARACTER_META[DEFAULT_CHARACTER_ID];
  return { ...base, ...compactOverride(overrides) };
}
