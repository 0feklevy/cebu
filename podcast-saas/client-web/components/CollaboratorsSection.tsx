'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, Trash2, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import type { CollaboratorsResponse } from 'shared/src/generated/client-v1';

interface Props {
  contentType: 'project' | 'playlist';
  contentId: string;
}

/**
 * Invite-by-email collaborator management (GitHub-style, migration 042).
 * Embedded in the project Settings panel and the playlist editor dialog.
 * Owners can invite/remove; collaborators see the member list and can leave.
 */
export function CollaboratorsSection({ contentType, contentId }: Props) {
  const [data, setData] = useState<CollaboratorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = contentType === 'project'
        ? await api.listProjectCollaborators(contentId)
        : await api.listPlaylistCollaborators(contentId);
      setData(res);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Failed to load collaborators');
    } finally {
      setLoading(false);
    }
  }, [contentType, contentId]);

  useEffect(() => { void load(); }, [load]);

  const invite = async () => {
    const value = email.trim();
    if (!value || inviting) return;
    setInviting(true);
    setError(null);
    try {
      const res = contentType === 'project'
        ? await api.addProjectCollaborator(contentId, value)
        : await api.addPlaylistCollaborator(contentId, value);
      setData((d) => (d ? { ...d, collaborators: res.collaborators } : d));
      setEmail('');
    } catch (err) {
      setError((err as Error).message || 'Invite failed');
    } finally {
      setInviting(false);
    }
  };

  const remove = async (collabId: string) => {
    setRemovingId(collabId);
    setError(null);
    try {
      if (contentType === 'project') await api.removeProjectCollaborator(contentId, collabId);
      else await api.removePlaylistCollaborator(contentId, collabId);
      setData((d) => (d ? { ...d, collaborators: d.collaborators.filter((c) => c.id !== collabId) } : d));
    } catch (err) {
      setError((err as Error).message || 'Remove failed');
    } finally {
      setRemovingId(null);
    }
  };

  const isOwner = data?.viewer_role === 'owner';

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" /> Loading collaborators…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {isOwner && (
        /* flex-wrap + min-w-[160px]: in a narrow settings column the email input's intrinsic
           min-width used to push the Invite button out of the card; now the input shrinks
           and, at the extreme, the button wraps to its own line instead of overflowing. */
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void invite(); } }}
            placeholder="Invite by email…"
            aria-label={`Invite a collaborator to this ${contentType} by email`}
            className="h-9 min-w-[160px] flex-1 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus-ring"
          />
          <button
            onClick={() => void invite()}
            disabled={inviting || !email.trim()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-55 focus-ring"
          >
            {inviting
              ? <><Loader2 size={13} className="animate-spin" /> Inviting…</>
              : <><UserPlus size={13} strokeWidth={2} /> Invite</>}
          </button>
        </div>
      )}

      {error && <p className="m-0 text-xs text-destructive">{error}</p>}

      <div className="flex flex-col gap-1.5">
        {data?.owner && (
          <div className={ROW}>
            <div className="min-w-0">
              <span className={NAME}>{data.owner.display_name || data.owner.email || 'Owner'}</span>
              {data.owner.display_name && data.owner.email && (
                <span className="text-[11px] text-muted-foreground"> {data.owner.email}</span>
              )}
            </div>
            <span className={`${BADGE} bg-primary/10 text-primary`}>Owner</span>
          </div>
        )}

        {data?.collaborators.map((c) => (
          <div key={c.id} className={ROW}>
            <div className="flex min-w-0 items-center gap-1.5">
              <Mail size={12} strokeWidth={2} className="shrink-0 text-muted-foreground" aria-hidden />
              <span className={`${NAME} truncate`}>
                {c.display_name || c.email}
              </span>
              {c.status === 'pending' && (
                <span className={`${BADGE} bg-amber-500/15 text-amber-600`}>Pending</span>
              )}
            </div>
            {isOwner && (
              <button
                onClick={() => void remove(c.id)}
                disabled={removingId === c.id}
                aria-label={`Remove ${c.email}`}
                title="Remove collaborator"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50 focus-ring"
              >
                {removingId === c.id
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Trash2 size={13} strokeWidth={2} />}
              </button>
            )}
          </div>
        ))}

        {data && data.collaborators.length === 0 && (
          <p className="m-0 text-xs text-muted-foreground">
            {isOwner
              ? `No collaborators yet. Invite someone by email — they'll be able to edit this ${contentType} like you can.`
              : 'No other collaborators.'}
          </p>
        )}
      </div>

      {isOwner && data && data.collaborators.length > 0 && (
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
          Collaborators can edit everything except deleting the {contentType} or managing collaborators.
          Pending invites activate when that email signs in.
        </p>
      )}
    </div>
  );
}

/* Shared row/label classes — token-only, so the section reads the same inside the playlist
   editor dialog and the project Settings panel, in both themes. */
const ROW = 'flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5';
const NAME = 'text-xs font-semibold text-foreground';
const BADGE = 'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide';
