# Decision response for Claude — 2026-08-17 · updated 2026-08-18

I reviewed the decisions against `fix/night-audit-2026-08-15` at `a63aa4e`, including the
editor, viewer, export, auth/collaboration, avatar, and simulation-revision paths. Treat the
following as the decision reply. Please update `DECISIONS.md` to reflect the corrected premises
before implementing them.

## D-01 — choose ripple, with these exact semantics

First correct the incident description. A true b-roll row is emitted from
`buildPlayerConfig.ts:555-575` with `s.global_offset_sec` unchanged. The cumulative duration at
`:581-587` is used for clip/image overlays. The real bug is that an absolute second stays fixed
while the main content underneath it moves; it is not that line 587 rewrites true b-roll.

### D-01a — ripple, anchored to a main timeline segment

Anchor to a stable **main video segment id + local offset**, not to a
`timeline_sections.section_id`. Timeline sections are sparse annotations/overlays and do not cover
every point. A b-roll row's current `video_file_id` is its source asset, so add an explicit nullable
anchor pair such as `anchor_video_file_id` + `anchor_offset_sec` (or a proper stable timeline-segment
entity); do not overload the source id again. Derive absolute time in one shared resolver used by
editor, viewer, prewarm/markers, and export.

Use half-open segment boundaries and define a legal last-segment post-roll tail. Apply the same
anchor abstraction to audio cutaways. Record a follow-up for absolute markers and manual avatar
ranges, which otherwise retain the same drift class.

### D-01b — distinguish duration correction, replace, and delete

- Probe/retranscode or an upstream duration correction: do not rewrite stored placement rows. The
  derived absolute time ripples automatically from the stable host anchor.
- Replace the media of the same logical segment: retain the host id/local offset, but stage and
  probe first. If the anchor/window is outside the new duration, put it in an impact-review list;
  do not silently clamp, zero, or attach it to a neighbor.
- Delete an anchored host: use `RESTRICT` (or an equivalent transactional preflight) and require an
  explicit user choice to move or delete dependents. Never automatically re-anchor to “the next”
  content.

The generated-b-roll job must store the host anchor at enqueue time. It currently stores only an
absolute target and may finish much later, after the timeline has changed; inferring the anchor at
completion recreates the race.

### D-01c — overlap allowed, one deterministic winner

Allow overlap, but this is winner-takes-all, not simultaneous compositing. Add explicit `z_index`
plus an immutable monotonic `stack_seq` insertion-order tiebreak. The shared rule is: existing layer
class priority (sim/poster > image > clip/b-roll > base), then `z_index`, then `stack_seq`. Do not use
last-written: an unrelated PATCH must not change stacking. The editor must expose which clip is on
top and make hidden overlaps visible.

### D-01d — live scheduling, versioned and boundary-safe

Apply a new config to future b-roll boundaries in an open viewer, but pin the currently active clip
until its boundary so an editorial correction cannot flash/swap mid-shot. A security/takedown
override may remove immediately. Reconcile the schedule and prewarm plan from one atomic config
revision/ETag. Structural main-timeline changes remain session-snapshotted until publication
revisions exist; this is not permission to mutate a playing timeline piecemeal.

### D-01e — visual b-roll is silent

Keep visual b-roll silent and align editor, viewer, and export. The current published viewer already
hard-mutes both b-roll elements and export removes their audio. The existing `broll_volume` default
is actually `1.0`, so it is not evidence for silence; the editor's video-volume control is currently
misleading. Reserve gain for audio cutaways. If natural sound is added later, introduce an explicit
`audio_mode = muted | mix | duck_main` (default `muted`) and a ducking contract; never interpret
legacy `broll_volume=1` as opt-in.

### D-01f — cap to the authoritative source, with a warning

Do not loop or silently freeze. Once authoritative metadata exists, cap the out-point/window to the
available source and show the shortening before commit. Defensively apply the same cap in viewer
and export. A freeze may later be an explicit `fill_mode` with a separate requested window duration,
but it is not the default. Do not invent a 30-second source duration while metadata is unknown.

### D-01 rollout and legacy data

Use expand/contract: nullable anchor pair + placement mode (`segment` or `legacy_absolute`), dual
read (anchor first, absolute fallback), then new-write-only anchors. Do **not** silently backfill all
legacy rows: mapping today's absolute second onto today's segment can canonize an already-wrong
placement. Produce a dry-run/report and convert on explicit review/drag (“keep current visible
location”). Exclude unknown-duration, out-of-range, and branched rows from any automated candidate.
Add project/non-broll validation, duplication remapping, transactionally snapshotted export inputs,
and deterministic overlap tests across editor/viewer/export.

## D-02 — the current fix is incomplete; close the P1, then Option 1

The premise in D-02 is materially false right now. `a63aa4e` gates the middleware's invite-claim
UPDATE, but:

- `services/collabAccess.ts:28-33,118-123` still authorizes directly when `users.email` equals
  `collaborators.invited_email`, without verified-email state;
- `controllers/v1/collaborators.controller.ts:99-111` binds a new invite to any existing DB user
  with that email; and
- self-removal at `:139-143` uses the same raw-email fallback.

Therefore an unverified account can still receive collaborator access even though the tested claim
UPDATE did not run. Fix this before historical remediation: authorization and self-removal must be
`user_id`-only; invite creation stays pending instead of resolving by raw `users.email`; only a token
with `email_verified === true` may claim. Add an integration test that drives `editableProject`, not
only a unit test asserting that no UPDATE occurred.

After that, choose **Option 1: read-only report first**. SQL alone cannot answer it: `users` stores
neither verification nor admin-grant provenance, collaborators store no claim provenance, and
admins can be granted manually. Join candidates by `firebase_uid` to Firebase Admin and report
current verification/disabled/provider state plus DB/Firebase/invited-email mismatches. Start with
counts; deliver PII only through a private channel and do not commit it or put it in CI artifacts.

