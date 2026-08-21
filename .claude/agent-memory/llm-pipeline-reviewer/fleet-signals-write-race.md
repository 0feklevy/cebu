---
name: fleet-signals-write-race
description: signals.md in a review run is declared append-only but reviewers only have whole-file Write, so concurrent agents silently clobber each other's blocks
metadata:
  type: project
---

`OUTPUT_DIR/signals.md` is declared append-only in `.claude/review/PROTOCOL.md` §3, but reviewers
have no append primitive: `Edit`/`NotebookEdit` are denied by the fleet guard and Bash is a
read-only allowlist, so the only way to add a signal is a whole-file `Write`. When several reviewers
finish around the same time, later writers silently drop earlier blocks.

**Why:** observed empirically in run `2026-08-15T2109` — the billing-integrity and job-queue blocks
were present on my first read and gone on the next three; the file also grew a fresh block between
almost every read/write attempt I made. The Write tool's "file has been modified since read" guard
prevents *my* clobber but does nothing about the ones that already happened.

**How to apply:** when appending to `signals.md`, (1) do `Read` immediately followed by `Write` with
no tool call in between — any intervening call loses the race; (2) diff what you just read against
your earlier read and restore any block that vanished, noting the restoration inline; (3) expect to
retry several times late in a run. If the orchestrator ever moves to `signals/<domain>.md` (the fix
I recommended, mirroring how `findings/<domain>.md` already works), none of this applies.
