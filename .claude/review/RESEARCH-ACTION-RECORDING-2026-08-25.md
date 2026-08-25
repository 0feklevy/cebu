# מחקר: הקלטת Actions ובחירה ויזואלית — במקום תיאור מילולי ו-LLM כבד

**תאריך:** 2026-08-25 · **סטטוס:** דוח מחקר, טרם הוחלט על בנייה
**הבקשה:** הקלטת אינטראקציות היוצר עם סימולציה (קליקים, סליידרים לאורך זמן) → תיעוד טכני נטו →
גשר מהודר מכנית, ‏LLM רק לליטוש ממוקד. ‏+ בחירת אלמנטים בקליק (ירוק=להציג, אדום=להסתיר)
במקום ה-checkboxes. ‏+ גזירה אוטומטית של הכפתורים המוצגים ממה שנלחץ בהקלטה.
**דרישה קשיחה:** ‏open-source ברישוי מסחרי בלבד (MIT / Apache-2.0 / BSD / ISC).

---

## 1. השורה התחתונה

**הפיצ'ר בנוי כמעט כולו על תשתית שכבר קיימת אצלנו.** שלוש התגליות המרכזיות:

1. **אין חסם CSP.** ה-CSP של `/sim-public/*` מתיר `'unsafe-inline'`, ‏`'self'` ו-`https:` על
   `script-src` — אפשר להזריק מקליט inline או כקובץ same-origin (כמו ש-`bridge.js` כבר נטען).

2. **מחולל ה-selectors כבר כתוב, בדוק, ורץ בפרודקשן — אצלנו.** ה-rAF gate מכיל את
   `controlSelector(el)` ‏(SimulationService.ts:541: ‏`#id` → `[name=…]` → נתיב מבני
   `nth-of-type` מעוגן ב-`#id` הקרוב), ‏`controlKind(el)` ‏(:419) ו-`controlLabel(el)` ‏(:479,
   סולם 13 שלבים). **הבוחר הירוק/אדום לא צריך ספריית selectors חיצונית** — קליק בתוך ה-iframe
   מריץ את שלוש הפונקציות הקיימות ומחזיר בדיוק את השלישייה `{selector, kind, label}` שכל
   צינור ה-`ui_controls` הקיים כבר יודע לעכל. **אפס שינויי backend לפיצ'ר הבחירה.**

3. **חיסכון הטוקנים אמיתי ומדיד:** יצירת גשר היום שולחת עד **‏~200KB מקור + ‏~15KB הוראות
   ≈ ‏50-55 אלף טוקנים** לכל יצירה (תקציב `SOURCE_BUDGETS`, פרומפט 12,268 תווים, כללי-הקלטה
   2.6KB, מניפסט). מהדר-הקלטה מכני = **אפס LLM** במקרה הבסיסי; ליטוש ממוקד = הסקריפט המהודר
   בלבד (~2-5KB). זה גם מייתר את הצורך של המשתמש לתאר במילים מה הוא רוצה.

---

## 2. ארכיטקטורה מומלצת — "המקליט בשער"

### 2.1 איפה חי המקליט: בתוך ה-rAF gate, חמוש ב-postMessage

הברירה הייתה בין שלוש דרכי-אספקה, והמיפוי הכריע:

| אפשרות | בעיה |
|---|---|
| ‏`?record=1` בזמן-הגשה | ‏`/sim-public/*` **ציבורי לחלוטין** ("no auth", לא קורא query כלל) — כל צופה היה מקבל את המקליט; אין session לשעֵר עליו |
| ‏CDN בתוך החבילה | ‏`validateCaptureCompatibility` **דוחה** סקריפט CDN ב-entry שמור (captureCompatibility.ts:78) |
| **בתוך ה-rAF gate, חמוש רק ב-`startRecording` מההורה** | ✅ ‏`e.source !== window.parent` + ‏`frame-ancestors` כבר מגבילים מי יכול לחמש; אפס ענף-הגשה חדש; ‏bump של `RAF_GATE_VERSION` (כיום 4) מפיץ לכל סימולציה בפרסום הבא |

הפרוטוקול החי הוא **v2** ‏(client-web/lib/sim/protocol.ts — רשימת קבועים שטוחה; ‏v3 רדום,
"no stored package uses yet"). התבנית להעתקה מילה-במילה: `requestRuntimeControls`
‏(SectionEditor.tsx:1423-1448) — listener עצמאי בעורך עם בדיקת `e.source`, ‏timeout, ובקשת
`{type:'listSimControls'}`. המקליט מוסיף `startRecording` / `recordingEvent` (זרם) /
`stopRecording` באותה צורה בדיוק. **אין מגבלת גודל להודעות** (הקאפ של 8KB חל רק על מסלול
ה-GET הישן; ה-POST stream של העורך uncapped — ‏sections.controller.ts:1266).