If the report is zero, stop. If it is non-zero, use targeted, reviewed remediation rather than a
blind bulk script. Protect the last legitimate admin from lockout. For suspicious collaborators,
remove the resolved `user_id`/revoke the invite only after the raw-email authorization paths are
gone, notify the owner, and review activity since the claim. For suspicious admins, revoke only
after confirming grant provenance as far as possible and review subsequent admin grants/secret
exposure. Option 3 is not sufficient: collaborator access is broad edit authority too. Do not run
any production mutation without explicit approval of the report.

## D-03 — Option 1, preserving anonymous public viewing, but capability-bound

Anonymous avatar use is intentional in the current product: shared/public viewers expose Ask
Avatar, and guests use Firebase anonymous auth. Requiring ordinary middleware auth would not fix
abuse because disposable anonymous accounts still pass it; requiring a non-anonymous account would
be a real feature regression.

Implement Option 1 with these requirements:

1. `projectId` is mandatory for public starts; reject the current bodyless/global path.
2. The canonical player/share/permalink access path, after visibility, share-token, and paid
   entitlement checks, mints a short-lived `aud=avatar` capability bound to project, entitlement,
   and nonce/jti. A project UUID is not a capability, especially for unlisted content.
3. Require that same capability on `/avatar/start`, `/avatar/visual/analyze`, and
   `/avatar/image/analyze`. The analyze routes currently accept arbitrary project ids and can touch a
   private basic library as well as spend money.
4. Atomically reserve weighted cost in Postgres **before** the vendor call. Layer limits by HMAC(IP),
   Firebase uid (including anonymous), capability jti, project, owner/account, and a platform-global
   budget. Keep the process-local limiter only as a burst shield. Add concurrency limits,
   `Retry-After`, alerts, and a global kill switch. Fail closed for billable calls if the durable
   reservation cannot be made.
5. `/avatar/end` is a no-op, so do not trust it to release cost. Reserve worst-case Anam duration or
   reconcile against vendor usage. Weight image/simulation analysis by its actual possible fan-out,
   not one request = one unit.
6. Scope idempotency/token caching to viewer/capability. The current short cache can hand the same
   Anam token to unrelated viewers with identical config.

Immediate safe phase: strict Zod bodies, mandatory project/capability-ready call shape, conservative
burst caps on all three endpoints, and kill switch. Then deploy the durable meter in shadow mode
briefly for calibration while emergency caps remain enforced, followed by enforcement. Store only
short-retention HMACs of IPs. Also record a product/privacy follow-up: disclosure/consent, retention
and deletion for transcripts/conversation facts/generated visuals, and never log tokens or
capabilities.

## D-04 — Option 2 now for revisioned sims; full Option 1 next, independent of D-01

Fail loudly now, but only when `active_revision_id` exists; legacy sims still use the mutable prefix
and should retain their working paths.

- Replace: return a stable structured 409 such as `SIM_REVISION_WRITE_UNSUPPORTED` before multipart
  parsing, the status CAS, or any storage write.
- Publish guidance: because this is EventSource, establish SSE and emit a named error with the same
  stable code before changing `guidance_status`, voice/TTS work, or upload. A pre-SSE JSON 409 is
  rendered by the current client as only “Connection lost.”
- Add tests proving zero DB/storage/TTS mutation for a blocked revisioned sim and retain legacy
  happy-path coverage. Disable the UI action with the same explanation as defense/UX, but keep the
  server guard authoritative.

Correct the finding references: dead guidance is `simulation-002`, not `simulation-003`.
`simulation-003` is the separate source-context split: reads/replace compatibility use legacy
source/bridge while publication derives from the active revision. Fix that read path now to use the
active manifest and `package/bridge.js`; blocking new replaces does not repair already-diverged data.

The full revision-aware implementation does **not** depend on D-01. Build one shared primitive:
derive from active revision -> transform -> draft/upload/validate -> CAS activate with
`expectedActiveRevisionId`. Replace combines uploaded customer files with the live bridge/guidance;
guidance derives a new revision, injects `guidance.js`/the entry tag, and updates metadata/status in
the activation transaction/callback. Do not rewrite N section URLs with `?g`; the new revision URL
is the cache bust. Make file/download/UI-control reads revision-aware too. Do not rely on a
process-local lock for activation.

PR #31 is the real ordering dependency for this full implementation because its
`RevisionService.validate` contains the capture-compatibility gate. Keep the full work on top of
that head, but do not wait for D-01.

Finally, produce a read-only reconciliation report for historical false successes: revisioned sims
marked guidance-ready whose active manifest lacks guidance, and legacy sources replaced after the
active revision forked. Do not auto-promote legacy bytes; the active bridge may have diverged and the
old compatibility check read the wrong source.

## D-05 — keep deferred

Do not merge PR #31 yet. Preserve the branch ordering and continue the safe guards/fixes above on
the branch already based on #31. No production data mutation, no anchoring bulk migration, and no
merge without a new explicit instruction.

---

# עדכון שני — D-06 עד D-09

העדכון הזה נכתב לאחר קריאה חוזרת של הקוד, המיגרציות, מסלול ה-deploy, קורפוס הביקורת
והשינויים הלא-מחויבים בענף. בזמן הבדיקה `DECISIONS.md` השתנה: D-01–D-05 עברו לארכיון,
ו-billing הוגדר מפורשות כ-**מחוץ לתחום בסשן הנוכחי**. ההוראה המאוחרת הזאת גוברת: הניתוח של
D-07 נשמר להמשך, אבל הוא אינו אישור לבצע עכשיו עבודת billing, להריץ דוח production או לשנות
entitlements.

ה-worktree הנוכחי מלוכלך ואינו בסיס שחזור. לכן verdict היסטורי צריך להיות מוצמד ל-`2d187e3`,
ו-verdict על המימוש הנוכחי צריך להיות מוצמד ל-commit חדש ומדויק לאחר שהשינויים יחולקו ויחויבו;
אסור לסגור finding על סמך מצב זמני של קבצים לא-מחויבים.

## D-06 — התיקונים מתקבלים; זו אינה החלטה פתוחה

ארבעת התיקונים נכונים, והנוסח המתוקן כבר תואם את הקוד:

