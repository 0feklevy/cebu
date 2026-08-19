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

/**
 * The default is a LAST RESORT for a session whose character the server has already resolved —
 * never a stand-in for one it has not. See PENDING_CHARACTER_META.
 */
export const DEFAULT_CHARACTER_ID = 'einstein';

/**
 * THE IDENTITY TO SHOW BEFORE THE SERVER HAS SAID WHOSE AVATAR THIS IS.
 *
 * The popup renders a name, a portrait and a "Connecting to …" label from the moment it opens,
 * but it learns the video's actual persona only when POST /api/v1/avatar/start answers — the
 * slowest call in the product. Seeding that gap from DEFAULT_CHARACTER_ID meant every viewer of
 * every video, whatever persona its owner had configured, spent the whole connect looking at
 * "Ask Albert Einstein", Einstein's portrait and "Connecting to Einstein…". That is the reported
 * bug, and it is not a display detail: it is the product asserting an identity it does not know.
 *
 * So: name nobody until somebody is named. `startingLabel` still says what is happening.
 */
export const PENDING_CHARACTER_META: CharacterMeta = {
  id: '',
  displayName: 'the avatar',
  nametag: '',
  emoji: '✨',
  portrait: '',
  startingLabel: 'Connecting…',
  leaveLabel: 'End conversation',
  voiceSensitivity: 0.5,
};

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
  const over = compactOverride(overrides);
  // A `displayName` from the server describes the avatar the SESSION actually uses. When that is
  // not this character's own name, the character's portrait, emoji and labels belong to somebody
  // else and must not be inherited: merging them produced the exact mismatch the owner reported —
  // the name "Pnina" over Einstein's face, and "Connecting to Einstein…" for a video whose
  // configured persona is not Einstein and whose avatar simply had no portrait to send.
  const renamed = Boolean(over.displayName && over.displayName !== base.displayName);
  const ground: CharacterMeta = renamed
    ? {
        ...base,
        nametag: over.displayName!,
        emoji: PENDING_CHARACTER_META.emoji,
        portrait: '',
        startingLabel: `Connecting to ${over.displayName}…`,
      }
    : base;
  return { ...ground, ...over };
}

/**
 * Where the session's `characterId` came from — the server's own answer, not a guess.
 * 'default' means nobody chose it; it is this product's internal fallback.
 */
export type CharacterSource = 'configured' | 'requested' | 'default';

/**
 * THE IDENTITY TO PUT ON SCREEN.
 *
 * `characterId` is a ROUTING value: which prompt and voice the session runs as. It is never
 * empty, because a session must run as something. Treating it as an IDENTITY is what put "Ask
 * Albert Einstein", Einstein's portrait and "Connecting to Einstein…" in front of every viewer of
 * every project that had configured no persona at all.
 *
 * The popup's old guard (`resolvedCharacter || display?.displayName`) could not catch this,
 * because `resolvedCharacter` is ALWAYS truthy once the start answers — so the neutral branch was
 * unreachable at precisely the moment it was needed, and the fallback character was rendered as
 * though the owner had picked it.
 *
 * The rule, in order:
 *   1. a name the server supplied describes the avatar the session actually uses — always trust it;
 *   2. otherwise a character someone genuinely CHOSE may lend its name and portrait;
 *   3. otherwise name nobody. `startingLabel` still says what is happening.
 */
export function displayIdentity(
  characterId: string | undefined,
  source: CharacterSource | undefined,
  display?: CharacterMetaOverride,
): CharacterMeta {
  if (display?.displayName?.trim()) return characterMeta(characterId, display);
  if (characterId && source && source !== 'default') return characterMeta(characterId, display);
  // Keep whatever non-identifying detail the server sent (voice sensitivity, labels) — just never
  // a name, a face or a "Connecting to <somebody>…" for a somebody nobody chose.
  return { ...PENDING_CHARACTER_META, ...compactOverride(display) };
}
