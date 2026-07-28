// Manual avatar-circle sections: user-marked [in,out] ranges on the editor
// timeline (global video seconds — the same coordinate the viewer's globalTime
// and b-roll `global_offset_sec` use). Stored in avatar_config.avatarCircles.
// manualSections and rendered by AvatarCirclesOverlay when the visibility mode
// includes 'manual'.

export interface CircleSection {
  id: string;
  start_sec: number;
  end_sec: number;
}

export const MIN_CIRCLE_SECTION_SEC = 0.5;

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cs-${Math.random().toString(36).slice(2, 10)}`);

export const makeCircleSection = (start_sec: number, end_sec: number): CircleSection => ({
  id: newId(),
  start_sec,
  end_sec,
});

/**
 * Canonical form: clamped to [0, totalSec], dropped when shorter than
 * MIN_CIRCLE_SECTION_SEC, sorted by start, overlaps/touching ranges merged
 * (the earlier range's id wins). Safe on unsorted/garbage input.
 */
export function normalizeCircleSections(
  ranges: ReadonlyArray<CircleSection>,
  totalSec: number = Infinity,
): CircleSection[] {
  const cleaned = ranges
    .map((r) => ({
      id: r.id || newId(),
      start_sec: Math.max(0, Math.min(r.start_sec, totalSec)),
      end_sec: Math.max(0, Math.min(r.end_sec, totalSec)),
    }))
    .map((r) => (r.end_sec < r.start_sec ? { ...r, start_sec: r.end_sec, end_sec: r.start_sec } : r))
    .filter((r) => r.end_sec - r.start_sec >= MIN_CIRCLE_SECTION_SEC)
    .sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);

  const merged: CircleSection[] = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (last && r.start_sec <= last.end_sec + 0.001) {
      last.end_sec = Math.max(last.end_sec, r.end_sec);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** True when t falls inside any range (ranges need not be normalized). */
export function inCircleSection(ranges: ReadonlyArray<CircleSection> | undefined | null, t: number): boolean {
  if (!ranges?.length) return false;
  for (const r of ranges) {
    if (t >= r.start_sec && t < r.end_sec) return true;
  }
  return false;
}

/** Which visibility layers a config value enables (legacy values included). */
export function circlesLayers(visibility: string | undefined): { broll: boolean; manual: boolean; always: boolean } {
  const v = visibility ?? 'broll';
  return {
    always: v === 'always',
    broll: v === 'broll' || v === 'broll+manual',
    manual: v === 'manual' || v === 'broll+manual',
  };
}