- true b-roll משתמש ב-`global_offset_sec` השמור; חיבור משכי הווידאו שייך ל-clip/image overlays;
- `broll_volume` אכן ברירת מחדל `1.0`, ולכן אינו ראיה לכוונת mute;
- dead guidance הוא `simulation-002`; `simulation-003` הוא פיצול source-context;
- תיקון ה-email הראשון בדק שה-claim לא נכתב, אך לא בדק אם authorization עדיין עוקף אותו.

תיקון ה-collaborator שנמצא כעת ב-worktree סוגר את שני מסלולי ה-raw-email, יוצר הזמנה תמיד
כ-pending ומוסיף בדיקת integration שמניעה את ה-middleware ואת `editableProject`. זה בדיוק סוג
הבדיקה שהיה חסר. שמור את המבחן כתנאי קבלה, אך העבר את D-06 ל-correction log/ארכיון — פריט שמבקש
שום בחירה מהבעלים אינו שייך לרשימת החלטות פתוחות.

## D-07 — deferred לפי הוראת הבעלים; לא להסיק מכך שהבאג הוא P3

אין לבצע D-07 בסשן הנוכחי. סמן את הממצאים `OUT_OF_SCOPE (billing)` ושמור אותם; אל תריץ גם את דוח
ה-production כרגע, משום שה-scope המעודכן מוציא במפורש גם דוחות billing.

עם זאת, כאשר התחום ייפתח מחדש, השאלה "האם paid בשימוש היום" תקבע אם יש **incident פעיל**, ולא אם
גבול ההרשאה נכון. אין feature flag סביב המסלולים, בעלים יכול לשנות `access_type` ל-`paid` ב-API גם
כאשר Stripe אינו מוגדר, ויצירת תוכן paid היא שינוי נתונים/קונפיגורציה בלבד. לכן `unknown` אינו
שווה `not live`, ואפס שורות production יוריד את דחיפות התחקור — לא יהפוך את הלוגיקה הנגישה לנכונה.

כשחוזרים לנושא, זו מטריצת ה-entitlement שאני מאשר:

1. playlist חינמית לעולם אינה מרחיבה entitlement של project בתשלום.
2. יש לבצע את בדיקת ה-project **לפני** `buildPlayerConfig`; פריט נעול מוחזר כ-union מפורש ללא
   `config`, HLS/fallback URLs, captions, simulations, avatar capability או כל media secret.
3. הרשאת edit של collaborator עשויה לתת לו preview אישי, אך אינה רישיון לפרסם או למכור את תוכן
   בעל הפרויקט לקהל. כיום הטענה בקוד ש-items הם owner-owned שגויה: replace-all מקבל גם פרויקטים
   שבהם המשתמש רק collaborator.
4. עד שיש bundle אמיתי, יש לחסום מכירה חדשה של playlist שמכילה paid projects, ולא לחייב לקוח על
   playlist ואז שוב על כל item. bundle עתידי חייב לכלול membership version/snapshot בזמן הרכישה,
   אותו בעלים או רישיון מפורש לכל item, וכלל הכנסות/הסרה מוגדר.
5. אין לשנות רטרואקטיבית קונים קיימים לפני דוח read-only ו-grandfather/remediation. הסכמה אינה
   שומרת היסטוריית membership, ולכן אי אפשר לשחזר בביטחון מה בדיוק הובטח בעת הרכישה.
6. רק הערך המפורש `free` ייפתח ללא entitlement; ערך `access_type` לא מוכר צריך להינעל/להיכשל,
   ולא להיפתח כפי ש-`!== 'paid'` עושה כיום. לאחר census יש להוסיף CHECK constraints.

ה-frontend צריך union מפלה של playable/locked item. autoplay, shuffle ו-up-next אינם רשאים
לעשות dereference ל-`config` חסר או לדלג בשקט; הגעה לפריט נעול עוצרת ומציגה paywall של הפרויקט.
גם לאחר תיקון התגובה, media שכבר נחשף דרך URL ציבורי/ארוך-חיים נשאר residual risk — סגירת D-07
בעתיד מחייבת גם byte-level entitlement או signed URLs קצרים, לא רק redaction של JSON.

## D-08 — מקבל את העיקרון, דוחה את ה-sweep השטוח ואת ברירת המחדל

אסור לממש finding לא-מאומת, אבל אימות עצמי של אותו מממש רגע לפני edit אינו adversarial
verification, ו-sweep של 301 כותרות אחת-אחת מבזבז עבודה על כפילויות. המספרים המתוקננים הם:

- 330 findings ייחודיים: 5 P0,‏ 62 P1,‏ 182 P2 ו-81 P3;
- רק 29 IDs מתוך הקורפוס קיבלו verdict adversarial: 28 CONFIRMED ו-1 REFUTED;
- לכן 301 הלא-מאומתים כוללים **גם 5 P0 ו-33 P1**, נוסף על כל 182 ה-P2 וכל 81 ה-P3;
- מתוך 28 שאושרו, 22 כבר הורדו מ-P1 ל-P2. זה מוכיח אמפירית שה-severity של המאתר אינה verdict.

גם שלמות ה-artifacts דורשת תיקון לפני שסומכים עליהם. `VERIFIED.jsonl` מכיל 33 שורות, אך רק 29
מזהי finding ייחודיים מן הקורפוס: `database-002` כפול ושלושת `orch-*` חסרי finding מקור. בריצה
חסרים `MANIFEST.md`,‏ `REPORT.md` ו-`FIX_PLAN.md`; חמישה קובצי Anam/b-roll נוספו שעות לאחר יצירת
קובץ האימות. `status: "confirmed"` ב-320 שורות raw הוא טענת המאתר בלבד. השדה
`correctedSeverity` ב-ledger ריק ומאבד את ההורדות שכבר הוכרעו.

### סדר העבודה המאושר

1. עצור תחילה והכרע את תקינות כלי הביקורת עצמם (`fleet-*` וה-guard). P0 של כלי audit יתויג
   `AUDIT_BLOCKER`, בנפרד מ-P0 מוצרי; אין להפעיל שוב fleet אם מנגנון ה-read-only אולי אינו נאכף.