### 2.2 שני מצבי ההקלטה שביקשת — ואיך הם נופלים מאותו לוג

- **"‏screenshot של קונפיגורציות" (סטטי):** בעת `stopRecording` השער דוגם את **ערכי כל
  ה-controls** (value / checked / aria-valuenow) — צילום-מצב טכני של הקונפיגורציה. אם לא
  נרשמו אירועים עם חותמות-זמן שונות ⇒ המהדר פולט גוף "קבע הכול ב-t=0".
- **"הקלטה עוקבת-שינויים" (דינמי):** לוג אירועים `{t, selector, action, value}` — קליק,
  ‏input, ‏drag. "אחרי 4 שניות הסליידר זז" הופך ל-`at(4000, () => setVal('#speed', 0.9))`.
- ההבחנה בין המצבים **אוטומטית**: לוג עם אירוע אחד בכל selector וללא פיזור-זמן = סטטי;
  אחרת = דינמי. היוצר לא בוחר מצב.

### 2.3 המהדר: לוג → גוף-גשר, אפס LLM

תבנית הפלט (עומדת בכל אילוצי `validateGeneratedBridge`, גם אם עוקפים אותו):

```js
// compiled from a recording — <n> events over <T>ms
var _t = [];
var at = function (ms, fn) { _t.push(setTimeout(fn, ms)); };
var el = function (s) { return document.querySelector(s); };      // querySelector, לא getElementById
var setVal = function (s, v) { var e = el(s); if (!e) return;
  e.value = v; e.dispatchEvent(new Event('input', {bubbles:true}));
  e.dispatchEvent(new Event('change', {bubbles:true})); };
var press = function (s) { var e = el(s); if (e) e.click(); };

at(0,    function(){ setVal('#speed', 0.5); });
at(4000, function(){ setVal('#speed', 0.9); });
at(5200, function(){ press('#pluck-btn'); });

return function cleanup() { _t.forEach(clearTimeout); };           // חובה: cleanup + clearTimeout
```

כללי המהדר (מהמיפוי): ‏`querySelector` ולא `getElementById` (עוקף אזהרת unknown-ID);
כל `setTimeout` מזווג ל-`clearTimeout` ב-cleanup (אזהרת-זיווג); בלי `fetch`/storage
(רגקסים פטאליים); הגוף לא מכיל את מחרוזת סוגר-הסקשן. **מסלול הפרסום:**
`applySavedBridgeBody` → ‏`uploadSectionBridge` — אותו מסלול שכבר בנינו ל-load-bridge,
עם CAS activation ו-persist טרנזקציוני בחינם. מריצים `validateGeneratedBridge` בעצמנו כביטוח.

### 2.4 הבוחר ירוק/אדום — בלי ספרייה, בלי backend

- קליק בודד = ירוק (show), דאבל-קליק = אדום (hide). ‏(‏dblclick תמיד יורה click קודם —
  ‏debounce ~250ms סטנדרטי; חלופה: קליק=ירוק, קליק-על-ירוק=אדום, קליק-על-אדום=נקה —
  בלי דיליי בכלל. **מומלץ החלופה** — טוגל תלת-מצבי בקליקים בודדים.)
- ההדגשה: שכבת-overlay ממוקמת-אבסולוטית שעוקבת `getBoundingClientRect` — לא נוגעים
  ב-DOM של הסימולציה עצמה.
- הפלט: אותו `SimUiSelection {controls, show, hide}` בדיוק; העורך מחליף רק את
  `renderRow` ‏(SectionEditor.tsx:2107-2160) ואת מקור ה-`uiUnchecked`. הסניטציה
  (`SIM_UI_UNSAFE_SELECTOR_RE`), הנרמול, ‏`canReuse` — הכול נשאר זהה.

### 2.5 הגזירה האוטומטית שביקשת (ה"אקסטרה")

כש-minimal-UI + auto-script פעילים אך רק ההקלטה קיימת: ‏`show` = כל selector שמופיע בלוג
ההקלטה ∪ העוגנים שהמהדר משתמש בהם; ‏`hide` = יתר ה-controls מהסריקה הקיימת. **שורת קוד
של חיתוך קבוצות** — הסימון הירוק/אדום קורה מעצמו, בדיוק כפי שתיארת.

---

## 3. ‏Open-source — מנועי הקלטה (רישוי אומת מול npm/קבצי LICENSE, לא מהנחות)

