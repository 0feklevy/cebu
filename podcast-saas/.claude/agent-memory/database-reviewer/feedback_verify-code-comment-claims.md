---
name: verify-a-code-comments-factual-claim
description: Treat a load-bearing code comment as a claim to verify, not a fact — a false one in revisionIdentity.ts propagated into an ADR and a task brief
metadata:
  type: feedback
---

When a comment (or a brief, or an ADR) states a *reason* that a design must be a certain way, verify
the reason against the code it describes before building on it.

**Why:** `podcast-saas/backend-api/src/services/simulation/revisionIdentity.ts` claims
`canary_passed` must stay publicly served because "the pre-activation canary drives the real document
over this route". It does not — `client-web/e2e/sim-canary.spec.ts` intercepts every request to the
API origin with `page.route` and fulfils it from an in-process fixture server reading `.sim-fixture`,
so no request ever reaches `sim-public.controller.ts`. That false justification had already been
copied into two test headers, into the research report §15.5, and into the task brief I was given —
and it was the only stated obstacle to the cheapest fix. Verifying it changed the recommendation.

**How to apply:** whenever a comment supplies the *justification* for keeping something permissive,
insecure, or awkward, spend the grep. Read the harness/caller it names and confirm it does what the
comment says. A justification repeated in four places is not four pieces of evidence — it is one
claim copied three times.
