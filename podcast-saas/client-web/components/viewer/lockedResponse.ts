'use client';

import type { LockedContent } from 'shared/src/generated/client-v1';
import type { PlayerConfig } from './types';

/**
 * `GET /api/v1/projects/:id/player-config`, `GET /api/v1/share/:token` and the permalink config
 * route each answer with ONE of two shapes: a paywall stub, or a full PlayerConfig. Never both.
 *
 * Their callers modelled that as an INTERSECTION — `PlayerConfig & Partial<LockedContent>` — a
 * type that claims every field of both variants is present at once, which is the opposite of the
 * server's guarantee (types-011). Two costs, one of them user-visible:
 *
 *   • narrowing was disabled exactly where it was needed: `data.segments` typechecked inside the
 *     locked branch, where it does not exist;
 *   • `if (!data.segments.length)` sat one line after the cast, so ANY 200 body that was neither
 *     variant threw `TypeError: Cannot read properties of undefined (reading 'length')` — caught
 *     and rendered to the viewer as the on-screen error text.
 *
 * This is a DISCRIMINATOR, not a schema. It answers "which variant is this?" and guarantees the
 * one field the caller immediately dereferences; the rest of the payload stays the viewer's
 * business, exactly as before. A full PlayerConfig schema here would duplicate a shape the viewer
 * already owns and would start rejecting configs over fields it never reads.
 */
export type PlayerConfigResponse =
  | { kind: 'locked';   locked: LockedContent }
  | { kind: 'config';   config: PlayerConfig }
  | { kind: 'unusable' };

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}

/**
 * `locked: true` is the discriminant the server sets literally. Anything else — absent, `false`,
 * or truthy-but-not-`true` — is NOT a paywall and must fall through, rather than raise an overlay
 * with a blank title and a blank price.
 */
function readLocked(body: Record<string, unknown>): LockedContent | null {
  if (body.locked !== true) return null;
  if (typeof body.content_id !== 'string') return null;
  if (typeof body.currency !== 'string') return null;
  if (!isNullableString(body.title)) return null;
  if (!isNullableNumber(body.price_cents)) return null;
  return {
    locked:       true,
    content_type: (body.content_type ?? 'project') as LockedContent['content_type'],
    content_id:   body.content_id,
    title:        body.title,
    price_cents:  body.price_cents,
    currency:     body.currency,
  };
}

export function readPlayerConfigResponse(body: unknown): PlayerConfigResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unusable' };
  const record = body as Record<string, unknown>;

  const locked = readLocked(record);
  if (locked) return { kind: 'locked', locked };

  // An EMPTY segments array is a legitimate config — "this project has no videos yet" is a state
  // the callers report with their own wording, and swallowing it here would replace a precise
  // message with a generic one.
  if (!Array.isArray(record.segments)) return { kind: 'unusable' };
  return { kind: 'config', config: record as unknown as PlayerConfig };
}
