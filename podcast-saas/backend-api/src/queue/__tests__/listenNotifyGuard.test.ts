import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { listenNotifyEnabled } from '../pgBoss.js';

describe('listenNotifyEnabled', () => {
  it('is off unless opted in', () => {
    expect(listenNotifyEnabled({}, 'postgres://u:p@db.example.com:5432/app')).toBe(false);
    expect(listenNotifyEnabled({ QUEUE_PGBOSS_LISTEN: '0' }, 'postgres://u:p@db.example.com:5432/app')).toBe(false);
  });
  it('honours the opt-in on a session endpoint', () => {
    expect(listenNotifyEnabled({ QUEUE_PGBOSS_LISTEN: '1' }, 'postgres://u:p@db.example.com:5432/app')).toBe(true);
  });
  it('refuses the opt-in on a transaction pooler — port 6543, pgbouncer=true, or pool_mode=transaction', () => {
    expect(listenNotifyEnabled({ QUEUE_PGBOSS_LISTEN: '1' }, 'postgres://u:p@pooler.supabase.com:6543/app')).toBe(false);
    expect(listenNotifyEnabled({ QUEUE_PGBOSS_LISTEN: '1' }, 'postgres://u:p@db.example.com:5432/app?pgbouncer=true')).toBe(false);
    expect(listenNotifyEnabled({ QUEUE_PGBOSS_LISTEN: '1' }, 'postgres://u:p@db.example.com:5432/app?pool_mode=transaction')).toBe(false);
  });
});
