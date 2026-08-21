---
name: scope-hardening
description: client-web/admin-web hooks and media-lifecycle code has already been through many review rounds — where the real gaps still are
metadata:
  type: project
---

As of the 2026-08-15T2109 review run, `podcast-saas/client-web` and `podcast-saas/admin-web` carry
extensive in-line audit history: comments cite prior findings by id (`frontend-NNN`, `perf-NNN`,
`P0.1`-`P0.8`, `cc fix`, `sim-race fix`, `THUMB`, `D2b`) directly in the source. The highest-traffic
hook files are the most hardened:

- `client-web/components/viewer/useProjectPlayer.ts` (~4000 lines) — the resident sim pool /
  transition coordinator / paint-gated reveal machinery. Extremely dense but each hazard class
  (stale closures, double-eviction, unmounted-timer callbacks, HLS cleanup) has a comment
  explaining why it was already fixed and how. Do not re-derive bugs here without reading the
  surrounding 50+ lines of comment — most "obvious" races are pre-empted by a generation counter
  or an `unmountedRef`/`isEvicting` guard documented right above.
- `client-web/hooks/useEditorPlayback.ts`, `client-web/lib/useProjectExport.ts`,
  `client-web/lib/useProjectDuplication.ts`, `client-web/components/VideoUploader.tsx`,
  `client-web/components/podcast/studio/mixEngine.ts` + `useClipBuffers.ts`: all correctly guard
  polling/async effects with `aliveRef`/`cancelled` + a consecutive-failure bound, and correctly
  tear down HLS/AudioContext instances on unmount. Checked exhaustively in this run — clean.

**Where real gaps were still found** (see `podcast-saas/backend-api/.claude/agent-memory/frontend-reviewer/known_gap_pattern.md`):
cleanup that exists on the *viewer* side of a shared primitive but was never mirrored onto the
*editor* side (or vice versa) — the two players (`useProjectPlayer.ts` for the public viewer,
`VideoPlayer.tsx`'s `MultiClipPlayer` for the editor preview) share lifecycle-sensitive modules
(`lib/avatarAudioGraph.ts`) but each wires its own effects, so a cleanup added to one after an
audit does not automatically apply to the other. When reviewing a module with a "release on
unmount" contract, always check *every* call site of the mount half, not just the one you found
first.

Also: SSE/EventSource handlers in this codebase are inconsistently guarded — most inline
`JSON.parse` calls are wrapped in try/catch, but a few blocks (see
`SectionEditor.tsx` guidance-stream listeners) are not, in the same file as guarded ones a few
lines away. Worth a targeted grep (`JSON.parse` without an enclosing try) on any future pass.
