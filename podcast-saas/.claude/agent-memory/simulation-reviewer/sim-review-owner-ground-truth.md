---
name: sim-review-owner-ground-truth
description: The owner briefs sim reviews with live-test results labelled "treat as ground truth" — take those as settled, spend the budget on what the tests could not see
metadata:
  type: feedback
---

When the owner opens a simulation review, they hand over a block of results from live integration
tests they ran that day and say to treat it as ground truth (upload/storage, bridge generation,
revision lifecycle, `/sim-public` serving, v2/v3 protocol lifecycle, concurrent WebGL documents,
poster capture). Accept those as settled — do not re-derive them — and aim the review at the
*complement*: what a passing live test could not have observed.

**Why:** on 2026-09-04 every one of the real findings sat outside what the green tests could see.
The live tests ran against the Supabase/local storage path, so they could not observe that the R2
adapter serves sims from the bucket instead of `/sim-public`. They ran on a fast local link, so they
could not observe that `SIM_PREPARE_TIMEOUT_MS` is a hard-coded 5 s. And the owner's own out-of-band
observation (`timeline_sections.sim_meta` rows are jsonb *string scalars*) was worth more than any
test in the suite, because no test in the suite asserts a column's jsonb shape.

**How to apply:** for each "verified working" item, name the axis it was verified on (which storage
adapter, which link speed, which device tier, which package size) and review the other values of
that axis. Two specific traps this repo has already sprung: a test that fakes the DB cannot see a
CHECK constraint (`posterService.test.ts`), and a DDL test that casts `$n::jsonb` itself cannot see
the ORM's write path. Also: the owner's premise in the brief may be wrong in an interesting way —
they asked whether the non-stream generate route skips a validation the stream route performs; both
call the same function, and the real defect was that nothing anywhere sets `runtimeValidated` true.
Say so plainly rather than answering the question as posed. See [[project-heavy-3d-package]].
