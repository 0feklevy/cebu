# Architecture Guide: Client Site + Admin Portal + AI Generation API

A practical reference for building a platform that has:
- A **client site** — what end users see and interact with
- An **admin portal** — a separate operator dashboard at a different URL
- An **AI generation API** — backend that streams LLM-generated content to users

---

## 1. Project Structure

Split into separate packages/apps in a monorepo:

```
backend-api/       REST API (Express or similar, port 8080)
client-web/        User-facing React app (port 3000)
admin-web/         Admin React app (port 3001 dev / served at /admin/ in prod)
shared/            Shared constants and types (imported by all)
```

Both frontend apps are **completely separate** React SPAs. They share no code at runtime — only shared TypeScript types and constants via the `shared` package.

---

## 2. Authentication Architecture

### Use Firebase Auth (or any token-based auth)

Both apps use the same Firebase project. The auth pattern is:
1. User signs in → Firebase returns an ID token (JWT).
2. Every API request includes `Authorization: Bearer <firebase-id-token>`.
3. The backend validates the token with Firebase Admin SDK.

### Client app — support anonymous users

Unauthenticated visitors should get an **anonymous Firebase identity** automatically (triggered from a cookie consent / welcome banner). This lets guests create content without signing up, while still being tracked per-user on the backend.

```typescript
// FirebaseAuthContext.tsx — core shape
{
  user: User | null,
  loading: boolean,
  isAnonymous: boolean,
  signInWithGoogle(),
  signInWithEmail(),
  signUpWithEmail(),
  signInAnonymouslyFn(),     // ← auto-called for guests
  signOutUser(),
  getIdToken(): Promise<string | null>
}
```

Wait for `loading === false` before rendering anything auth-gated. Show a skeleton or nothing while Firebase resolves the session.

### Admin portal — hard gate on `isAdmin`

The admin app must show `<LoginPage />` until the user is authenticated **and** confirmed as admin. If auth resolves but `isAdmin === false`, show an access-denied full-page screen — never show partial admin UI to non-admins.

```typescript
if (loading)          return <LoadingSpinner />;
if (!user)            return <LoginPage />;
if (isAdmin === null) return <LoadingSpinner />;  // still checking
if (isAdmin === false) return <AccessDenied />;
return <AdminShell />;
```

`isAdmin` should be resolved from the backend (not just from a Firebase custom claim) so admins can be managed via the admin portal itself.

---

## 3. Backend API Design

### Two Separate Namespaces

```
/api/v1/          ← public endpoints (client site)
/api/admin/v1/    ← admin endpoints (admin portal only)
```

All admin endpoints require `isAdmin: true` on the authenticated user. Never mix public and admin routes.

### Security Schemes

```
firebase          → valid Firebase token required
firebase-optional → Firebase token attached if present, but not required
firebase-admin    → Firebase token + user.isAdmin === true
```

Use a middleware/decorator system (TSOA, NestJS guards, Express middleware) to enforce these consistently rather than checking auth manually in each controller.

### Auto-generate API Clients

Use TSOA or OpenAPI codegen to generate typed TypeScript client classes from your controller definitions. Both the client app and admin app get their own generated client targeting their respective namespace. Never hand-write `fetch` calls to the API — always use the generated classes.

```bash
# After modifying controllers:
yarn generate-routes       # regenerate routes from decorators
yarn generate-stubs:web    # regenerate client for the user-facing app
yarn generate-stubs:admin  # regenerate client for the admin app
```

### Platform Settings Endpoint

Expose a public endpoint that returns feature flags controlling what the client shows:

```typescript
GET /api/v1/platform/settings

Response:
{
  billingEnabled: boolean,
  maintenanceMode: boolean,
  maintenanceMessage?: string,
  generationPaused: boolean,
  generationPausedMessage?: string,
  anonymousUserLimit: number,
  externalUrlsEnabled: boolean,
  featuredEnabled: boolean
}
```

The client fetches this on startup. Admins change these values in the admin portal. No frontend deploy needed to toggle features.

---

## 4. Axios Interceptors (Both Apps)

Both apps use the same Axios interceptor pattern for authentication:

