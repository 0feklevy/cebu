---
name: flowvid-secret-file-guard
description: secret-*.txt is guarded by TWO overlapping ignore mechanisms in this repo — a tracked .gitignore rule and a local .git/info/exclude rule; check both when a brief says "via .git/info/exclude"
metadata:
  type: project
---

As of 2026-08-23 (main, and every branch checked: `fix/avatar-config-poison`,
`fix/candidate-smoke-image-env`, `chore/client-lint-ratchet`), `secret-*.txt` is ignored by two
independent rules:

- `.gitignore:47` — `secret-*.txt` — **tracked**, committed on main via `4800a9a chore: never
  commit owner-provided secret-*.txt remediation files`. This is the rule `git check-ignore -v`
  actually reports as the match (later-checked files win when both match).
- `.git/info/exclude` — also has `secret-*.txt`, preceded by the comment "Owner-provided credential
  files — machine-local protection, branch-independent". This is **local, untracked, and
  redundant** now that `.gitignore` carries the same pattern on every branch.

**Why this matters:** a task brief that asks to verify a secret-file ignore "via `.git/info/exclude`"
is describing the *original* (now superseded) mechanism. `git check-ignore <file>` still succeeds
(exit 0) either way — the end guarantee holds — but the evidence path in `-v` output will point at
`.gitignore`, not `.git/info/exclude`. Don't read that mismatch as a failure; it's the tracked rule
now doing double duty with the older local-only one.

**How to apply:** when auditing secret-file hygiene here, run `git check-ignore -v <name>` and
accept a match from either file as satisfying the requirement — but note explicitly which file
matched if the brief specifically named one, since that's a (harmless) drift from the stated
mechanism worth flagging as evidence, not silently substituting.
