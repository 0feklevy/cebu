// Stage the CAPTURE-PROP project ("Standing Waves 101") on the LOCAL stack.
// This is the project the tutorial films show being built. Idempotent-ish: always creates a
// fresh project (props are cheap rows locally); writes ids to captures/STAGE.json for the
// capture driver. Never points anywhere but localhost.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8080';
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';

const cred = { email: 'kinesin-test@example.com', password: 'kinesin-test-pass-1', returnSecureToken: true };
let sign = await (await fetch(`${EMU}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
})).json();
if (!sign.idToken) {
  sign = await (await fetch(`${EMU}/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
  })).json();
}
if (!sign.idToken) { console.error('emulator sign-in failed', sign); process.exit(1); }
const H = { authorization: `Bearer ${sign.idToken}` };

async function j(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...H, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
  if (res.status >= 400) console.error(`${method} ${path} -> ${res.status}`, data);
  return { status: res.status, data };
}

function fd(fields, filePath, filename, type) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('file', new Blob([readFileSync(filePath)], { type }), filename);
  return f;
}

const out = { startedAt: new Date().toISOString() };

// 1. the project
const proj = await j('POST', '/api/v1/projects', { topic: 'Standing Waves 101', name: 'Standing Waves 101' });
out.projectId = proj.data?.id ?? proj.data?.project?.id;
if (!out.projectId) process.exit(1);

// 2. the master video (the "footage" the fictional creator shot)
const vid = await j('POST', `/api/v1/projects/${out.projectId}/videos/upload`,
  fd({ name: 'waves-footage.mp4' }, join(HERE, 'props/lesson-waves.mp4'), 'waves-footage.mp4', 'video/mp4'));
out.videoId = vid.data?.id ?? vid.data?.video?.id;

// 3. the Wave Lab sim package
const sim = await j('POST', `/api/v1/projects/${out.projectId}/simulations/upload`,
  fd({ name: 'Wave Lab' }, join(HERE, 'props/wave-lab.zip'), 'wave-lab.zip', 'application/zip'));
out.simId = sim.data?.id ?? sim.data?.simulation?.id;

// 4. an image + an audio card so the Library looks genuinely lived-in on camera
const img = await j('POST', `/api/v1/projects/${out.projectId}/images`,
  fd({}, join(HERE, 'props/waves-diagram.png'), 'waves-diagram.png', 'image/png'));
out.imageId = img.data?.id;
const aud = await j('POST', `/api/v1/projects/${out.projectId}/audio`,
  fd({}, join(HERE, 'props/ambient-tone.wav'), 'ambient-sting.wav', 'audio/wav'));
out.audioId = aud.data?.id;

// 5. wait for HLS (bounded) so viewer-side captures can play the video
if (out.videoId) {
  for (let i = 0; i < 60; i++) {
    const st = await j('GET', `/api/v1/projects/${out.projectId}/videos/${out.videoId}/hls-status`);
    out.hls = st.data?.status ?? st.data;
    if (out.hls === 'ready' || st.data?.ready === true) break;
    await new Promise(r => setTimeout(r, 2000));
  }
}

writeFileSync(join(HERE, 'STAGE.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