2. בצע אימות עצמאי מיידי לכל 38 ה-P0/P1 שנותרו לפני sweep נמוך יותר.
3. קבץ את 263 ה-P2/P3 לפי root cause, ושמור את כל ה-IDs כ-aliases/impact facets. מאמתים cluster
   קנוני פעם אחת, לא את אותה תקלה תחת שלוש כותרות.
4. בתוך ה-clusters תעדף reachability ונזק: suspected, auth/security/data-integrity, cost/billing
   כאשר יחזור ל-scope, ואז blast radius. P3 יאומת on-touch או בבאץ' של שינוי מתוכנן — לא sweep
   יקר רק כדי לסמן וי.

המאמת חייב להיות agent/אדם אחר מהמאתר ומהמממש, ולהתחיל בכתיבת התנאים שהיו מפריכים את הטענה.
לכל cluster שמור שני צירים נפרדים:

- `historicalVerdict` על בסיס audit קפוא: `CONFIRMED | REFUTED | UNCERTAIN`;
- `currentDisposition` על commit יעד מדויק: `OPEN | PARTIAL | ALREADY_FIXED(commit) | STALE |
  DUPLICATE_OF | BLOCKED`.

היעלמות הבאג בענף הנוכחי אינה הופכת טענה היסטורית ל-REFUTED. חובה גם `rootCauseId`, aliases,
severity מתוקנת, base hashes, production reachability, guards/alternate paths שנבדקו, evidence
מדויק, repro או test מבחין וזהות המאמת. לפני edit עושים freshness check קצר על commit היעד; זו
אינה תחליף לאימות הראשוני. ככל שניתן, המימוש חייב להציג מבחן אדום לפני וירוק אחרי, ובסוף verifier
נפרד/task-tracker בודק wiring ושהמבחן אכן היה נכשל ללא התיקון.

לריצות הבאות הוסף completion barrier לכל reviewers, snapshot+hash של כל הקורפוס ורק אז verification;
finding שמגיע מאוחר נכנס ל-supplement run. אכוף מכנית unique IDs, foreign keys והמשוואה
`raw = verified + not_verified`. raw findings נשארים immutable; verdict ומצב מימוש נכתבים
כרשומות נפרדות ואטומיות.

## D-09 — אף אחת משלוש האפשרויות כפי שנוסחו

אל תפרוס את 062 כפי שהוא, ואל תרחיב כרגע את ה-runner. הסף של 100k שורות אינו בסיס בטיחותי:
זמן החסימה תלוי בגודל פיזי, bloat, I/O, write rate וטרנזקציות ארוכות. בנוסף, `ALTER TABLE` בתחילת
062 לוקח lock חזק, וה-runner מחזיק את locks של כל הקובץ עד COMMIT — כך שה-warning על שלושת
האינדקסים אפילו ממעיט את חלון החסימה. PostgreSQL מתעד במפורש ש-`CREATE INDEX` רגיל חוסם writers,
בעוד `CONCURRENTLY` עושה שתי סריקות, ממתין לטרנזקציות ועלול להשאיר index במצב INVALID
([CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html),
[explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)).

### 062 — השתמש בשורת ה-job כנקודת הסריאליזציה

האינדקס הייחודי על `timeline_sections` אינו דרוש לתיקון המרוץ המאומת. ל־`video_generation_jobs`
כבר יש `section_id`, וה-finalization החדש כבר מכניס section ומבצע update
fenced של ה-job באותה טרנזקציה. חזק והפוך את ההוכחה למפורשת:

1. בתחילת טרנזקציית finalization קצרה בלבד, נעל את שורת ה-job ב-`SELECT ... FOR UPDATE`;
2. לאחר ההמתנה אמת `claimed_by`, סטטוס in-flight ו-`section_id`;
3. אם `section_id` קיים — אמץ אותו; אם הוא NULL — צור section אחד;
4. סיים ב-UPDATE fenced שדורש גם `section_id IS NULL`; כישלון זורק ומגלגל לאחור את ה-INSERT.

אם ריצה A מסיימת ראשונה, claim של successor ממתין ואז נכשל כי הסטטוס כבר `ready`. אם successor
תפס קודם, ה-update של הריצה שאיבדה את ה-lease נכשל וה-INSERT שלה מתגלגל לאחור. זה invariant של transaction,
לא constraint נגד SQL שרירותי — וזה מספיק לבאג במסלול המאומת. אם בעתיד רוצים defense-in-depth
ברמת הסכמה, מוסיפים reverse provenance online בנפרד.

לכן, כל עוד 062 טרם הוחל באף DB מתמשך:

- הסר את `timeline_sections.generation_job_id`, ה-FK, האינדקס הייחודי ונתיב `ON CONFLICT` שתלוי בו;
- השאר את עמודות ה-lease;
- דחה את `idx_vgj_inflight` עד `EXPLAIN` על נפח מייצג. השאילתה בפועל מסננת status בלבד ואין בה
  `ORDER BY`, בניגוד להערת המיגרציה; זה אינדקס ביצועים, לא תנאי נכונות;
- הוסף `lock_timeout` נמוך ל-DDL הקצר שנותר, כדי ש-deploy ייכשל מהר והגרסה הישנה תמשיך לשרת.

ה-product מאפשר להכניס ידנית שוב asset שנוצר בעבר, ולכן ה-invariant האמיתי אינו "job/asset מופיע
רק פעם אחת בטיימליין" אלא "finalization אוטומטי אחד מפרסם לכל היותר שורה אחת". שורת ה-job היא
המקום הנכון לאכוף אותו.

האינדקס המוצע גם אינו מתקן legacy: כל section מלפני 062 יקבל `generation_job_id=NULL`, ולכן לא
יתנגש בשורה חדשה. המבחן שקורא למצב “pre-062 orphan” אך שותל לו `generation_job_id` מדמה מצב שלא
יכול היה להתקיים. החלף אותו במבחן migration-boundary אמיתי, והפק census read-only על orphans
וכפילויות בלי שיוך או מחיקה אוטומטיים.

### 060 — אין צורך באינדקס הנוסף

