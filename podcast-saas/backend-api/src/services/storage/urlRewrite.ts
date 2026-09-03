/**
 * The URL rewrite for a storage cutover — the pure half.
 *
 * Several columns hold a PUBLIC URL rather than a key (`projects.thumbnail_url`,
 * `image_files.original_url`, `audio_files.url`, `playlists.banner_url`, `simulations.entry_file`
 * when it is a URL, `avatar_visuals.image_url` / `sim_entry_url`, `corpora.storage_url`, and the
 * guidance URLs inside `simulations.guidance_meta` / `guidance`). Moving the bytes to another
 * vendor moves nothing those rows point at. This plans the rewrite: a URL under one of the FROM
 * bases becomes `<to base>/<key>`; anything else is left exactly as it is.
 */
import { keyFromPublicUrlAgainst } from './publicUrlKeys.js';

export interface RewritePlan {
  from: string;
  to: string;
  key: string;
}

/** The rewrite for one URL, or null when it is not under any FROM base (or already under TO). */
export function planUrlRewrite(url: string | null | undefined, fromBases: readonly string[], toBase: string): RewritePlan | null {
  if (!url) return null;
  const to = toBase.replace(/\/+$/, '');
  if (url.startsWith(`${to}/`)) return null;
  const key = keyFromPublicUrlAgainst(url, fromBases);
  if (!key) return null;
  return { from: url, to: `${to}/${key}`, key };
}

/** Walk a JSON value and rewrite every string that plans; returns the new value and the plans. */
export function rewriteJsonUrls(value: unknown, fromBases: readonly string[], toBase: string): { value: unknown; plans: RewritePlan[] } {
  const plans: RewritePlan[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const plan = planUrlRewrite(v, fromBases, toBase);
      if (plan) { plans.push(plan); return plan.to; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), plans };
}
