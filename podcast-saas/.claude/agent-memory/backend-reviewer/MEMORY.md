# Memory Index

- [Anam session semantics](anam-session-semantics.md) — minting a token creates no session and holds no slot; the slot is claimed browser-side at `startSession`, and no termination endpoint exists
- [Anam start-path latency](anam-start-path-latency.md) — the "avatar comes up very very slowly" root cause (controller:197, commit b06feb4) and the stubbed-fetch timing harness that measured it
- [avatarSpendGuard suite mock ceiling](avatar-spendguard-suite-mock-ceiling.md) — that suite stubs the mint, the transcript and the enrich call, so "the start survives X" tests added there are decorative
- [Review the PR sha, not the worktree](review-the-pr-sha-not-the-worktree.md) — the checkout can switch branches mid-review; pin citations and test runs to the PR commit
