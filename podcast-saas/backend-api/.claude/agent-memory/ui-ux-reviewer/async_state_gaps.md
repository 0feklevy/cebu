---
name: async-state-gaps
description: Recurring "spinner that can never resolve" bug class found across client-web's async surfaces — check new/changed poll loops against this list
metadata:
  type: project
---

FlowVid's #1 UX risk (per the review brief) is a long media operation whose loading state can get
stuck forever with no error and no way out. As of the 2026-08-15T2109 review (commit 2d187e3), this
pattern was confirmed in three places, all `setInterval`-based polls with no attempt cap / timeout
and no distinct "taking too long" state:

- `podcast-saas/client-web/components/viewer/ViewerPage.tsx` and the duplicated
  `SharedViewerPage.tsx` — the "processing" poll for a project's video only terminates on a thrown
  fetch error or `allFailed` (every segment `hls_status === 'failed'`); a stuck non-terminal
  transcode polls forever.
- `podcast-saas/client-web/components/podcast/studio/AudioStudio.tsx` — the mix-generation poll
  (`data.mix?.status === 'generating'`) has no cap or failed-path counterpart to the export poll
  right below it in the same file.

The one place this is done correctly is `useProjectExport.ts` — see [[reference-patterns]] for the
fix template (`MAX_CONSECUTIVE_POLL_FAILURES` + a "lost contact" message that doesn't claim
failure). When reviewing new or changed polling code in future runs, check it against that pattern
first before treating "poll forever" as novel — it's a known, named class in this repo
(`ui-ux-001`, `ui-ux-002` in the 2026-08-15T2109 run).