### 3.1 ‏rrweb — מנוע הלכידה. פסק-דין: **להשתמש** (חבילת record-only)

- **רישיון: ‏MIT מאומת** (‏`rrweb@2.1.1`, ‏`@rrweb/record`, ‏`rrweb-snapshot` — כולם). אין
  open-core; הדבר המסחרי היחיד הוא ענן-אירוח אופציונלי שלא רלוונטי לנו.
- **גודל נמדד (לא משיווק): ‏`@rrweb/record` = ‏23.9KB min+gz.** ‏2.67M הורדות/שבוע לחבילה הראשית.
- ‏record-only עובד **בלי** ה-replayer בכלל; `record({emit})` מחזיר פונקציית-עצירה — הקלטה
  ניתנת להדלקה/כיבוי בזמן-ריצה. בדיוק מודל החימוש-ב-postMessage שבחרנו.

**סכמת אירועים — הדוגמאות האמיתיות:**

קליק:
```json
{ "type": 3, "data": { "source": 2, "type": 2, "id": 47, "x": 312.5, "y": 198.0 },
  "timestamp": 1756100000123 }
```
שינוי סליידר (אירוע לכל `input` — כלומר **עקומת ערך-מול-זמן מלאה**, בדיוק "הסליידר ב-t=4s"):
```json
{ "type": 3, "data": { "source": 5, "id": 52, "text": "64", "userTriggered": true },
  "timestamp": 1756100004012 }
```

**עובדה מבנית קריטית למהדר:** ‏rrweb רושם **‏node-id, לא selector**. ה-id מפנה לעץ
ה-FullSnapshot — כל ה-DOM מסודרר עם id מספרי לכל צומת. פתרון id→selector הוא מכני מול
ה-snapshot של אותה הקלטה. **וה-FullSnapshot עצמו הוא בדיוק "צילום-המסך הטכני של
הקונפיגורציה"** שביקשת — ‏`takeFullSnapshot()` בנקודות-מפתח.

**קנבס/WebGL — הבעיה הגדולה שלהם היא לא-בעיה אצלנו בתכנון:** ‏`recordCanvas: false` +
‏`.rr-block` על הקנבס. הסימולציה **מציירת את עצמה מחדש** בזמן replay — אנחנו צריכים רק את
אירועי-הקלט. זה עוקף את החולשה הגדולה ביותר של הקלטת-סשן קלאסית.

**ידיות מותאמות (div שהוא כפתור):** נלכדות כאירועי-מצביע + **מוטציות-תכונה עם חותמת-זמן**
(‏`aria-valuenow`/`data-value`) — ערוץ ערכים סמנטי בחינם. כדאי לעגן בהנחיות-הסימולציה שלנו
שכל ווידג'ט משקף מצב לתכונה. ובנוסף: ‏`record.addCustomEvent('sim-state', …)` מאפשר לגשר
הקיים להזרים שינויי-מצב לאותו זרם עם אותן חותמות.

### 3.2 ‏@puppeteer/replay — ה-IR הסטנדרטי. פסק-דין: **לאמץ את הסכמה**

- **רישיון: ‏Apache-2.0 מאומת, אפס תלויות-ריצה.**
- ‏`UserFlow{steps[]}` עם `click`/`doubleClick`/`change`/`hover`… ‏selectors עם נסיגות
  (‏`aria/`, ‏`#id`, ‏`xpath/`), מיעון iframes.
- **הפער: אין חותמות-זמן בסכימה** — רק סדר. מרחיבים בשדה `timing` משלנו (נקודת-הרחבה
  מוכרת). התמורה: ‏DevTools Recorder של כרום מייצא **בדיוק את הפורמט הזה** — יוצר יוכל אפילו
  להקליט ב-DevTools ולייבא; וכל ממירי `@cypress/chrome-recorder` (‏MIT) הם דוגמאות-עבודה
  ל-stringify מעל הסכמה.

### 3.3 מה נפסל, ולמה

| פרויקט | רישיון | פסק-דין |
|---|---|---|
| ‏Playwright codegen | Apache-2.0 | המקליט צמוד לשרת Playwright — לא embeddable; חומר-עיון בלבד |
| ‏headless-recorder | MIT | **בארכיון** מ-2022; דפוס בלבד |
| ‏DeploySentinel Recorder | Apache-2.0 | הקרוב ביותר לקיים — להעתיק קוד (קיפול-רצפים), לא להיתלות |
| ‏OpenReplay tracker | ‏npm=MIT אבל **מונורפו AGPLv3 + ‏ee מסחרי**; פרוטוקול בינארי קנייני | **להימנע** |
| ‏highlight.run | Apache-2.0 | ‏SDK שלם קשור ל-SaaS שלהם; ‏rrweb מתחת; עיון בלבד |
| ‏PostHog rrweb fork | MIT | חלופת-גיבוי ל-record אם ה-upstream יפגר |

