'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { User } from 'shared/src/generated/admin-v1';

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<{ id: string; weekly: string; monthly: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    adminApi
      .listUsers(page, limit)
      .then(({ users, total }) => {
        setUsers(users);
        setTotal(total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page]);

  const saveEditing = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const updated = await adminApi.updateUserLimits(editing.id, {
        weekly_token_limit: parseInt(editing.weekly, 10),
        monthly_token_limit: parseInt(editing.monthly, 10),
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleAdmin = async (user: User) => {
    try {
      const updated = await adminApi.updateUserLimits(user.id, { is_admin: !user.is_admin });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <AdminShell>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Users</h1>
        <span className="text-sm text-muted-foreground">{total.toLocaleString()} total</span>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-card border-b border-border">
                <tr className="text-muted-foreground text-xs">
                  <th className="text-left px-4 py-3">Email / UID</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-right px-4 py-3">Weekly Limit</th>
                  <th className="text-right px-4 py-3">Monthly Limit</th>
                  <th className="text-right px-4 py-3">Admin</th>
                  <th className="text-left px-4 py-3">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-background">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-card/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{u.email ?? '—'}</div>
                      <div className="text-xs text-muted-foreground font-mono">{u.firebase_uid.slice(0, 16)}…</div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          u.is_anonymous
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-primary/20 text-primary'
                        }`}
                      >
                        {u.is_anonymous ? 'anon' : 'registered'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {editing?.id === u.id ? (
                        <input
                          type="number"
                          value={editing.weekly}
                          onChange={(e) => setEditing({ ...editing, weekly: e.target.value })}
                          className="w-28 rounded border border-input bg-card px-2 py-1 text-right text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      ) : (
                        u.weekly_token_limit?.toLocaleString() ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {editing?.id === u.id ? (
                        <input
                          type="number"
                          value={editing.monthly}
                          onChange={(e) => setEditing({ ...editing, monthly: e.target.value })}
                          className="w-28 rounded border border-input bg-card px-2 py-1 text-right text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      ) : (
                        u.monthly_token_limit?.toLocaleString() ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => toggleAdmin(u)}
                        className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                          u.is_admin
                            ? 'bg-primary/20 text-primary hover:bg-destructive/20 hover:text-destructive'
                            : 'bg-muted text-muted-foreground hover:bg-primary/20 hover:text-primary'
                        }`}
                      >
                        {u.is_admin ? 'admin' : 'user'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {editing?.id === u.id ? (
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => setEditing(null)}
                            className="text-xs px-2 py-1 border border-border rounded hover:bg-accent/50 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={saveEditing}
                            disabled={saving}
                            className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-60"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() =>
                            setEditing({
                              id: u.id,
                              weekly: String(u.weekly_token_limit),
                              monthly: String(u.monthly_token_limit),
                            })
                          }
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Edit limits
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent/50 transition-colors disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent/50 transition-colors disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </AdminShell>
  );
}
