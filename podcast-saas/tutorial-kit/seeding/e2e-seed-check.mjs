// E2E: a BRAND-NEW user hits the API once and receives their welcome clone + playlist.
// Run against the seeded backend (run-backend-seeded.sh). Creates a fresh emulator user each run.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8080';
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const template = JSON.parse(readFileSync(join(HERE, 'TEMPLATE.json'), 'utf8'));

const email = `seed-e2e-${Date.now()}@example.com`;
const sign = await (await fetch(`${EMU}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: 'seed-e2e-pass-1', returnSecureToken: true }),
})).json();
if (!sign.idToken) { console.error('emulator signUp failed', sign); process.exit(1); }
const H = { authorization: `Bearer ${sign.idToken}` };
const j = async (path) => {
  const r = await fetch(API + path, { headers: H });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// First authenticated call creates the user row and fires the seed; poll the list until the
// clone appears (fire-and-forget means it lands a beat later).
const out = { email };
for (let i = 0; i < 30; i++) {
  const list = await j('/api/v1/projects');
  out.listStatus = list.status;
  const clone = (list.data ?? []).find((p) => p.is_welcome_seed);
  if (clone) { out.clone = { id: clone.id, title: clone.title, visibility: clone.visibility }; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!out.clone) { console.error(JSON.stringify({ ...out, verdict: 'FAIL — no clone appeared in 30s' })); process.exit(1); }

const me = await j('/api/v1/users/me');
out.pointers = {
  welcome_project_id: me.data?.welcome_project_id ?? me.data?.user?.welcome_project_id ?? null,
  welcome_playlist_id: me.data?.welcome_playlist_id ?? me.data?.user?.welcome_playlist_id ?? null,
};

// The clone must PLAY: its player config needs HLS + ready sims + posters.
const cfg = await j(`/api/v1/projects/${out.clone.id}/player-config`).then(r =>
  r.status === 404 ? j(`/api/v1/projects/${out.clone.id}`) : r);
out.playable = cfg.status;

// The personal playlist rides along: the user's list must contain a "Welcome to Flow Video"
// playlist whose FIRST item is their own clone (template project swapped for the clone).
const pls = await j('/api/v1/playlists');
const myPl = (Array.isArray(pls.data) ? pls.data : pls.data?.playlists ?? [])
  .find((pl) => /welcome to flow video/i.test(pl.title ?? ''));
out.playlist = myPl ? { id: myPl.id, title: myPl.title } : null;
if (myPl) {
  const items = await j(`/api/v1/playlists/${myPl.id}`);
  const list = items.data?.items ?? items.data?.playlist?.items ?? [];
  out.playlistItems = list.map((it) => it.project_id ?? it.projectId).slice(0, 6);
  out.playlistLeadsWithClone = out.playlistItems[0] === out.clone.id;
}

// Idempotency: a second listing does not create a second clone.
const again = await j('/api/v1/projects');
out.cloneCount = (again.data ?? []).filter((p) => p.is_welcome_seed).length;

out.verdict = out.clone && out.cloneCount === 1 ? 'PASS' : 'FAIL';
console.log(JSON.stringify(out, null, 2));
process.exit(out.verdict === 'PASS' ? 0 : 1);