**אין ממיר rrweb→script מתוחזק בקוד פתוח — הפער הזה הוא בדיוק המהדר הקטן-דטרמיניסטי
שנכתוב** (פתרון id→selector מול ה-snapshot, קיפול רצפים, צירוף חותמות-זמן). מכני לחלוטין.

## 4. ‏Open-source — בוחרי אלמנטים ומחוללי selectors (רישוי אומת מול tarballs)

### 4.1 מחוללי selectors — והמסקנה המפתיעה

| ספרייה | רישיון | גודל | מצב |
|---|---|---|---|
| **המחולל שלנו** (‏`controlSelector`, ‏gate) | שלנו | 0 | **רץ בפרודקשן, מיושר לסניטציה** |
| ‏css-selector-generator | MIT | ‏4.5KB gz | מתוחזק פעיל (גרסה מ-2026-08!) |
| ‏@medv/finder | MIT | ‏**2.4KB gz** | ‏PostHog מטמיעים בדיוק אותו ב-toolbar שלהם |
| ‏unique-selector | MIT | 1.8KB | לא מתוחזק — לדלג |
| ‏optimal-select | MIT | 3.7KB | מת (2017) — לדלג |
| ‏Playwright selectorGenerator | Apache-2.0 | — | פולט תחביר Playwright, לא CSS; לא ניתן לחילוץ מעשי |
| ‏DevTools `cssPath()` | BSD-3 | — | פועל על מודל DevTools, לא DOM חי; דפוס-עיון |