`project_exports_fingerprint_idx(project_id, plan_fingerprint)` אינו משמש predicate בשום query;
`plan_fingerprint` נבדק לאחר טעינת export לפי ה-PK, וכבר קיים אינדקס `(project_id, created_at)`
לרשימות. הסר את האינדקס וההערה לפני היישום הראשון. קודם בדוק `schema_migrations` בכל DB מתמשך:
אם 060 כבר נרשם במקום כלשהו, אסור לשנות קובץ שה-checksum שלו אומץ — השאר את ההיסטוריה והשתמש
רק במיגרציה קדימה אם צריך.

### ה-rollout הראשון הוא הסיכון הגדול יותר

ה-deploy מריץ migrations בזמן שה-backend/worker הישן עדיין משרת, ואז מחליף containers. הקוד הישן
מבצע INSERT ל-section ועדכון job בשתי פעולות, ו-graceful stop מוגבל ל-30 שניות מול job של עד
כ-25 דקות. הריגה ביניהן משאירה orphan. בנוסף, migration נותן ל-job ישן `attempts=0`; אם worker
ישן נהרג ב-`submitting` לאחר שה-provider קיבל בקשה אך לפני שמירת task id, הקוד החדש יעלה ל-1
ויחשוב שזה ניסיון ראשון — double charge אפשרי.

לכן לפני ה-rollout הראשון:

1. הפעל `generation_paused` כדי לעצור submissions חדשים. זה kill switch גלובלי שמשבית גם יצירות
   אחרות, ולכן יש לתאם חלון תחזוקה; הוא אינו עוצר jobs שכבר נשלחו או startup recovery;
2. המתן עד שאין jobs ב-`queued | enhancing | submitting | generating | downloading | transcoding`;
3. אם אי אפשר לנקז, סווג ידנית — בפרט אל תחדש אוטומטית `submitting` ללא `external_task_id`;
4. הרץ census read-only של legacy sections/jobs, deploy, smoke של job אחד, ואמת שה-`section_id`
   שלו מצביע על section יחיד;
5. רק אז בטל pause. אין להריץ rollback migration בשחזור קוד רגיל; עמודות additive נשארות.

זהו runbook לתכנון ואישור deploy — לא אישור לבצע פעולה בפרודקשן כעת.

### חיבור המיגרציות עצמו דורש תיקון

ה-runner משתמש ב-session advisory lock, אבל התיעוד מאפשר `DATABASE_URL` דרך Supabase transaction
pooler ב-6543, והמיגרציות משתמשות דווקא בו. `max:1` מצמיד connection ל-pooler, לא backend של
Postgres; lock עלול להישאר ב-session אחר ולא לסריאל migrations. דרוש `MIGRATION_DATABASE_URL`
ישיר/session-mode (או fallback מפורש ומאומת ל-`QUEUE_DATABASE_URL`) וכשל מוקדם על transaction
pooling. רשום זאת כ-deploy prerequisite, לא כהערת שוליים.

בדיקת הקבלה חייבת להשתמש ב-PostgreSQL אמיתי ובשני connections עם barriers; PGlite יחיד אינו
מוכיח locking בין sessions. כסה stale worker מול successor, גניבת claim רגע לפני finalization,
throw אחרי INSERT ולפני UPDATE, redelivery אחרי commit ומחיקת job במקביל. בכל מקרה נשאר לכל היותר
section מחויב אחד.

אם בכל זאת תחליטו שחובה reverse constraint ברמת DB, רק אז השתמשו בגרסה מצומצמת של Option 2:
DDL תוספתי טרנזקציוני, קובץ נפרד המכיל **statement יחיד** של
`CREATE UNIQUE INDEX CONCURRENTLY`, אימות ההגדרה/predicate ו-`indisunique`, `indisready`,
`indisvalid`, ורק אחר כך code swap. אין צורך ב-SQL splitter כללי. `IF NOT EXISTS` לבדו אינו
מספיק: PostgreSQL אינו מבטיח שה-index בעל אותו שם זהה להגדרה, ו-CIC כושל יכול להשאיר INVALID.
Option 3 בסדר שהוצע אסור — ה-`ON CONFLICT` הנוכחי ייכשל `42P10` לפני שקיים index תקף; הסדר הוא
schema → CIC → catalog/smoke verification → code, לעולם לא code → index.

---

# עדכון מחייב — 2026-08-18: D-08, D-09 ו-D-10

הפרק הזה הוא ההכרעה העדכנית ביותר, והוא **גובר** על נוסחי D-08 ו-D-09 שמעליו בכל מקום שבו
המצב השתנה. הבדיקה בוצעה מול `fix/night-audit-2026-08-15` ב-HEAD ‏`ef651a9`, מול קובצי הריצה,
ה-ledger, לוגי הבדיקות והמימוש בפועל. החלקים הישנים נשארים במסמך רק כ-audit trail.

בזמן כתיבת ההכרעה הופיעו במקביל שינויים לא-מחויבים חדשים ב-worktree. הם אינם משנים את קובצי
D-09/D-10 שנבדקו כאן, אבל worktree מלוכלך אינו בסיס verdict. לכן כל `currentDisposition` וכל
טענת "fixed" חייבים freshness check נוסף על ה-commit הסופי; הבסיס השחזור של ההכרעה הזאת נשאר
`ef651a9` בלבד.

הכרעה תמציתית:

- **D-08:** מאשר adversarial verification, אבל רק בתהליך `cluster-first`, לפי סיכון, עם verifier
  עצמאי. דוחה גם sweep שטוח של 301 כותרות וגם self-verification של המממש.
- **D-09:** אפשרויות 1–3 כבר אינן רלוונטיות ל-062. מאשר את הסריאליזציה על שורת ה-job ללא
  אינדקס על `timeline_sections`, אך המימוש הנוכחי עדיין אינו merge-ready בגלל שני פגמי correctness
  ו-validation/rollout חסרים.
- **D-10:** דוחה העלאה גלובלית של `testTimeout`. בוחר באפשרות רביעית: לתקן את תזמור העומס,
  להגביל workers ולהשאיר את גבול חמש השניות.