```typescript
// api/client.ts (client app uses /api/v1, admin uses /api/admin/v1)
const axiosInstance = axios.create({ baseURL: '/api/v1' });

// Attach token on every request
axiosInstance.interceptors.request.use(async (config) => {
  const token = await auth.currentUser?.getIdToken();
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

// On 401: force-refresh the token and retry once
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const req = error.config;
    if (error.response?.status === 401 && !req._retry) {
      req._retry = true;
      const token = await auth.currentUser?.getIdToken(true); // force refresh
      if (token) {
        req.headers.set('Authorization', `Bearer ${token}`);
        return axiosInstance(req);
      }
    }
    return Promise.reject(error);
  }
);
```

The 401 retry is critical — tabs left open overnight will get expired tokens; silently refreshing and retrying prevents the user ever seeing an auth error.

---

## 5. Client Site Shell

### Layout

```
<div class="app-shell">
  <header class="top-bar">
    ← logo, search, Create button, user avatar/menu
  <div class="app-body">
    <aside class="side-nav">
      ← collapsible left nav (64px collapsed / 220px expanded)
    <div class="main-area">
      <main class="content">
        ← renderContent() output (one component per page)
      <footer>
```

### Manual SPA Routing (no React Router needed for simple cases)

```typescript
type NavId = 'home' | 'profile' | 'settings' | 'item-detail';
const [activeItem, setActiveItem] = useState<NavId>('home');

// Parse URL on mount and on popstate
const parseUrl = useCallback(() => {
  const path = window.location.pathname;
  const match = path.match(/^\/items\/(.+)$/);
  if (match) { setSelectedItemId(match[1]); setActiveItem('item-detail'); return; }
  if (path === '/settings') { setActiveItem('settings'); return; }
  setActiveItem('home');
}, []);

useEffect(() => {
  parseUrl();
  window.addEventListener('popstate', parseUrl);
  return () => window.removeEventListener('popstate', parseUrl);
}, [parseUrl]);

// Navigate programmatically
const navigate = (path: string, state?: unknown) => {
  window.history.pushState(state ?? {}, '', path);
  parseUrl();
};
```

### renderContent() pattern

```typescript
const renderContent = () => {
  if (activeItem === 'item-detail' && selectedItemId) {
    return <ItemDetailView id={selectedItemId} />;
  }
  if (activeItem === 'settings') {
    if (!user) return <LoginRequired onSignIn={openSignIn} />;
    return <SettingsView />;
  }
  return <HomeView />;
};
```

### Mobile Nav

Track `window.innerWidth < 768` with a resize listener. On mobile:
- The side-nav is hidden by default and slides in as a drawer.
- A hamburger button in the top bar opens it.
- A backdrop overlay and Escape key close it.
- `document.body.style.overflow = 'hidden'` while the drawer is open.

---

## 6. Admin Portal Shell

Structurally identical to the client shell but simpler — no public routing, no anonymous auth.

```typescript
const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'users',     label: 'Users',     icon: '👥' },
  { id: 'settings',  label: 'Settings',  icon: '⚙️' },
  // ...
];

const renderContent = () => {
  switch (activeItem) {
    case 'dashboard': return <Dashboard />;
    case 'users':     return <UsersManagement />;
    case 'settings':  return <SystemSettings />;
    default:          return <Dashboard />;
  }
};
```

### Admin URL Routing

The admin app is served at `/admin/` in production. The `parseUrl` function must strip the prefix:

```typescript
const parseUrl = useCallback(() => {
  let path = window.location.pathname;
  if (path.startsWith('/admin')) {
    path = path.slice('/admin'.length) || '/';
  }
  const navId = pathToNavItem[path];
  if (navId) setActiveItem(navId);
}, []);
```

When navigating with `pushState`, prepend the base path:
```typescript
const basePath = import.meta.env.BASE_URL.replace(/\/$/, ''); // '/admin' in prod
window.history.pushState({}, '', basePath + '/users');
```

---

## 7. AI Generation — The Right Architecture

### Use SSE, Not a Single HTTP Request

A single HTTP request/response for AI generation will time out (LLMs take 10-60+ seconds) and gives no feedback. Use **Server-Sent Events (SSE)**:

```
GET /api/v1/ai/session/{sessionId}/stream?message=...
```

The connection stays open. The backend writes events as the LLM generates and files are created. The frontend renders them in real time.

**SSE event types to implement:**
```
event: message        → text chunk to display in chat
event: file_created   → a new file was generated
event: file_updated   → an existing file was modified
event: done           → generation complete, here is the session summary
event: error          → generation failed, here is the error message
```

