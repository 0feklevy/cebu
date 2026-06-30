// Branching: route the viewer to a cross-destination choice. The player resolves access
// server-side and only passes share tokens for reachable destinations (see buildPlayerConfig).
// Full-page navigation is intentional — cross-project/playlist targets have a different
// PlayerConfig, HLS sources, and access gating, so an in-player swap isn't possible.
export function branchNavigate(dest: { type: 'project' | 'playlist' | 'external_url'; url?: string | null; token?: string | null }) {
  if (typeof window === 'undefined') return;
  if (dest.type === 'external_url' && dest.url) { window.location.href = dest.url; return; }
  if (dest.type === 'project' && dest.token) { window.location.href = `/v/${dest.token}`; return; }
  if (dest.type === 'playlist' && dest.token) { window.location.href = `/pl/${dest.token}`; return; }
}