- **D-06:** להעביר לארכיון; זה correction log ללא החלטה פתוחה.

אין כאן אישור ל-deploy, לשינוי production, להרצת remediation או למיזוג.

## D-08 — cluster-first adversarial verification, לא sweep ולא אימות עצמי

### העובדות המתוקנות

הקורפוס עדיין מכיל 330 findings ייחודיים: 5 P0,‏ 62 P1,‏ 182 P2 ו-81 P3. קובץ
`VERIFIED.jsonl` מכיל 33 שורות, אך רק 29 IDs מתאימים לקורפוס: 28 `CONFIRMED` ואחד `REFUTED`.
`database-002` מופיע בו פעמיים, ושלושת `orch-*` הם verdicts ללא finding מקור. לכן הכיסוי
האדברסרי הוא 29/330 בלבד — 8.8%.

301 הלא-מאומתים אינם "כל ה-P2/P3". הם כוללים 5 P0,‏ 33 P1,‏ 182 P2 ו-81 P3. חמשת קובצי
Anam/b-roll נוספו לאחר יצירת `VERIFIED.jsonl` והוסיפו 41 ממצאים שאף אחד מהם לא אומת. למעשה,
קובץ האימות נוצר בזמן ש-18 מתוך 25 קובצי domains עוד השתנו; אין completion barrier, ובריצה חסרים
`MANIFEST.md`,‏ `REPORT.md` ו-`FIX_PLAN.md`.

ה-ledger החדש כן תיקן חלק מן הבעיה: יש בו 330 שורות ו-330 IDs ייחודיים, ו-`correctedSeverity`
כבר מלא — 22 הורדות P1→P2 והורדה אחת P1→P3. לכן הטענה הקודמת במסמך שהשדה ריק כבר אינה נכונה.

אבל ה-ledger עדיין אינו backlog סמכותי:

- הוא untracked, נמצא רק ב-worktree הזמני, ועודכן לפני שבעת ה-commits האחרונים;
- כל 312 הרשומות שאינן billing עדיין מסומנות `OPEN`, לרבות דברים שכבר תוקנו בין `e4146a7`
  ל-`ef651a9`;
- בכל 330 הרשומות ריקים `rootCauseId`,‏ `aliases`,‏ `baseCommit`,‏ `reachability`,‏
  `guardsChecked`,‏ `repro`,‏ `implCommit`,‏ `tests`,‏ `verifierIdentity` ו-`residualRisk`;
- סימון ה-scope נעשה לפי domain במקום לפי משמעות. לפחות `database-007`,‏ `database-012`,‏
  `performance-006`,‏ `security-017`,‏ `test-quality-002` ו-`test-quality-003` הם findings של
  billing/Stripe שנותרו `OPEN` בניגוד להוראת ה-scope.

לאחר תיקון דליפת ה-scope יהיו לפחות 24 findings מחוץ לתחום. ה-backlog הלא-מאומת שבתוך התחום הוא
281: 5 P0,‏ 32 P1,‏ 168 P2 ו-76 P3.

### סדר העבודה המאושר

1. **שחזר את גבול הריצה ביושר.** צור snapshot משוחזר ומסומן ככזה עם audit commit, hashes ורשימת
   קבצים. את חמשת הקבצים המאוחרים רשום כ-supplement; אל תייצר בדיעבד `MANIFEST` שמתחזה ל-artifact
   שנוצר בזמן הריצה.
2. **תקן את ה-ledger לפני מימוש חדש.** סווג billing לפי משמעות, לא רק domain, ומפה את שבעת
   ה-commits הקיימים ל-findings/clusters. אל תסמן `ALREADY_FIXED` עד ש-verifier עצמאי בדק את
   ה-commit ואת המבחן שלו.
3. **אמת תחילה את שכבת הביקורת.** 19 ממצאי fleet הם P0/P1; כל חמשת ה-P0 שייכים ל-audit controls,
   לא לזמינות המוצר, ולכן יתויגו `AUDIT_BLOCKER`. אמת באופן עצמאי את `e4146a7`; commit ומבחנים של
   המממש אינם adversarial verification.
4. **אחר כך אמת את 18 ה-P1 המוצריים שבתוך ה-scope.** ‏`test-quality-002` הוא Stripe ונשאר מחוץ
   לתחום הנוכחי. אין להתחיל sweep נמוך יותר לפני שה-P1 הרלוונטיים הוכרעו.
5. **קבץ לפני אימות, לא אחריו.** צור `rootCauseId` קנוני ושמור את כל הכותרות כ-aliases/impact
   facets. אמת פעם אחת את סיבת השורש וכל מסלולי ההשפעה שלה. הפוך את הסדר הנוכחי ב-orchestrator,
   שמאמת לפני dedup. דוגמאות ברורות: `database-007`/`performance-006` וכן
   `broll-player-001`/`frontend-viewer-001`.
6. **את 244 ה-P2/P3 הלא-מאומתים שב-scope אל תעביר sweep שטוח.** תעדף P2 לפי production
   reachability, data integrity, security ו-blast radius. אמת P3 רק on-touch או כחלק מבאץ' שינוי
   מתוכנן.

כל batch יהיה קטן ומוצמד ל-commit. ה-verifier יהיה שונה גם מהמאתר וגם מהמממש, ויכתוב מראש מה היה
מפריך את הטענה. שמור בנפרד `historicalVerdict` על snapshot קפוא ו-`currentDisposition` על commit
יעד מדויק. ככל שניתן נדרש מבחן אדום לפני תיקון וירוק אחריו, ואז בדיקת post-implementation נפרדת.

תנאי הסיום המכניים הם:

- `raw_unique = verdicted + not_verified`;
- אין verdict כפול או orphan;
- אין implementation בלי cluster מאומת;
- finding שתוקן אינו נשאר `OPEN`;
- לכל verdict יש `baseCommit` ו-`verifierIdentity`, ולכל תיקון יש `implCommit` וראיית test.

אחרי הטמעת התהליך הזה D-08 היא החלטה **שנענתה** ויכולה לעבור לארכיון; ה-work items שנוצרים ממנה
שייכים ל-tracker, לא למסמך החלטות בעלים.

