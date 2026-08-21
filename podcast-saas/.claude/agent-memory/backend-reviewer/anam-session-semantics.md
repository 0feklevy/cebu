---
name: anam-session-semantics
description: Anam v4 concurrency-slot semantics — minting a session token does NOT create a session or hold a slot; the slot is claimed browser-side at startSession, and no termination REST endpoint exists
metadata:
  type: reference
---

Established 2026-08-16 by reading the vendored SDK at
`podcast-saas/client-web/node_modules/@anam-ai/js-sdk` (v4.13.1). Not derivable from
`backend-api/src` alone — the backend hand-rolls its Anam calls and never imports the SDK.

**The key distinction.** `dist/main/lib/CoreApiRestClient.d.ts` declares exactly two methods:
- `unsafe_getSessionToken(personaConfig) → string` — this is what our backend re-implements by hand
  (`POST /v1/auth/session-token`). Returns a bare token. **Creates no session.**
- `startSession(personaConfig?, sessionOptions?) → StartSessionResponse` — returns
  `{ sessionId, engineHost, engineProtocol, signallingEndpoint, clientConfig }`. **This is where a
  session and its concurrency slot first exist.** Called only from the browser
  (`dist/main/AnamClient.js:133/143`, via `startSessionIfNeeded` at `:195/:198`).

**Consequences worth remembering:**
- A minted-but-never-streamed token leaks nothing. "The backend leaked a concurrency slot" is a
  false hypothesis about this API — I refuted it once already.
- The concurrency limit is enforced at `startSession` and surfaces to the *browser* as a typed
  `ClientError`, code `CLIENT_ERROR_CODE_MAX_CONCURRENT_SESSIONS_REACHED`, HTTP 429, cause
  `'Concurrent session limit reached'` (`CoreApiRestClient.js:116-117`). The backend cannot see it
  and no env/config/API field exposes the account's limit.
- There is **no** session-termination REST endpoint in the SDK. Release happens by tearing down the
  transport: `client.stopStreaming()` → `streamingClient.stopConnection()`.
- The only server-side bound on a session is `maxSessionLengthSeconds`, which *we* send in every
  personaConfig (default 600 s).

**How to apply:** when anyone proposes server-side session bookkeeping, a reaper, or an
`endSession()` in `anamService.ts`, check this first — the prerequisite (a `sessionId`) only exists
in the browser, so any such design needs the client to report it. Re-verify against the installed
SDK version before acting; the vendor could add a termination endpoint later.

Related: [[anam-start-path-latency]]
