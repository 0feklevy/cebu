// One-off: upload the Solar System package to the TOUR capture project as the capture user.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

const token = execFileSync('node', [join(HERE, 'capture-token.mjs')], { encoding: 'utf8' }).trim().split('\n').pop();
const fd = new FormData();
fd.append('name', 'Solar System');
fd.append('file', new Blob([readFileSync(join(HERE, 'props/solar-system.zip'))], { type: 'application/zip' }), 'solar-system.zip');
const r = await fetch('http://127.0.0.1:8080/api/v1/projects/9af4d112-aea9-4260-b56c-a3cb8fad7ced/simulations/upload', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
});
console.log('upload:', r.status, JSON.stringify(await r.json().catch(() => null))?.slice(0, 160));