## D-09 — הארכיטקטורה אושרה, אבל המימוש עדיין דורש שני תיקוני correctness

הנחת השאלה המקורית כבר התיישנה. ב-`ef651a9` מיגרציה 062 אינה מוסיפה עוד עמודה או אינדקס ל-
`timeline_sections`, ואינה יוצרת `idx_vgj_inflight`. ה-finalization נועל את שורת
`video_generation_jobs` ב-`SELECT ... FOR UPDATE`, בודק את fencing token ומסיים ב-update שמותנה גם
ב-`section_id IS NULL`. זהו ה-invariant הנכון: finalization אוטומטי אחד מפרסם לכל היותר section
אחד. הכנסת אותו asset ידנית שוב היא פעולה נתמכת ולכן uniqueness גלובלי על section היה שגוי.

גם תיקון חיבור המיגרציות כבר קיים: `migrate.ts` מעדיף `MIGRATION_DATABASE_URL`, משתמש ב-
`QUEUE_DATABASE_URL` כ-fallback בטוח ומסרב ל-transaction pooler. אין לפתוח שוב את ה-runner עבור
`CREATE INDEX CONCURRENTLY` בגלל D-09.

### שני תיקונים שחוסמים merge

1. **מסלול adoption אינו מסיים את ה-job.** ב-`video.generate.ts:381-383`, כאשר לשורה הנעולה כבר
   יש `section_id`, הקוד מחזיר אותו מתוך הטרנזקציה לפני ה-terminal UPDATE. הפונקציה מחזירה בזיכרון
   `{status:'ready'}`, אך שורת ה-DB נשארת `transcoding`/in-flight ו-startup recovery יוכל לתבוע אותה
   שוב לעד. העבר גם existing-section וגם new-section דרך terminal UPDATE fenced. במקרה existing,
   התנאי צריך לכלול `id + token + section_id = locked.section_id`; עדכן `status='ready'`,‏
   `finished_at` ו-`updated_at` באותה טרנזקציה.

   הבדיקה ב-`videoGenerateIdempotency.test.ts:362-388` שותלת את המצב אך בודקת רק linkage. הוסף
   assertions שה-DB באמת `ready`, ש-`finished_at` קיים וש-redelivery אינה מפעילה שוב provider,
   download או transcode. שנה גם את שם הבדיקה: section אמיתי מלפני 062 שנכתב לפני עדכון ה-job היה
   orphan **לא מקושר**, ואי אפשר לזהותו אוטומטית; המצב הנוכחי הוא linked predecessor, לא pre-062
   orphan.
2. **`lock_timeout` דולף ל-session.** ב-`062:40` כתוב `SET lock_timeout='3s'`. ה-runner משתמש באותו
   connection למיגרציות הבאות, ולכן הערך נשאר גם אחרי COMMIT. שנה ל-
   `SET LOCAL lock_timeout='3s'` והקשח את הבדיקה כך שתבחין בין `SET` ל-`SET LOCAL`.

נקה גם תיעוד שממשיך לטעון שיש index שכבר הוסר: `schema.ts:664-677`,‏
`migration062.test.ts:5-10,87-95`,‏ `video.generate.ts:82,343-346`,‏ `pgBossDriver.ts:59-69`
והבדיקה המקבילה שלו. הערות שקריות על guarantee שכבר אינה קיימת הן סיכון תחזוקה, לא cosmetic diff.

### validation ו-schema history לפני deploy

65 הבדיקות הממוקדות הנוכחיות ירוקות, אבל הן משתמשות ב-PGlite/session יחיד. מבחן
`Promise.all` אינו מוכיח המתנה על row lock בין שני sessions אמיתיים. הוסף PostgreSQL integration
עם שני connections ו-barriers, שמוכיח finalization מתחרה וגם serialization של advisory lock.

062 נכתבה מחדש לאחר שכבר הייתה commit קודמת. לפני שינוי נוסף או rollout, הרץ בכל DB מתמשך דוח
read-only על `schema_migrations` עבור 060/062 ובדוק ב-catalog אם קיימים
`timeline_sections.generation_job_id`,‏ `uniq_timeline_sections_generation_job`,‏
`idx_vgj_inflight` ועמודות ה-lease. אם נמצא checksum של 062 הישנה (`3c95affc…`) או אחד ה-artifacts
הישנים — עצור. אין לשנות checksum/tracker או להעמיד פנים שהקובץ החדש רץ; יש להוסיף מיגרציית
reconciliation קדימה. גם checksum ריק אינו מספיק בלי catalog check.

הוסף את `MIGRATION_DATABASE_URL` ל-`.env.example`, ל-deploy README ול-runbook; הקוד וה-tests לבדם
אינם מגדירים את סביבת ה-VM.

### מיגרציה 060

אזהרת ה-lock היחידה שנותרה היא `project_exports_fingerprint_idx` ב-060. חיפוש runtime מראה שאין
שום query שמסנן לפי `plan_fingerprint`; הקוד כותב אותו ומאמת אותו לאחר טעינת export לפי ה-PK.

- אם 060 לא הוחלה באף DB מתמשך, הסר את האינדקס וההערה השגויה לפני היישום הראשון, הוסף
  `SET LOCAL lock_timeout`, והוסף אותו בעתיד רק כאשר query אמיתי ו-`EXPLAIN` יצדיקו אותו.
- אם 060 הוחלה במקום כלשהו, אל תשכתב migration history. השאר את הקובץ וה-index כפי שהם; ה-lock
  כבר קרה באותה סביבה. בסביבה אחרת שטרם הוחלה בה המיגרציה, מדוד גודל פיזי, write rate וטרנזקציות
  ארוכות ותאם חלון. אין סף קסם של 100k שורות.

### rollout ראשון

ה-deploy מריץ migrations בזמן שה-worker הישן עדיין חי, ועבודת b-roll עשויה להימשך כ-25 דקות מול
graceful stop של 30 שניות. לכן גם לאחר תיקון הקוד נדרש rollout מתואם:

1. הפעל `generation_paused` ותאם שההשבתה היא גלובלית לכל generation;
2. נקז `queued | enhancing | submitting | generating | downloading | transcoding`;
3. סווג ידנית כל `submitting` ללא `external_task_id` ואל תשלח שוב פעולה שייתכן שכבר חויבה;
4. הרץ את schema/catalog census ואמת migration URL ב-session/direct mode;
5. deploy כשה-pause נשאר פעיל, בצע health check, ואז בטל pause והריץ b-roll smoke אחד מבוקר;
6. אמת job במצב `ready`,‏ `section_id` תקין ו-section יחיד עבור ה-video החדש.

זהו runbook בלבד; אינו אישור לפעולת production. אחרי שני תיקוני ה-correctness, ה-PostgreSQL proof,
ה-schema preflight ותיעוד ה-rollout, D-09 יכולה להיסגר ולהפוך ל-work item תפעולי.

## D-10 — לא להעלות timeout; לתקן oversubscription ולשמור על fail-fast

אני דוחה את Option 1 ואת ההצדקה שלה. אם חייבים לבחור רק מן הרשימה, Option 3 עדיפה; ההחלטה הנכונה
היא Option 4: **השאר `testTimeout` ב-5 שניות, סדר את תזמור הבדיקות והגבל workers.**

### למה הנחת הבעיה אינה מוכחת

קובץ 42 ה-failures נוצר מ-pipeline שסינן את Vitest דרך `grep`. הוא שמר את שמות ה-`FAIL` אך זרק
את גופי השגיאות וה-stacks, וללא `pipefail` אף החזיר exit 0. לכן אין ראיה שכל 42 היו timeout.
בריצה ממוקדת מאוחרת הופיע גם timeout עליון וגם `TestingLibraryElementError`; העלאת timeout גלובלי
גם אינה משנה timeout פנימי מפורש של `waitFor` — לדוגמה 2 שניות ב-
`passiveSimSurfaces.test.tsx:76-79,168-170`.

גם הטענה שכל הכשלים היו polling שגויה. הרשימה כוללת מבחני render/layout ו-state פשוטים כגון
`export-video.test.tsx:142-150`,‏ `editorLeaseNavigation.test.tsx:183`,‏
`editorSimResidency.test.tsx:312` ו-`sectionEditorServedPreview.test.tsx:152`.

הראיה מצביעה על starvation: באירוע נמדדו load 49,‏ 63 תהליכי Vitest וחמש ריצות מלאות על host של
10 ליבות. Vitest מריץ קבצים במקביל ומאפשר להגביל את מספר ה-workers באמצעות `maxWorkers`
([Vitest parallelism](https://v4.vitest.dev/guide/parallelism),
[maxWorkers](https://main.vitest.dev/config/maxworkers)); במקביל `pnpm -r` מפעיל כברירת מחדל עד
ארבע משימות workspace יחד ([pnpm recursive](https://pnpm.io/cli/recursive#--workspace-concurrency)).
כמה full gates עצמאיים מכפילים שוב את שני הרבדים האלה.

המדידה הנקייה על `ef651a9` אינה מצביעה על מבחן client ארוך:

- ברירת המחדל: 1,405/1,405 ירוקים ב-6.55 שניות; המבחן האיטי ביותר 198ms;
- `maxWorkers=2`: ‏1,405/1,405 ב-15.70 שניות;
- `maxWorkers=1`: ‏1,405/1,405 ב-30.80 שניות.

חמש שניות הן כבר יותר מפי 25 מן המקסימום הנמדד. ה-backend אינו תקדים מתאים: ה-60 שניות שלו נועדו
לאתחול WASM Postgres והרצת עשרות migrations. מבחני ה-client משתמשים ב-fake timers ואינם צריכים
לקבל דקה כדי להסתיר scheduler starvation. גם שער CI אמיתי כבר עבר עם timeout של חמש שניות.

### היישום המאושר

1. רק ה-root/orchestrator מריץ full `pnpm release:verify` אחד לאחר שילוב כל ה-streams. reviewers
   מריצים specs שבבעלותם; אין להריץ כמה full gates במקביל על אותו host.
2. השאר `testTimeout` לא מוגדר ב-`client-web/vitest.config.ts`, כלומר 5,000ms ב-Node לפי
   [תיעוד Vitest](https://main.vitest.dev/config/testtimeout).
3. הוסף ל-client cap תלוי-CPU על file workers:

   ```ts
   Math.max(1, Math.min(2, Math.floor(availableParallelism() / 2)))
   ```

   ייבא `availableParallelism` מ-`node:os` ותעד את המדידה. כך host של 10 ליבות יורד מ-9 workers
   ל-2, ו-runner של 2 ליבות נשאר על worker אחד במקום שה-hardcoded `2` יגדיל עליו עומס.
4. כל ריצת gate שומרת פלט מלא ו-exit status באמצעות `set -o pipefail` ו-`tee`; מסכמים את הלוג רק
   אחרי שהתהליך הסתיים. אסור להשתמש שוב ב-`grep` חי כהוכחת verdict.
5. אם לאחר תזמור יחיד ומוגבל נשאר מבחן שבאמת חורג, תקן polling/fake timers או תן timeout מקומי
   ומדוד לאותו integration test. העלאה גלובלית תישקל רק על סמך p99 אמיתי תחת סביבת CI מאושרת;
   אין להעתיק 60 שניות מה-backend.

### קריטריון קבלה

- עשר ריצות client ישירות רצופות עוברות עם 5 שניות וללא retry;
- stress של חמש ריצות client מקבילות עם ה-cap עובר, כך שסך client workers אינו עולה על 10 ב-host
  הזה;
- full `release:verify` יחיד עובר עם output לא מסונן ו-exit code אמיתי;
- PR CI עובר;
- probe מכוון של Promise שלא מסתיימת עדיין נכשל סביב חמש שניות, כהוכחה שלא החלשנו את liveness
  gate.

לאחר היישום והקבלה, D-10 נענתה ויש להעבירה לארכיון. אין צורך להמתין לתשובת בעלים נוספת.