On the frontend, read the stream with `fetch` + `ReadableStream` (not `EventSource`, which doesn't support POST or custom headers):

```typescript
const response = await fetch(`/api/v1/ai/session/${sessionId}/stream`, {
  headers: { Authorization: `Bearer ${token}` },
});
const reader = response.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      handleEvent(event);
    }
  }
}
```

### Draft → Publish Pattern

**Never write directly to the permanent store during AI generation.** Use a temporary draft workspace:

1. User opens the creation flow → backend creates a `DraftSession` (one per user, temp storage path).
2. AI streams changes into the draft (files at `drafts/{sessionId}/...` in cloud storage).
3. User reviews the result in a live preview iframe.
4. User clicks Publish → backend copies files from draft path to permanent path and creates the final record.
5. Abandoned or failed generations have zero side effects — just orphaned draft records (auto-expire with a TTL index).

**One draft per user rule:** Use a unique index on `userId` in the DraftSession collection. Reuse or reset the same draft if the user opens a new creation session. This prevents unbounded draft accumulation.

### Content Moderation Before the LLM

Run a fast, cheap model (e.g. Claude Haiku) to pre-screen every user message *before* it reaches the expensive generation model:

```typescript
// ContentModerationService
async function moderate(userMessage: string): Promise<void> {
  // Fail-open: if moderation itself errors, let the message through
  try {
    const result = await utilityModel.check(userMessage, MODERATION_PROMPT);
    if (result.flagged) throw new ContentModerationError(result.reason);
  } catch (err) {
    if (err instanceof ContentModerationError) throw err;
    // Network/timeout error — fail open, log but don't block
    logger.warn('Moderation check failed, allowing message through', err);
  }
}
```

Checks: profanity, hate speech, explicit content, illegal activity, child safety. Return a `422 Unprocessable Entity` with a user-friendly message when flagged.

### LLM Response Schema

Ask the model to return structured JSON rather than free text, so file operations are unambiguous:

```json
{
  "message": "Text to show the user in the chat",
  "operations": [
    { "type": "create_file", "filename": "index.html", "content": "..." },
    { "type": "edit_file",   "filename": "styles.css",  "content": "..." },
    { "type": "delete_file", "filename": "old.js" },
    { "type": "patch",       "filename": "app.js", "patch": "unified diff..." }
  ],
  "metadata": { "title": "...", "description": "...", "tags": [...] }
}
```

`patch` is important for large files — sending the full file content on every edit is expensive in tokens. A unified diff is far smaller.

### Model Tier Routing

Not all tasks need the most powerful (expensive) model. Route by task type:

| Task | Model tier |
|---|---|
| AI content generation | Generation (default/expensive) |
| Content moderation pre-check | Utility (cheap/fast) |
| Metadata extraction (title, tags) | Utility |
| Visual output check | Utility |
| Complex multi-file generation | Complex (most capable) |

Auto-escalate to the complex tier when:
- Multiple modules/plugins are enabled (increases context size)
- There are large embedded files (>50K tokens)
- The previous generation attempt failed and is being retried

Admins configure which specific model maps to each tier in the admin portal.

### System Prompts Should Be Editable

Store system prompts in the database with a key (e.g. `"content_moderation"`, `"metadata_generation"`). Admin portal has a page to edit them live. This lets you tune AI behavior without a code deploy.

```typescript
// SystemPrompt model
{
  key: string,          // unique identifier
  name: string,         // human-readable label
  content: string,      // the actual prompt text
  isCustomized: boolean // false = using default, true = admin-edited
}
```

---

## 8. Feature Flag System

Admins control what the client shows from the database, not from code.

**Backend (AdminSettings model — singleton document):**
```typescript
{
  features: {
    billingEnabled: boolean,
    externalUrlsEnabled: boolean,
    featuredEnabled: boolean,
  },
  maintenanceMode: boolean,
  maintenanceMessage?: string,
  generationPaused: boolean,
  generationPausedMessage?: string,
  anonymousUserLimit: number,
}
```

**Client fetches on startup:**
```typescript
useEffect(() => {
  platformApi.getSettings().then(res => {
    setMaintenanceMode(res.data.maintenanceMode);
    setBillingEnabled(res.data.billingEnabled);
    // ... gate UI on these values
  });
}, []);
```

**Maintenance mode pattern:**
- If `maintenanceMode: true`, show a full-page maintenance screen to non-admins.
- Admins bypass the maintenance screen (so they can test while it's active).
- Show a warning banner inside the admin portal when maintenance mode is on.

**Generation pause pattern:**
- `generationPaused: true` blocks new AI generations without taking the whole site offline.
- In-flight generations are unaffected.
- The client reads this from platform settings and disables the Create button with a message.

---

## 9. CSS Architecture

- Default to **dark mode**; add light mode as overrides (`html[data-theme="light"]`).
- Use **CSS Custom Properties** for all colors so tenants can be whitelabeled: `--primary-color`, `--text-primary`, `--surface-1`, etc.
- Give each component its own `.css` file — no global styles leaking between components.
- Responsive breakpoints: 768px (mobile/tablet), 1024px (desktop).
- Side nav: `64px` collapsed (icons only), `220px` expanded (icons + labels).

---

## 10. Whitelabeling via Environment Variables

Put every user-visible product name in env vars. Centralize them:

```typescript
// config/labels.ts
export const itemLabel = import.meta.env.VITE_ITEM_LABEL || 'Item';
export const itemLabelPlural = import.meta.env.VITE_ITEM_LABEL_PLURAL || 'Items';
export const appName = import.meta.env.VITE_APP_NAME || 'MyApp';
```

Use these constants everywhere in the UI instead of hardcoded strings. The same codebase can now power multiple whitelabel deployments just by changing `.env` files.

---

## 11. Storage — Multi-Cloud Pattern

Abstract cloud storage behind a single service with a common interface:

```typescript
interface StorageService {
  uploadFile(path: string, data: Buffer, contentType: string): Promise<string>;
  getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string>;
  deleteFile(path: string): Promise<void>;
}

// Implementations: S3Adapter, GCSAdapter, AzureBlobAdapter
// Selected via STORAGE_PROVIDER env var
```

**Storage paths:**
```
items/{itemId}/v{version}/{filename}   ← published content
drafts/{sessionId}/{filename}          ← in-progress drafts
```

Use presigned URLs for downloads — never proxy large files through the Node.js server.

---

## 12. Analytics (Client Site)

Wire up analytics at the infrastructure level so individual components stay clean:

| Tool | What for |
|---|---|
| Firebase Analytics | Product analytics (DAU, funnels, events) |
| Meta Pixel | Ad conversion tracking |
| Google Tag Manager | GA4 + Google Ads |

**Key pattern:** For SPA navigation, the analytics SDK only fires PageView on hard load. Patch `history.pushState` to fire PageView on every in-app route change.

**Never send PII** (email, prompt text, user-written content) to analytics. Payloads should only contain anonymous IDs, event names, and numeric/boolean attributes.

---

## 13. Deployment Architecture

Two separate Nginx Docker containers (client + admin), plus the API and any background workers:

```
                         ┌─────────────────────────────┐
Internet → Nginx proxy → │ client-web  (port 3000)     │ → /
           (SSL/TLS)     │ admin-web   (port 8001)      │ → /admin/
                         │ backend-api (port 8080)      │ → /api/
                         └─────────────────────────────┘
```

Each Nginx SPA container uses:
```nginx
location / {
    try_files $uri $uri/ /index.html;   # SPA routing
    gzip on;
    gzip_types text/css application/javascript;
}
```

The admin container uses `base href="/admin/"` and the proxy rewrites `/admin/` → `admin-web:8001/`.

**Multi-stage Dockerfile for both apps:**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN yarn install --frozen-lockfile && yarn build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

---

## 14. Key Principles Summary

1. **Separate API namespaces** — `/api/v1` for users, `/api/admin/v1` for operators. Never mix.
2. **Auto-generate API clients** — don't hand-write API calls. Regenerate after every backend change.
3. **Axios interceptors for auth** — attach token on every request, silent retry on 401.
4. **SSE for AI generation** — never a single HTTP request. Stream events as they happen.
5. **Draft → Publish** — never write to permanent store during generation. Use a temp workspace.
6. **One draft per user** — unique index on userId prevents unbounded accumulation.
7. **Content moderation first** — cheap model pre-screens before expensive generation model.
8. **Feature flags from the backend** — admins control what users see without a code deploy.
9. **System prompts in the database** — admins tune AI behavior without code changes.
10. **Hard gate on admin** — if `isAdmin !== true`, render nothing admin-related.
11. **Maintenance mode bypass for admins** — admins always see the real site.
12. **Whitelabel via env vars** — all visible product names come from environment, not hardcode.
13. **Separate Docker containers** — client and admin are separate Nginx images, separate deploys.
14. **Anonymous users** — give guests a real identity (anonymous auth) so you can track their sessions and enforce limits before they sign up.
