# Sim bundle renders as RAW TEXT in iframe — ported fix from fiji

## Problem (podcast-saas)
A complex bundle (`example.zip`, entry nested at `pdc-strings/index.html`) renders in the b-roll
iframe as literal `<!DOCTYPE html> …` source instead of the page.

Where the iframe `src` comes from:
- `backend-api/src/services/simulation/SimulationService.ts:1210` — `processFiles()` ends with
  `const entryUrl = this.storage.getSimPublicUrl(entryStoragePath)`. For prod that is
  `SupabaseStorageAdapter.getSimPublicUrl` (`SupabaseStorageAdapter.ts:191`) which returns the
  **raw Supabase public-object URL** `${origin}/storage/v1/object/public/${bucket}/${key}`.
- `client-web/components/viewer/SimOverlayDynamic.tsx:24-28` renders `<iframe src={simulationUrl}>`
  with that raw bucket URL.

The upload Content-Type is already correct: `processFiles` uploads each file with
`getSimulationContentType(relPath)` (`SimulationService.ts:1204`), and `.html` maps to
`text/html; charset=utf-8` (`SimulationService.ts:90`). So the object metadata in Supabase is right.
The breakage is in **what the browser actually receives from Supabase's public endpoint** — not in
the stored metadata.

### Why it renders as text (prod / Supabase path)
Pointing an iframe at the **raw Supabase `…/object/public/…` URL** is fragile for HTML documents:
1. Supabase's public object endpoint is a download endpoint. It echoes the stored `content-type`,
   but it has repeatedly shipped behaviors that make a browser NOT treat the response as a renderable
   document — most importantly it can attach a `content-disposition` (download/attachment-ish) header
   and serve the body in a way that, combined with the iframe `sandbox`, makes the browser show
   source. Even when it sends `text/html`, the public endpoint is outside our control and varies by
   project config (Smart CDN, transform settings, bucket public policy).