**ההמלצה: להתחיל מהמחולל שלנו** — הוא כבר פולט בדיוק את השלישייה `{selector, kind, label}`
שהצינור מעכל, מיושר ל-`SIM_UI_UNSAFE_SELECTOR_RE`, ורץ על כל סימולציה חיה. **אפס תלות חדשה.**
אם יידרש כיסוי עמוק יותר (‏shadow DOM, ‏blacklist לקלאסים מגובבים) — ‏css-selector-generator
הוא השדרוג, עם אזהרה אחת: הוא משתמש ב-`CSS.escape()` שיכול לפלוט `\` — חובה blacklist על
שמות לא-מילוליים או שהסניטייזר שלנו יפסול פלט תקין.

⚠️ ‏intro.js הוא **AGPL** — לא לגעת (מציינים כי זו ספריית-הטיולים שמושכת ידיים).

### 4.2 ה-overlay — ‏~150 שורות משלנו, עם שלד מ-pick-dom-element (‏MIT)

הדפוס הקנוני (הסוכן קרא את המקור המלא): ‏div יחיד ב-`position:fixed`, ‏z-index מקסימלי,
בתוך **‏shadow root** (ש-CSS של הסימולציה לא יעצב אותו), ‏`pointer-events:auto` שבולע את
הקליק לפני שהסימולציה רואה אותו; טיק rAF שמהבהב `pointer-events:none` → ‏`elementFromPoint`
→ חזרה, וממקם את המסגרת. מאזינים ב-capture על `mousemove/mousedown/mouseup/click/dblclick/
contextmenu/keydown` עם `preventDefault` + ‏`stopImmediatePropagation` — אחרת הסימולציה
מקבלת חצי מהמחווה. מקרי-קצה שחייבים: רקורסיה לתוך shadow roots ו-iframes פנימיים
(עם תרגום קואורדינטות), טיפוס-אבות מ-עלי SVG ומקנבס מסך-מלא, ‏Escape ליציאה.

### 4.3 סימוני ירוק/אדום קבועים — התובנה הכי אלגנטית של המחקר

**‏stylesheet מוזרק שממופתח ב-selector עצמו:**
```css
#pluck-btn { outline: 3px solid #16a34a !important; outline-offset: -2px; }  /* ירוק */
.debug-panel { outline: 3px solid #dc2626 !important; }                       /* אדום */
```
הסימון שורד **כל** רינדור-מחדש של הסימולציה מעצם היותו CSS — אין מעקב-צמתים בכלל. ובונוס
כפול: **סימון שנעלם = ‏selector שנשבר** — ולידציה חיה בחינם של יציבות ה-selector, לפני
שהוא בכלל נשמר. ‏PostHog משתמשים בשכבת-divs רק להדגשת-ריחוף החולפת; לסימון הקבוע הגישה
הזו זמינה רק לנו כי הסימונים שלנו *הם* selectors.

### 4.4 קליק-בודד מול דאבל-קליק — לוותר על הדאבל

‏`dblclick` תמיד יורה שני `click` לפניו; ההפרדה הסטנדרטית עולה ‏~250ms של תחושת-מוות לכל
קליק. **ההמלצה (שני הסוכנים התלכדו אליה בנפרד): קליק בודד שמחזר none→ירוק→אדום→none.**
אפס-השהיה, מחווה אחת, הכי בר-גילוי. אם בכל זאת דאבל: לצבוע ירוק אופטימית מיד ולהפוך
לאדום אם הדאבל מגיע — אין השהיה מורגשת.

---

## 5. תוכנית בנייה — ארבעה שלבים עצמאיים, כל אחד שמיש לבדו

### שלב A — הבוחר הירוק/אדום (הקטן ביותר, ערך מיידי)
- ‏gate: מטפל `pickElement` חדש (בקשת-בחירה מההורה ⇒ ‏overlay; קליק ⇒ ‏postMessage עם
  `{selector, kind, label}` מהפונקציות **הקיימות**). ‏bump ל-`RAF_GATE_VERSION` 5.
- עורך: החלפת ה-checkboxes ‏(SectionEditor.tsx:2107-2160) בכפתור "בחר על המסך" + לולאת
  ההודעות (העתק של `requestRuntimeControls`).
- **אפס שינויי backend. אפס תלויות חדשות. אפס LLM.**

### שלב B — ההקלטה
- ‏vendor של `@rrweb/record` (‏MIT, ‏24KB gz) **כקובץ בתוך ה-gate** (לא CDN — ולידטור
  ה-capture דוחה CDN ב-entry שמור), חמוש רק ב-`startRecording` מ-`window.parent`.
- ‏`recordCanvas: false` + ‏`.rr-block` על קנבס; ‏`userTriggeredOnInput: true`;
  ‏custom events מהגשר לאותו זרם.
- אירועים זורמים לעורך ב-postMessage (אין מגבלת גודל במסלול), נשמרים כלוג.
- ‏UI: כפתור ⏺ בפריוויו של Edit Section; עצירה דוגמת snapshot-קונפיגורציה סופי.

### שלב C — המהדר (הלב)
- ‏id→selector מול ה-FullSnapshot (מכני); קיפול רצפים (גרירת-סליידר → ‏setVal-ים
  בנקודות-זמן; לחיצות → ‏press); פליטת גוף-גשר לפי התבנית בסעיף 2.3.
- ‏IR: ‏UserFlow של ‏@puppeteer/replay + שדה `timing` — תאימות-חינם ל-DevTools Recorder.
- פרסום דרך `applySavedBridgeBody` (המסלול שכבר בנוי!) + הרצת `validateGeneratedBridge`
  כביטוח עצמי.
- **הגזירה האוטומטית**: ‏`show` = ‏selectors שנגעו בהקלטה; ‏`hide` = השאר מהסריקה. שורת חיתוך.

### שלב D — ליטוש LLM ממוקד (אופציונלי)
- קלט: הסקריפט המהודר (~2-5KB) + בקשת-ליטוש חופשית ("תעשה את המעברים חלקים").
- **לא** קבצי-המקור. חיסכון: ‏~50-55K טוקנים ← ‏~1-2K, רק כשמבקשים ליטוש בכלל.

### טבלת רישוי מסוכמת (הכול אומת מול npm/LICENSE בפועל)
| רכיב | רישיון | שימוש |
|---|---|---|
| ‏@rrweb/record | ‏MIT ✅ | מנוע לכידה, ‏vendored |
| ‏rrweb-snapshot | ‏MIT ✅ | ‏snapshot-קונפיגורציה |
| ‏@puppeteer/replay (סכמה) | ‏Apache-2.0 ✅ | ‏IR + ‏interop |
| ‏pick-dom-element | ‏MIT ✅ | שלד ה-overlay (‏vendored, ‏~150 שורות) |
| ‏css-selector-generator | ‏MIT ✅ | שדרוג עתידי בלבד |
| ‏OpenReplay / intro.js | ‏AGPL ❌ | **לא לגעת** |

### מה עוד נחסך מלבד טוקנים
- תיאור מילולי של המשתמש — מתייתר (ההקלטה היא התיאור).
- ‏`contextTruncated` — נעלם (אין קונטקסט לחתוך).
- אי-דטרמיניזם של LLM — הסקריפט המהודר זהה לכל הקלטה זהה.
- וה-IR הסטנדרטי פותח דלת: יוצר מקליט זרימה ב-DevTools של כרום ומייבא.
