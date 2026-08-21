# Memory Index

- [FlowVid editor/admin hardening](flowvid-editor-admin-hardening.md) — editor giants + admin-web are heavily pre-reviewed; new bugs cluster in optimistic-update/save-error paths, not lifecycle/cleanup.
- [FlowVid viewer/player hardening](flowvid-viewer-player-hardening.md) — useProjectPlayer.ts/HLSPlayerShell/lib/sim/** are the most audited code in the repo; new bugs are closure-staleness (plain prop vs ref), not leak/cleanup.
