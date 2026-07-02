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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
        <Loader2 size={13} className="animate-spin" /> Loading collaborators…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {isOwner && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void invite(); } }}
            placeholder="Invite by email…"
            aria-label={`Invite a collaborator to this ${contentType} by email`}
            style={{
              flex: 1, height: 38, padding: '0 12px', borderRadius: 8, fontSize: 13,
              border: '1px solid hsl(var(--border))',
              background: 'hsl(var(--background))', color: 'hsl(var(--foreground))',
            }}
          />
          <button
            onClick={() => void invite()}
            disabled={inviting || !email.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 14px',
              borderRadius: 8, border: 'none', fontSize: 12.5, fontWeight: 600,
              background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
              cursor: inviting || !email.trim() ? 'default' : 'pointer',
              opacity: inviting || !email.trim() ? 0.55 : 1, flexShrink: 0,
            }}
          >
            {inviting
              ? <><Loader2 size={13} className="animate-spin" /> Inviting…</>
              : <><UserPlus size={13} strokeWidth={2} /> Invite</>}
          </button>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data?.owner && (
          <div style={rowStyle}>
            <div style={{ minWidth: 0 }}>
              <span style={nameStyle}>{data.owner.display_name || data.owner.email || 'Owner'}</span>
              {data.owner.display_name && data.owner.email && <span style={emailStyle}> {data.owner.email}</span>}
            </div>
            <span style={{ ...badgeStyle, background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}>Owner</span>
          </div>
        )}

        {data?.collaborators.map((c) => (
          <div key={c.id} style={rowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <Mail size={12} strokeWidth={2} style={{ color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} aria-hidden />
              <span style={{ ...nameStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.display_name || c.email}
              </span>
              {c.status === 'pending' && (
                <span style={{ ...badgeStyle, background: 'hsl(45 90% 50% / 0.14)', color: 'hsl(35 85% 45%)' }}>Pending</span>
              )}
            </div>
            {isOwner && (
              <button
                onClick={() => void remove(c.id)}
                disabled={removingId === c.id}
                aria-label={`Remove ${c.email}`}
                title="Remove collaborator"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent',
                  color: 'hsl(var(--muted-foreground))', cursor: 'pointer', flexShrink: 0,
                }}
              >
                {removingId === c.id
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Trash2 size={13} strokeWidth={2} />}
              </button>
            )}
          </div>
        ))}

        {data && data.collaborators.length === 0 && (
          <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
            {isOwner
              ? `No collaborators yet. Invite someone by email — they'll be able to edit this ${contentType} like you can.`
              : 'No other collaborators.'}
          </p>
        )}
      </div>

      {isOwner && data && data.collaborators.length > 0 && (
        <p style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          Collaborators can edit everything except deleting the {contentType} or managing collaborators.
          Pending invites activate when that email signs in.
        </p>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '7px 10px', borderRadius: 8,
  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))',
};

const nameStyle: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--foreground))',
};

const emailStyle: React.CSSProperties = {
  fontSize: 11.5, color: 'hsl(var(--muted-foreground))',
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
  textTransform: 'uppercase' as const, letterSpacing: '0.03em', flexShrink: 0,
};