2. The bundle's hard dependencies make the raw-URL path strictly worse than fiji's: the entry uses
   `<script type="module" src="./js/main.js">` with **relative ES-module specifiers** and an
   **importmap** + CDN (`three`, `katex` from jsdelivr). ES modules are **refused by the browser when
   the response MIME is not a JS MIME** (`application/octet-stream` / `text/plain` → hard module
   load failure, blank or broken sim). The raw Supabase endpoint gives us no second chance to fix a
   wrong/*missing-charset* MIME per request; a proxy does.
3. Net: the document either renders as text (HTML served non-renderably) or boots but the module
   graph dies on MIME. Both are the same root cause — **we do not control the response headers when
   the iframe loads straight from the bucket.**

Note: the **local-dev path is already correct.** `server.ts:345` `/sim-public/*` →
`serveLocalFile(request, reply, filePath, getSimulationContentType(key), { 'X-Content-Type-Options':
'nosniff', … })` re-emits `text/html; charset=utf-8` for the entry and `application/javascript` for
`.js`/`.mjs`. So this bug reproduces only in **prod (Supabase)**, which matches "complex bundle in
the deployed app."

---

## Fiji's approach (verified in source)

**Fiji never points an iframe at a raw cloud public URL. It always serves multi-file HTML bundles
through its own proxy route, which re-emits a server-controlled Content-Type.**

1. **Iframe `src` is always the proxy, never the bucket:**
   - `fijiweb/src/components/ArtifactViewer.tsx:574` → ``return `/api/v1/storage/proxy/${filePath}`;``
   - `fijiweb/src/components/upload-steps/PreviewStep.tsx:72`, `App.tsx:1463` — same pattern.
   - Drafts: `DraftArtifactService.ts:221` ``previewUrl = `/api/v1/temp/proxy/${tempId}/${entryPoint.key}` ``.
   So the browser only ever talks to fijiserver for bundle bytes; it never sees S3/GCS/Azure headers.

2. **The proxy downloads from object storage and sets the response headers itself**
   (`fijiserver/src/controllers/v1/StorageProxyHandler.ts`):
   - `StorageService.downloadFile({ key: fullPath })` (line 81) — pulls bytes from the object store.
   - `const contentType = getContentTypeFromPath(fullPath)` (line 89), then
     ```
     res.setHeader('Content-Type', contentType);                       // line 92
     res.setHeader('Cache-Control', 'no-cache, must-revalidate');      // line 94 (files can be replaced)
     res.setHeader('Access-Control-Allow-Origin', '*');                // line 95
     res.send(buffer);                                                 // line 98
     ```
   - `getContentTypeFromPath` (lines 141-189): `.html`→`text/html`, `.js`/`.mjs`→`application/javascript`.
     Note: fiji does **not** append `; charset=utf-8` and does **not** set `X-Content-Type-Options`,
     `Cross-Origin-Resource-Policy`, or `Content-Disposition`. (podcast-saas's local route is already
     stricter/better here — keep the charset + nosniff.)
   - **No `Content-Disposition` is ever set** → the browser renders inline. This is the single header
     difference that flips "download/show-source" into "render" relative to the raw bucket URL.

3. **Relative-URL resolution comes for free from the proxy URL shape.** The handler's own doc-comment
   (`StorageProxyHandler.ts:17-23`) is explicit: HTML at
   `/api/v1/storage/proxy/artifacts/art-123-v1/index.html` makes `<img src="./logo.png">` resolve to
   `/api/v1/storage/proxy/artifacts/art-123-v1/logo.png`, which the same proxy serves. Fiji does **no**
   `<base href>` injection and **no** path rewriting — the directory in the URL is the directory in
   the key.

4. **Fiji has no nested-entry problem at all**, because it stores files **flat**:
   - `FileOperationService.ts:389` `path = ` `temp/${userId}/${tempId}/${filename}` `` and
     `StorageService.ts:570` `path = ` `artifacts/${artifactId}-v${version}/${filename}` ``.
   - `IStorageFile.key` is the **basename** (`createStorageFile` sets `key: filename`,
     `FileOperationService.ts:408`); the frontend even flattens `webkitRelativePath` to a key before
     upload (`FileUploadStep.tsx:74-79`). So fiji's entry is always
     `artifacts/{id}/index.html` — never `artifacts/{id}/pdc-strings/index.html`. Its `entryPoint.key`
     is just `index.html`, and the proxy resolves relative siblings in the same flat prefix.
   - **Implication for podcast-saas:** podcast-saas keeps the nested zip structure
     (`simulations/{proj}/{sim}/pdc-strings/index.html`). That is fine **as long as** the iframe URL
     preserves the same directory depth so `./js/main.js` resolves to
     `…/pdc-strings/js/main.js`. A proxy route preserves it exactly the way the raw URL did — so we do
     **not** need to flatten, and we do **not** need `<base href>`. (CDN/importmap deps load fine in a
     sandbox that has `allow-scripts`; they are cross-origin network fetches the browser makes
     directly — fiji relies on the same and does nothing special for them.)

---

## Gap analysis
| Concern | fiji | podcast-saas today | What to change |
|---|---|---|---|
| iframe src | own proxy `/api/v1/storage/proxy/*` | **raw Supabase public URL** (prod) | route prod sims through a podcast-saas proxy |
| response Content-Type | set by proxy from extension | set by Supabase from object meta (not honored as renderable) | proxy re-emits `text/html; charset=utf-8`, `application/javascript` |
| Content-Disposition | never set → inline render | Supabase may send disposition → shows source | proxy never sets disposition |
| relative asset resolution | URL dir == key dir (flat) | URL dir == key dir (nested) — already correct via proxy | keep nested; proxy preserves depth |
| local dev | n/a (always cloud) | **already correct** via `/sim-public/*` | leave as-is |

The only real gap is **prod serves from the bucket instead of a proxy.** Everything else
(content-type map, charset, nosniff, nested relative resolution) is already in place on the local
route and just needs to apply to prod too.

---

## Ported solution for podcast-saas (minimal, code-level)

**Primary recommendation: serve prod simulation bundles through a podcast-saas `/sim-public/*` proxy
that streams from Supabase and re-emits the Content-Type — exactly fiji's StorageProxyHandler
pattern. Do NOT keep pointing the iframe at the raw bucket URL.** This is one new route + one
one-line change in the Supabase adapter; the upload pipeline and the iframe component need **no**
change.

### 1. `SupabaseStorageAdapter.getSimPublicUrl` — return the app proxy URL, not the bucket URL
File: `backend-api/src/services/storage/SupabaseStorageAdapter.ts:191-193`.

```ts
// BEFORE
getSimPublicUrl(path: string): string {
  return `${this.publicBase}/${path}`;            // raw Supabase public-object URL
}

// AFTER — mirror LocalStorageAdapter: serve sims through the app's own /sim-public proxy
getSimPublicUrl(path: string): string {
  const base = (process.env.BACKEND_API_URL ?? '').replace(/\/+$/, '');
  return `${base}/sim-public/${path}`;            // app-controlled headers, like fiji's proxy
}
```
- This makes prod use the **same `/sim-public/*` URL shape** the local adapter already uses, so the
  iframe `src`, the bridge-injection relative paths (`SimulationService.ts:1457`
  `bridgeRelPath = '../'.repeat(depth)+'bridge.js'`), and the `getSimPublicUrl(...)+'?section=…&v=…'`
  cache-buster (`SimulationService.ts:1491`) all keep working unchanged.
- `BACKEND_API_URL` must be the public origin of the backend in prod (already used by the Local/
  R2 adapters). Add it to `.env.example` if not present. (Do not read `.env`.)
- Leave `getPublicUrl` (HLS) untouched — HLS is `<video>`/range and already proxied separately.

### 2. Make `/sim-public/*` serve from Supabase in prod (currently local-disk only)
File: `backend-api/src/server.ts:344-361`. Today the handler only reads local disk via
`serveLocalFile`. Generalize it to fetch from the active storage adapter so the **same route** works
for both Local (dev) and Supabase (prod):

```ts
import { getStorageAdapter } from './services/storage/getStorageAdapter.js';
import { LocalStorageAdapter } from './services/storage/LocalStorageAdapter.js';
import { keyHasTraversal } from './services/storage/pathSafety.js';

app.get<{ Params: { '*': string } }>('/sim-public/*', async (request, reply) => {
  const key = request.params['*'];
  if (!key.startsWith('simulations/') || keyHasTraversal(key)) {
    return reply.code(403).send({ message: 'Forbidden' });
  }

  const contentType = getSimulationContentType(key);          // text/html; charset=utf-8 etc.
  const adapter = getStorageAdapter();

  // Local dev: stream from disk (Range support kept) exactly as today.
  if (adapter instanceof LocalStorageAdapter) {
    const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
    if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
    return serveLocalFile(request, reply, filePath, contentType, {
      extraHeaders: {
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Prod (Supabase/R2): pull bytes from the object store and RE-EMIT our own headers.
  // This is fiji's StorageProxyHandler.handleStorageProxyRequest pattern, ported to Fastify.
  let buffer: Buffer;
  try {
    buffer = await adapter.readObject(key);
  } catch {
    return reply.code(404).send({ message: 'Not found' });
  }
  reply
    .header('Content-Type', contentType)                       // controls render, not Supabase
    .header('Cache-Control', 'no-cache, must-revalidate')      // bundle files get replaced (fiji L94)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .header('Access-Control-Allow-Origin', '*');
  // IMPORTANT: do NOT set Content-Disposition — that is what makes Supabase show source.
  return reply.send(buffer);
});
```

Why this fixes both failure modes:
- The **entry HTML** is emitted as `text/html; charset=utf-8` with **no** `Content-Disposition` →
  the iframe renders it instead of showing source.
- **`./js/main.js` and its relative-imported modules** are emitted as `application/javascript` (the
  `getSimulationContentType` map already does this for `.js`/`.mjs`), so the browser accepts the ES
  module graph. The importmap + jsdelivr CDN deps (`three`, `katex`) are direct cross-origin fetches
  the sandboxed iframe makes itself (`allow-scripts` is present) — unaffected, same as fiji.
- Relative resolution: the proxy URL keeps the nested directory
  (`/sim-public/simulations/{proj}/{sim}/pdc-strings/index.html`), so `<script src="./js/main.js">`
  resolves to `/sim-public/simulations/{proj}/{sim}/pdc-strings/js/main.js`, which the same proxy
  serves. **No `<base href>` and no path rewriting needed** — matches fiji.

`adapter.readObject(key)` already exists on the interface (`StorageService.ts:41`) and is implemented
by `SupabaseStorageAdapter.readObject` (`SupabaseStorageAdapter.ts:195`) and `R2StorageAdapter`. The
`keyHasTraversal` guard (`pathSafety.ts:20`) blocks `..` in the object key; the `simulations/` prefix
gate keeps the proxy scoped to sim bundles only (it cannot read HLS/video/other prefixes).

### 3. `SimulationService.ts` upload — NO change required
The content-type map is already correct (`text/html; charset=utf-8`, `application/javascript`). Keep
uploading with `getSimulationContentType` so that `readObject`-in-proxy and any future presigned path
both have correct stored metadata. **Do not** change `findEntryHtml`, `injectBridge`, or the nested
prefix — the proxy handles nesting.

### 4. `SimOverlayDynamic.tsx` iframe — NO change required (one optional tightening)
`src={simulationUrl}` now receives the `/sim-public/...` proxy URL. The current
`sandbox="allow-scripts allow-same-origin allow-forms"` is fine and is what makes the bundle's own
scripts + CDN modules run. Leave it. (If you ever want the bridge `postMessage` to keep working while
hardening, note `allow-same-origin` is required for the importmap/module worker context some bundles
use; do not drop it for this bundle.)

---

## Phased plan
- **Phase 1 (this fix, ~30 min): proxy the prod path.** Steps 1+2 above. Smallest change that makes
  the deployed iframe render. No data migration; existing already-uploaded sims start rendering
  immediately because the URL is derived at read time, not stored. (If `entryUrl`/`section_url` were
  persisted as raw bucket URLs in `sim_meta`, see Risks — add a read-time rewrite.)
- **Phase 2 (optional, later): presigned/CDN for static assets.** If proxy bandwidth on Node becomes
  a concern, keep HTML through the proxy (it must control headers) but serve large binary sibling
  assets (images, .glb, fonts) via presigned GET or Supabase public URL. fiji keeps even these on the
  proxy for per-object auth; podcast-saas sims are public b-roll, so this is purely a cost lever, not
  correctness. Not needed to fix the bug.
- **Phase 3 (optional): per-object auth.** If sims ever become private, this proxy is the exact hook
  to add an `is_public`/owner check before `readObject`, mirroring `checkArtifactAccess`
  (`StorageProxyHandler.ts:234`). Not needed now.

---

## Risks & trade-offs
- **Bandwidth now flows through Node again for sim files.** Sims are small static bundles (HTML/JS/CSS,
  a few KB–MB each) and `Cache-Control: no-cache` forces revalidation but bodies are tiny; this is the
  same posture as the existing `/hls-public` and local routes. Acceptable. If a sim ships a huge
  binary asset, Phase 2 offloads it.
- **`readObject` buffers the whole object in memory** (`SupabaseStorageAdapter.readObject` concats
  chunks). Fine for sim text/asset sizes; do **not** route video through this path (video already uses
  `/video-raw` + range). Keep the `simulations/` prefix gate so nothing else can.
- **Persisted URLs.** If `processFiles`/bridge generation stored the **raw Supabase URL** into
  `sim_meta.entry_url`/`section_url` for existing rows, Step 1 only changes newly-generated URLs.
  Mitigation: either (a) at read time in the viewer/controller, rewrite any stored
  `…/storage/v1/object/public/<bucket>/simulations/…` to `${BACKEND_API_URL}/sim-public/simulations/…`,
  or (b) a one-off backfill UPDATE on the sims/sections table (describe-only; do not run migrations
  here). New uploads need nothing.
- **CORS/sandbox:** the iframe is same-app-origin-ish but `sandbox` lacks `allow-same-origin`-to-parent
  concerns; we set `Access-Control-Allow-Origin: *` on the proxy (fiji does the same,
  `StorageProxyHandler.ts:95`) so cross-origin module/asset fetches from the sandboxed doc succeed.
- **Don't over-port:** podcast-saas should NOT replicate fiji's flat-key rewrite or multi-cloud
  download switch. Keep the nested keys + single Supabase adapter; only the serve indirection is
  ported.

---

## Verification
1. **Unit/integration (Fastify inject):** add a test that PUTs a fake entry into the active adapter and
   `GET /sim-public/simulations/p/s/pdc-strings/index.html` asserts
   `content-type: text/html; charset=utf-8`, **no** `content-disposition` header, and body starts with
   `<!DOCTYPE`. A second case for `…/js/main.js` asserts `content-type: application/javascript`.
   (Mirror existing tests under `backend-api/src/services/storage/__tests__/`.)
2. **Module-MIME guard:** assert `getSimulationContentType('a/b/main.mjs') === 'application/javascript'`
   (already true at `SimulationService.ts:92`) so ES modules are never refused.
3. **Manual (prod-like):** set `STORAGE_BACKEND=supabase` + `BACKEND_API_URL`, upload `example.zip`,
   open the project viewer, confirm the iframe renders the rendered page (not source) and DevTools
   Network shows the entry served from `…/sim-public/…` with `text/html; charset=utf-8` and the module
   `…/js/main.js` as `application/javascript` (status 200, not "refused to execute ... MIME type").
4. **Regression:** `npm run typecheck` in `backend-api`; confirm `/sim-public/*` local-dev path still
   streams with Range (existing behavior) by hitting it under `STORAGE_BACKEND=local`.
