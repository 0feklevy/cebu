// Flip staged capture-prop projects to the CAPTURE browser profile's user (LOCAL DB ONLY —
// the runner loads the local env; DATABASE_URL stays localhost by standing rule).
// Usage: run-flip.sh <projectId> [<projectId>…]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
// drizzle-orm resolves from the BACKEND's tree (this file lives outside it).
const requireBackend = createRequire(pathToFileURL(join(HERE, '../../backend-api/package.json')));
const { eq } = requireBackend('drizzle-orm');
const { db } = await import('../../backend-api/src/db/index.js');
const { users, projects } = await import('../../backend-api/src/db/schema.js');

const cap = JSON.parse(readFileSync(join(HERE, 'CAPTURE-USER.json'), 'utf8'));
const ids = process.argv.slice(2);
if (!ids.length) { console.error('pass project ids'); process.exit(1); }

const u = await db.query.users.findFirst({ where: eq(users.firebase_uid, cap.uid) });
if (!u) { console.error('capture user not in users table yet — open the app once more'); process.exit(1); }

for (const id of ids) {
  await db.update(projects).set({ created_by: u.id }).where(eq(projects.id, id));
  console.log(`✓ ${id} → ${u.id}`);
}
process.exit(0);
