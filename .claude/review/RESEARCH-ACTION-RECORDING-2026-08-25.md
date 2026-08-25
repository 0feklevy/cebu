# מחקר: הקלטת Actions ובחירה ויזואלית — במקום תיאור מילולי ו-LLM כבד

**תאריך:** 2026-08-25 · **סטטוס:** סקירת עומק הושלמה — GO מותנה לבוחר, NO-GO
לארכיטקטורת ההקלטה המקורית עד סגירת החוזים והחסמים המפורטים בהמשך
**הבקשה:** הקלטת אינטראקציות היוצר עם סימולציה (קליקים, סליידרים לאורך זמן) → תיעוד טכני נטו →
גשר מהודר מכנית, ‏LLM רק לליטוש ממוקד. ‏+ בחירת אלמנטים בקליק (ירוק=להציג, אדום=להסתיר)
במקום ה-checkboxes. ‏+ גזירה אוטומטית של הכפתורים המוצגים ממה שנלחץ בהקלטה.
**דרישה קשיחה:** ‏open-source ברישוי מסחרי בלבד (MIT / Apache-2.0 / BSD / ISC).

---

> **כלל קריאה לאחר הביקורת:** סעיפים 1–5 מתעדים את הצעת המחקר המקורית לצורכי עקיבות.
> סעיפים 6–11 הם ההכרעה המתוקנת בעברית וגוברים על כל טענה סותרת. סעיפים 12–17 הם
> הגרסה האנגלית המלאה והמקבילה — לא תרגום של הנחות שכבר נפסלו.

## 1. השורה התחתונה

> **ארכיון ההצעה המקורית / Original proposal archive:** סעיפים 1–5 נשמרו כראיית מחקר,
> אך אינם תוכנית implementation. לצורך בנייה יש להשתמש רק בסעיפים 6–11 או בגרסה האנגלית
> המלאה בסעיפים 12–17.

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

---

## 6. ביקורת עומק והכרעה ארכיטקטונית

### 6.1 החלטה

הכיוון המוצרי נכון, אך הארכיטקטורה בסעיפים 1–5 אינה בטוחה או מדויקת מספיק לבנייה כפי
שהיא. ההחלטה המתוקנת:

| רכיב | החלטה | תנאי |
|---|---|---|
| בחירה ויזואלית של controls | **GO מותנה** | Locator חדש, tri-state מוגדר, ערוץ authoring גרסאי ו-list fallback |
| מקליט rrweb בתוך כל package | **NO-GO ל-MVP** | להתחיל במקליט סמנטי קטן; rrweb נשאר ניסוי עתידי בלבד |
| קומפילציה בדפדפן ל-JavaScript | **NO-GO** | הדפדפן שולח IR טיפוסי; רק השרת מקמפל |
| UserFlow של Puppeteer כ-IR קנוני | **NO-GO** | פורמט פנימי ActionRecordingV1; UserFlow הוא adapter עתידי |
| replay באמצעות setTimeout לכל event | **NO-GO** | executor קבוע, scheduler יחיד ושעון מסונכרן לציר הזמן |
| static/final-state capture | **GO** | baseline + target state מוחלט ל-controls בבעלות ה-plan, לא snapshot סופי לבדו |
| generic click, canvas ו-custom widgets | **מחוץ ל-V1** | רק דרך adapter שמגדיר apply, restore ו-seek |
| LLM לליטוש | **אופציונלי מאוחר** | משנה PlanPatch מוגבל בלבד; לעולם לא JavaScript חופשי |

הערך המרכזי של ההצעה נשמר: במקום לשלוח עשרות אלפי טוקנים וקבצי מקור, היוצר מייצר
תוכנית פעולות קטנה, ניתנת לבדיקה ודטרמיניסטית. השינוי הוא שהלוג חייב להיות סמנטי, בטוח
ומסונכרן למוצר — לא session replay גולמי.

### 6.2 תיקוני דיוק מחייבים להצעה המקורית

| הטענה המקורית | ממצא הביקורת | ניסוח מתוקן |
|---|---|---|
| אין חסם CSP | נכון טכנית להזרקה, אך CSP אינו הרשאה או אימות | אפשר להזריק bootstrap same-origin; השרת נשאר גבול האמון |
| ה-selector הקיים יציב ובדוק | הוא מחבר id/name ללא escaping או uniqueness | אפשר למחזר את רעיון הסריקה, לא את חוזה הזהות |
| אפס backend לבוחר | נכון רק לבוחר בינארי זמני | tri-state מתמשך דורש שינוי shared types, validation ו-sim_meta, גם בלי עמודת DB חדשה |
| v3 רדום | runtime v3 כבר מוטמע בפרסומים חדשים | modern path אינו נגיש לרוב החבילות; יש לבצע capability detection |
| אין מגבלת גודל להודעות | הטענה מערבבת HTTP עם postMessage | נדרשים caps, batching, backpressure ו-terminal acknowledgement |
| static/dynamic מזוהה אוטומטית | מספר timestamps אינו חושף intent | המערכת יכולה להמליץ; היוצר בוחר Apply final state או Replay timing |
| כל setTimeout מנוקה ולכן בטוח | ניקוי timers אינו pause, seek או state restore | scheduler יחיד + ExecutionPolicy מפורשת + lifecycle contract |
| החזרת control ל-baseline משחזרת את הסימולציה | DOM value אינו rewind של physics/canvas/React state | reload-document כברירת מחדל; adapter מוכח ל-restore/seek |
| applySavedBridgeBody הוא מסלול מוכן | זו מתודת service שסומכת על caller, לא API לעורך | נדרש endpoint מאומת שמקבל IR בלבד |
| validateGeneratedBridge הוא ביטוח runtime | הוא validator סטטי; הקוד מסמן runtime validation כעתידי | נדרשים plan validation, fresh-document replay proof ו-canary |
| FullSnapshot ממפה node id ל-selector | nodes מאוחרים תלויים בשרשרת mutations לפי סדר | אין להשתמש ב-FullSnapshot כ-configuration snapshot |
| UserFlow + timing נותן תאימות חינם | UserFlow מכוון ל-browser automation וה-timing המותאם אינו תקן | לבנות adapters מפורשים לאחר MVP |
| ארבעת השלבים עצמאיים | B ללא C הוא לוג בלבד; C תלוי ב-B | לבנות vertical slice שימושי מקצה לקצה |
| 50–55K טוקנים נחסכים בכל פעם | זה upper bound של המסלול הנוכחי, לא עלות קבועה | למדוד input, cached input ו-output בפועל לפני הבטחת חיסכון |

### 6.3 ראיות מהמימוש הקיים

- ‏SimulationService.ts:541–562 בונה selector מ-id, מ-name או מנתיב nth-of-type בלי
  CSS escaping ובלי להוכיח התאמה יחידה. קבוצת radio בעלת name משותף היא דוגמת כשל ישירה.
- ‏SimUiControls.ts:56–79 פוסל רק קבוצת תווים צרה; הוא אינו parser של CSS ואינו מוכיח
  שה-selector מצביע על control אחד.
- ‏SectionEditor.tsx:1423–1448 מממש בקשה חד-פעמית קטנה עם timeout. הוא אינו transport
  לזרם ארוך, ואסור להעתיק אותו כלשונו להקלטה.
- ‏SimTransport.ts והפרוטוקול ב-shared/src/sim/runtimeProtocol.ts כבר מממשים MessageChannel,
  זהות document, sequence ו-tombstones. זה הדפוס שעל authoring transport למחזר.
- ‏SimulationService.ts:1518–1652 עוצר ב-pauseScript רק handles שנרשמו במפורש דרך
  simDemoTimer. ה-timeouts שבתבנית המקורית אינם כאלה, וגם restart שלהם אינו שומר remaining delay.
- ‏useProjectPlayer.ts:4166–4170 מניח ש-stopScript מחזיר document resident למצב pristine.
  click כללי שמשנה model, canvas או WebGL מפר את ההנחה הזאת.
- ‏SimStartParams כולל היום simpleUi, autoScript ו-hideSelectors בלבד. הוא אינו נושא
  section offset, clock epoch או playback rate, ולכן replay שמתחיל ב-seek אינו מסונכרן.
- ‏sections.controller.ts:955–960 אינו מקבל recording IR. המסלול היחיד אל
  applySavedBridgeBody עובר כיום דרך bridgePresets.controller.ts לאחר בדיקת preset.
- ‏SimulationService.ts:1987–1988 מציין במפורש ש-runtime validation עדיין עתידי.
- ‏uploadSectionBridge מספק staging, revision CAS ו-transaction hook שימושיים, אך פעולת
  publication עדיין קוראת, מאמתת ומפרסמת package; היא אינה חינמית ואינה idempotency.
- ‏sim-public.controller.ts כבר מזריק SIM_BOOT_SNIPPET בזמן serve גם ל-revisions קיימים.
  זו נקודת הזרקה טובה יותר ל-authoring bootstrap קטן מאשר bump שמגיע רק בפרסום הבא.
- ‏revisionIdentity.ts מגדיר draft/uploading/validating/failed כלא-ציבוריים, אך
  canary_passed ציבורי במפורש. לכן proof חדש אינו רשאי להשתמש בסטטוס הזה או ב-/sim-public
  לפני activation בלי שינוי state machine.
- ‏bridge.js וקבצי revision פעיל מוגשים מ-/sim-public ללא authentication. כל value שמוטמע
  בתוכנית שפורסמה הוא מידע ציבורי בפועל.

### 6.4 מחקר חיצוני והשלכותיו

- המדריך הרשמי של rrweb מראה ש-maskAllInputs הוא false כברירת מחדל, recordCanvas הוא
  false, ו-cross-origin iframe דורש הזרקת rrweb גם לכל child frame. לכן פרטיות וכיסוי
  iframe אינם מתקבלים אוטומטית:
  [rrweb guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md).
- תיעוד האירועים של rrweb מגדיר FullSnapshot ואחריו IncrementalSnapshot מצטברים; mutations
  בונים זה על זה וחייבים להישמר בסדר. זו הוכחה ש-node-id מול snapshot יחיד אינו compiler
  סמנטי:
  [rrweb events](https://github.com/rrweb-io/rrweb/blob/main/docs/events.md).
- @puppeteer/replay מתואר רשמית ככלי replay/stringify להקלטות Chrome DevTools Recorder,
  לא כחוזה timing של מוצר:
  [Puppeteer Replay](https://github.com/puppeteer/replay/blob/main/README.md).
- Chrome Recorder מריץ flow מהר ככל האפשר כברירת מחדל; שינוי replay speed הוא כלי debug.
  לכן timing פרטי אינו interoperability חינם:
  [Chrome Recorder reference](https://developer.chrome.com/docs/devtools/recorder/reference).
- תקן HTML ממליץ לחכות להודעת readiness ממסמך iframe חדש ומסביר ש-targetOrigin לא תואם
  גורם להודעה להיזרק. זה תומך ב-handshake ו-origin מדויק:
  [HTML cross-document messaging](https://html.spec.whatwg.org/dev/web-messaging.html).
- תקן DOM קובע שאירוע שנשלח ב-dispatchEvent, וגם click שנוצר דרך element.click, אינו trusted.
  לכן פעולות שתלויות ב-user activation אינן ניתנות לשחזור כללי:
  [DOM Standard](https://dom.spec.whatwg.org/).
- תקן CSSOM מגדיר CSS.escape; שרשור id גולמי אחרי סימן # אינו serialization תקין:
  [CSSOM](https://www.w3.org/TR/cssom-1/).
- React מתעד ש-controlled input מוחזר לערך ה-state וש-checkbox/radio משתמשים ב-checked ולא
  ב-value. direct DOM assignment לבדו אינו חוזה replay:
  [React input](https://react.dev/reference/react-dom/components/input).

בבדיקת npm מיום הדוח, @rrweb/record היה בגרסה 2.1.1 וברישיון MIT, עם שלוש תלויות runtime
וגודל unpacked של כ-2.22MB; bundle הדפדפן הממוזער שנמדד היה כ-77.9KB וכ-23.9KB gzip.
@puppeteer/replay היה בגרסה 4.0.2, Apache-2.0 וכ-194KB unpacked ללא runtime dependencies
מדווחות. הנתונים האלה משתנים עם הזמן; יש לנעול גרסה ולשמור LICENSE/NOTICE/SBOM אם אחת
התלויות אכן נכנסת למוצר. ההמלצה ל-V1 היא אפס תלויות חדשות.

---

## 7. ארכיטקטורת היעד

### 7.1 עקרונות

1. **Data, לא code:** הלקוח יוצר ActionRecordingV1 בלבד. הוא אינו שולח body או JavaScript.
2. **שרת כמקור סמכות:** הרשאות, source fence, limits, canonicalization, compile ו-publication
   נעשים בשרת.
3. **Executor קבוע:** הגשר מכיל interpreter מערכת גרסאי ותוכנית מקודדת כ-data; אין פונקציית
   setTimeout שנוצרת לכל event.
4. **שעון מוצר עם semantics כנים:** בזמן playback רציף, timed replay עוקב אחרי media clock.
   V1 גנרי מתחיל מחדש אחרי seek; סנכרון מדויק לנקודת seek מותר רק ל-adapter שמוכיח seek.
5. **פעולות טיפוסיות ומדיניות reset מפורשת:** גם slider מוחלט יכול לשנות פיזיקה פנימית
   שאינה הפיכה. לכן ברירת המחדל היא reload-document ביציאה; restore in-place דורש adapter.
6. **יכולת authoring נפרדת מ-runtime:** protocolVersion של authoring, runtime protocol
   version ו-gate version הם שלושה מספרים שונים.
7. **אין silent no-op:** locator חסר, עמום, stale או unsupported הוא diagnostic חוסם.
8. **Preview לפני publication:** Stop מסיים capture; Apply בלבד יוצר revision.

### 7.2 תרשים הזרימה

~~~mermaid
flowchart LR
    E[SectionEditor] --> C[SimAuthoringClient]
    C <-->|MessageChannel + session/document/seq| B[Serve-time Authoring Bootstrap]
    B --> R[Semantic Recorder + Visual Picker]
    R --> N[Normalize + Review + Local Replay]
    N -->|ActionRecordingV1 only| A[Authenticated Apply Endpoint]
    A --> V[Source Fence + Schema + Limits]
    V --> K[Deterministic Plan Compiler]
    K --> S[Stage Candidate Revision]
    S --> P[Fresh-document Replay Proof]
    P --> U[Revision CAS Activation]
    U --> T[Atomic Section + Provenance Update]
    T --> X[Fixed ActionPlan Runtime]
    X <-->|Clock sync: play pause seek rate| M[Project Player / Export Clock]
~~~

### 7.3 מיקום ה-bootstrap

הבחירה המתוקנת היא bootstrap קטן שמוזרק בזמן serve ל-entry HTML דרך אותו מנגנון שבו
sim-public.controller.ts כבר מזריק את SIM_BOOT_SNIPPET:

- revisions קיימים מקבלים capability בלי rebuild ובלי שינוי bytes מאוחסנים;
- אין צורך לחכות ל-RAF_GATE_VERSION הבא;
- ה-bootstrap רדום: listener יחיד ו-capability response בלבד עד handshake מהעורך;
- קוד capture סמנטי קטן יכול להיות inline, או להיטען same-origin רק אחרי ARM אם מדידת
  bundle מצדיקה זאת;
- parent origins מורשים מוטמעים מהגדרת browserOrigins, בנפרד מהפרוטוקול שנדרש ל-export;
- viewer רגיל לעולם אינו פותח authoring channel.

אין להוסיף את recorder לתוך SectionEditor.tsx או את compiler לתוך SimulationService.ts.
חלוקה מוצעת:

| שכבה | קובץ/מודול חדש |
|---|---|
| shared contracts | shared/src/sim/authoringProtocol.ts |
| IR ו-Zod schema | shared/src/sim/actionRecording.ts |
| serve-time bootstrap | backend-api/src/services/simulation/SimAuthoringBootstrap.ts |
| client transport/FSM | client-web/lib/sim/SimAuthoringClient.ts |
| React orchestration | client-web/hooks/useSimAuthoring.ts |
| API | backend-api/src/controllers/v1/actionRecordings.controller.ts |
| validation/canonicalization | backend-api/src/services/simulation/ActionRecordingService.ts |
| deterministic compiler | backend-api/src/services/simulation/ActionPlanCompiler.ts |
| fixed runtime source | backend-api/src/services/simulation/ActionPlanRuntime.ts |

SimulationService יקבל מתודת orchestration צרה בשם applyRecordedActionPlan. יש לפצל או
להרחיב את publication primitive כך שתחשוף stage → proof callback → CAS activate, תוך
מחזור הלוגיקה של uploadSectionBridge. הוא לא יכיל את ה-parser, normalizer וה-executor.

### 7.4 זרימת authoring מלאה

1. העורך בודק capability ו-source identity של ה-iframe.
2. כניסה ל-authoring יוצרת iframe/document חדש מול revision מדויק, מבטלת את ה-script
   הקיים, ממתינה ל-ready ול-frame אמיתי, וסורקת baseline.
3. היוצר בוחר אחת משתי כוונות מפורשות:
   - **Apply final state:** נשמר diff בין baseline ל-final; הוא מוחל סינכרונית בכל activation.
   - **Replay timing:** נשמר timeline; המערכת מציעה trim, אך היוצר מאשר timing.
4. START יוצר session חדש, countdown קצר ו-time origin באמצעות performance.now.
5. ה-bootstrap מקליט רק אירועי user trusted של controls נתמכים, מנרמל ל-control root
   ושולח batches bounded.
6. STOP מחזיר terminal summary עם count, bytes, dropped/coalesced ו-final state.
7. העורך מציג review: פעולות, controls, unsupported events, אורך, leading/trailing silence
   ו-ui visibility suggestion.
8. Preview רץ מול document חדש. הוא חייב לעבור פעמיים ברצף ולהחזיר אותו final state.
9. Apply שולח IR לשרת. שינוי revision בין record ל-Apply מחזיר 409 ולא מפרסם.
10. לאחר validation ו-replay proof השרת מפרסם revision פעם אחת ומעדכן provenance אטומית.

Recording replacement מתחיל מ-package pristine ואינו נערם על body שרירותי שנוצר בעבר.
עריכת recording קיים טוענת את ActionPlan השמור; החלפת bridge ישן שנוצר ב-LLM מוצגת
במפורש כ-replacement. Hybrid של arbitrary legacy body והקלטה אינו חלק מ-V1.

### 7.5 state machine בעורך

~~~text
idle
  → connecting
  → picking ↔ interacting
  → ready
  → recording
  → stopping
  → reviewing
  → previewing
  → applying
  → applied

כל state יכול לעבור ל-error או cancelled.
navigation, iframe load, preview epoch change, simulation change ו-unmount מבטלים session.
רק state אחד מתוך picking / recording / previewing / applying יכול להיות פעיל.
~~~

---

## 8. החוזים הטכניים

### 8.1 ActionRecordingV1

ה-IR הפנימי חייב להיות קטן, גרסאי, canonical ובלתי תלוי ב-rrweb או Puppeteer. חוזה
playback הוא discriminated union כדי שלא יהיה אפשר ליצור צירוף בלתי אפשרי כמו
section-synchronous ללא adapter:

~~~ts
type AdapterCapabilityV1 = "capture" | "apply" | "digest" | "restore" | "seek";

interface AdapterRefV1 {
  id: string;
  apiVersion: number;
  implementationHash: string;
  actionSchemaVersion: number;
  stateSchemaVersion: number;
  capabilities: AdapterCapabilityV1[];
}

type ReloadResetV1 = { kind: "reload-document" };
type AdapterResetV1 = { kind: "adapter-restore"; adapter: AdapterRefV1 };

type ExecutionPolicyV1 =
  | {
      kind: "final-state";
      reset: ReloadResetV1 | AdapterResetV1;
    }
  | {
      kind: "timeline-entry-relative";
      seek: { kind: "restart-on-seek" };
      reset: ReloadResetV1;
    }
  | {
      kind: "timeline-section-synchronous";
      seek: { kind: "adapter-seek"; adapter: AdapterRefV1 };
      reset: ReloadResetV1 | AdapterResetV1;
    };

interface FreshnessContractV1 {
  revisionId: string;
  packageHash: string;
  entryPath: string;
  environmentHash: string;
  baselineControlHash: string;
  crossDocumentState: "none" | "platform-namespaced-reset";
  determinism:
    | { kind: "not-claimed" }
    | { kind: "seeded"; seed: string; capabilityHash: string };
}

interface ExpectedEvidenceV1 {
  sourceRevisionId: string;
  sourcePackageHash: string;
  environmentHash: string;
  checkpoints: Array<{
    atMs: number;
    controlStateHash: string;
    adapterStateDigest?: string;
  }>;
}

interface ActionRecordingV1 {
  schemaVersion: 1;
  recorderVersion: string;
  recordingId: string;
  source: {
    simulationId: string;
    revisionId: string;
    packageHash: string;
    documentId: string;
    entryPath: string;
  };
  section: {
    sectionId: string;
    durationMs: number;
    execution: ExecutionPolicyV1;
  };
  environment: {
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    seed?: string;
  };
  baseline: ControlStateV1[];
  actions: ActionV1[];
  finalState: ControlStateV1[];
  freshness: FreshnessContractV1;
  expectedEvidence: ExpectedEvidenceV1;
  uiIntent: UiIntentV1;
  stats: {
    rawEvents: number;
    normalizedActions: number;
    coalesced: number;
    dropped: number;
    byteLength: number;
  };
}
~~~

אם section-synchronous משתמש גם ב-adapter-seek וגם ב-adapter-restore, שני ה-refs חייבים
להיות בעלי אותו id ו-implementationHash. ה-compiler מקבע את ExecutionPolicyV1 בתוך ה-plan;
ה-parent אינו רשאי לבחור reset או seek בזמן ריצה. capabilities מסודרים קנונית, וכל method
נדרש רק אם ה-capability המתאים מוצהר.

כל timestamp הוא integer של milliseconds, יחסי ל-time origin מונוטוני. הסדר הקנוני הוא
atMs ואז seq; duplicate seq, זמן שלילי, NaN, Infinity, ערך לא-קנוני, ערך מחוץ לטווח או
final state שסותר את action האחרון נדחים. normalizer הלקוח רשאי לבצע clamp ו-quantization
לפני יצירת ה-IR; השרת אינו "מתקן" IR בשקט.

ה-hashes מופרדים בכוונה: requestHash מכסה את פקודת ה-HTTP הסמכותית; recordingHash מכסה את
ההקלטה הסמנטית המנורמלת בלי recordingId, documentId, stats או פרטי transport; planHash
מכסה ActionPlan canonical יחד עם sourcePackageHash, compilerVersion ו-executorVersion;
artifactHash מכסה manifest קנוני של ה-bytes המדויקים שפורסמו. sourcePackageHash הוא
SHA-256 של רשימת path, byte hash ו-size, ממוינת לפי path, לפני שינוי ה-bridge. bridgeHash
נשאר hash נפרד של bridge.js כאשר נדרש diagnostic נקודתי.

ה-IR אינו מכיל DOM snapshot, HTML, CSS text, innerText מלא, screenshot, arbitrary object,
function או custom-event payload. projectId ו-userId נגזרים מה-route ומה-session בשרת, לא
מה-payload.

### 8.2 LocatorV1

~~~ts
interface LocatorV1 {
  id: string;
  root: "document";
  candidates: Array<{
    strategy: "sim-control" | "id" | "name" | "structural-css";
    value: string;
  }>;
  fingerprint: {
    tag: string;
    inputType?: string;
    role?: string;
    kind: "range" | "number" | "checkbox" | "radio" | "select" | "button";
    min?: number;
    max?: number;
    step?: number;
  };
}
~~~

סדר היצירה:

1. data-sim-control ייחודי — חוזה מומלץ לסימולציות חדשות.
2. id שעבר CSS.escape ומתאים בדיוק לאלמנט אחד.
3. name שעבר string serialization ורק אם הוא ייחודי; name של radio group אינו locator.
4. נתיב structural-css מעוגן ב-anchor בטוח, כמוצא אחרון.
5. אם אין candidate יחיד — האלמנט unsupported, לא ניחוש.

בכל שלב capture, preview, server canary ו-runtime נדרשים:

- parse בלי exception;
- querySelectorAll מחזיר בדיוק התאמה אחת;
- ההתאמה היא אותו target בזמן capture;
- fingerprint תואם;
- miss או ambiguity מפיקים error עם locator id ו-step index.

V1 תומך ב-light DOM של ה-entry document בלבד. Shadow DOM, nested iframe, cross-origin
iframe, XPath ו-ARIA selector הם capability נפרד עם root-chain resolver; עד שהוא קיים הם
נכשלים במפורש. אין להעביר locator כזה ל-document.querySelector.

חוזי הליבה אינם נשארים ככינויים פתוחים. ב-V1 הם unions סגורים:

~~~ts
type DecimalStringV1 = string; // /^-?(0|[1-9]\d*)(\.\d+)?$/; no exponent or -0

type ControlValueV1 =
  | { type: "decimal"; value: DecimalStringV1 }
  | { type: "boolean"; value: boolean }
  | { type: "enum"; value: string };

interface ControlStateV1 {
  locatorId: string;
  controlKind: "range" | "number" | "checkbox" | "radio" | "select";
  value: ControlValueV1;
}

type ActionV1 =
  | { kind: "set-range" | "set-number"; locatorId: string; value: DecimalStringV1; atMs: number; seq: number }
  | { kind: "set-checked"; locatorId: string; value: boolean; atMs: number; seq: number }
  | { kind: "select-radio" | "select-option"; locatorId: string; value: string; atMs: number; seq: number }
  | { kind: "adapter-action"; locatorId: string; adapter: AdapterRefV1; payload: JsonValue; atMs: number; seq: number };

interface UiIntentV1 {
  derivationMode: "off" | "recording";
  scan: {
    scanId: string;
    sourceRevisionId: string;
    truncated: boolean;
    locatorIds: string[];
  };
  base: { showLocatorIds: string[]; hideLocatorIds: string[] };
  manualMarks: Array<{ locatorId: string; mark: "keep" | "hide" }>;
}

type ActionPlanV1 = {
  schemaVersion: 1;
  compilerVersion: string;
  executorVersion: string;
  sourcePackageHash: string;
  durationMs: number;
  execution: ExecutionPolicyV1;
  freshness: FreshnessContractV1;
  locators: LocatorV1[];
  baseline: ControlStateV1[];
  expectedEvidence: ExpectedEvidenceV1;
  uiIntent: UiIntentV1;
} & (
  | { mode: "final-state"; targetState: ControlStateV1[] }
  | { mode: "timeline"; actions: ActionV1[]; targetState: ControlStateV1[] }
);

interface PlanDiagnosticV1 {
  code: "locator_missing" | "locator_ambiguous" | "fingerprint_mismatch" |
    "baseline_mismatch" | "action_failed" | "deadline_exceeded" | "stale_epoch";
  severity: "warning" | "error";
  phase: "capture" | "preview" | "compile" | "proof" | "runtime";
  actionIndex?: number;
  locatorId?: string;
}
~~~

DecimalStringV1 עובר parse מדויק, bounds ו-step validation לפי fingerprint. רשימות ו-locators
מסודרים לפי כלל קנוני; ids כפולים, keys לא מוכרים ו-payload שחורג מ-schema של adapter נדחים.
ב-final-state ה-plan שומר baseline hash ו-target state מוחלט לכל control שבבעלותו, לא diff
חלקי בלבד. לפני apply/reveal ה-runtime משווה baseline; mismatch גורר reset יחיד ואז כשל גלוי.
גרסת major לא מוכרת נדחית. migration, אם יידרש, היא פונקציית שרת גרסאית וטהורה שמפיקה V1
canonical חדש ומחייבת compile ו-proof מחדש — אין migration שקט בזמן runtime.

### 8.3 פעולות נתמכות

| control / action | Capture | Replay ב-V1 | Restore | הערה |
|---|---:|---:|---:|---|
| range / number | כן | setRange מוחלט | reload document או adapter | input לאורך המסלול, change יחיד ב-commit |
| checkbox | כן | setChecked מוחלט | reload document או adapter | אין toggle; כותבים state רצוי |
| radio | כן | selectRadio מוחלט | reload document או adapter | locator מזהה option, לא name משותף |
| select | כן | selectOption מוחלט | reload document או adapter | value חייב להיות option קיים |
| generic text / textarea | לא ב-V1 | לא | — | opt-in עתידי נפרד בלבד; artifact ציבורי |
| password / file / hidden | חסום | חסום | — | אסור להגיע ללוג |
| generic button click | נרשם כ-touched בלבד | חסום | לא כללי | מותר רק דרך adapter מוכח |
| pointer drag / canvas / WebGL | diagnostic בלבד | חסום | לא כללי | normalized coordinates אינם state semantics |
| ARIA/custom widget | diagnostic בלבד | חסום | לא כללי | נדרש adapter סמנטי |

ה-executor משתמש ב-adapter לפי סוג control, כולל native property setter כאשר נדרש,
ומשגר בדיוק את event semantics של אותו control. הוא אינו משגר input וגם change בכל
keyframe. כל אירוע סינתטי הוא untrusted; אם מצב ה-control הנצפה אינו מתכנס בבדיקת replay,
ה-control נכשל. מצב פנימי אינו נחשב מוכח בלי adapter — ואין fallback שקט ל-click.

חשוב: החזרת value או checked ל-baseline מוכיחה רק את מצב ה-DOM. היא אינה מחזירה חלקיקים,
אינטגרטור פיזיקלי, random state, canvas או state פנימי של React לזמן הקודם. לכן
ActionPlanV1 משתמש ב-ExecutionPolicyV1; כל AdapterRef נושא implementation hash וגרסאות
API/action/state. זהות adapter היא חלק מה-plan גם אם reset עצמו הוא reload-document.

reload-document הוא ברירת המחדל של כל plan גנרי. ה-player מבטל מיד את ה-scheduler, שומר
את ה-frame המכוסה בזמן ה-fade, ואז טוען document חדש לפני re-entry. documentId חדש הוא
תנאי הכרחי אך לא הוכחת pristine; FreshnessContractV1 וה-baseline hash הם ה-precondition.
רק adapter שעבר restore proof רשאי לבקש cleanup in-place.

חוזה הרחבה עתידי:

~~~ts
interface AdapterCallContextV1 {
  signal: AbortSignal;
  deadlineMs: number;
  epoch: number;
}

interface SimRecordingAdapterV1 {
  ref: AdapterRefV1;
  describeTarget(element: Element): AdapterCapability | null;
  capture(event: Event): TypedAdapterAction | null;
  snapshot?(ctx: AdapterCallContextV1): Promise<{ state: JsonValue; stateDigest: string }>;
  apply?(action: TypedAdapterAction, ctx: AdapterCallContextV1): Promise<{ stateDigest?: string }>;
  restore?(input: { baseline: JsonValue }, ctx: AdapterCallContextV1): Promise<{ stateDigest: string }>;
  seek?(
    input: { actions: TypedAdapterAction[]; targetOffsetMs: number; baseline: JsonValue },
    ctx: AdapterCallContextV1
  ): Promise<{ stateDigest: string }>;
}
~~~

ה-adapter חייב להצהיר schema ו-limits. arbitrary callback או arbitrary JavaScript אינם
נכנסים ל-IR. Generic click נשאר חסום גם כאשר reset הוא reload-document, מפני ש-reload
פותר cleanup אך לא מוכיח שה-click הסינתטי הפעיל את המשמעות הנכונה. הוא נכנס רק אחרי
שיש apply ודיגסט סמנטיים מוכחים; restore ו-seek נדרשים רק למדיניות שמצהירה עליהם. seek הוא
מוחלט ואידמפוטנטי מה-baseline ל-targetOffsetMs, קדימה ואחורה. כל פעולה אסינכרונית מקבלת
AbortSignal ו-deadline; timeout מבטל אותה, ותוצאה שמגיעה אחרי ביטול או epoch חדש נזרקת.

ל-validation סמנטי מתקבלים ב-V1 רק adapters בבעלות הפלטפורמה, חתומים/allowlisted ומקובעים
ל-implementationHash. digest שמוחזר רק מקוד ה-package הוא package-declared evidence ואינו
מספיק ל-runtimeValidated. expectedEvidence נקשר ל-source revision, environment ול-checkpoint
שנלכד בזמן authoring, והשרת מחשב אותו מחדש עם ה-adapter המאושר. oracle חזותי עצמאי הוא
יכולת עתידית נפרדת; אם תתווסף, screenshot גולמי יהיה ephemeral וממוסך, וה-artifact ישמור
רק hash, tolerance וחוזה environment — לא תמונה או pixels בלוגים.

### 8.4 נרמול timeline

- input רציף נאסף לכל locator עד 20Hz לכל היותר; בכל חלון 50ms נשמר הערך האחרון.
- נשמרים תמיד sample ראשון, sample סופי ונקודת שינוי כיוון של range.
- רצפים זהים סמוכים עוברים dedupe; same timestamp נשמר לפי seq.
- final-state mode מתעלם מהמרווחים; ה-review יכול להציג diff, אך ה-plan מקודד target state
  מוחלט לכל control שבבעלותו יחד עם baseline hash.
- timeline mode שומר leading/trailing trim מפורש. אם ההקלטה ארוכה מה-section אין clipping
  שקט: היוצר מקצר, משנה section או מבטל.
- ההבחנה בין המצבים היא בחירת משתמש. heuristic יכול להציג המלצה בלבד.

לפני יצירת ה-IR, ערכים מספריים עוברים clamp מול min/max ו-quantization מול step. השרת
בודק שהם כבר canonical ותואמים ל-final state; הוא דוחה חריגה במקום לשנות משמעות.
אלגוריתם הנרמול וה-serialization הם pure functions עם golden tests, כך שאותו IR
ו-compilerVersion מייצרים אותם bytes ואת אותו hash.

### 8.5 clock, pause, resume ו-seek

יש להפריד בין שתי רמות יכולת; אחרת הדוח מבטיח seek שאי אפשר לממש על simulation שרירותי:

1. **entry-relative, ברירת מחדל ב-V1:** בזמן playback רציף, ההקלטה מסונכרנת להתקדמות
   המדיה מאז activation. pause, resume ו-rate נתמכים. seek או re-entry יוצרים document
   pristine חדש ומתחילים את ההקלטה מ-t=0. זו מגבלה מוצרית גלויה, אך semantics אמינים.
2. **section-synchronous, adapter-only:** כניסה או seek ל-offset באמצע section דורשים
   adapter שמממש seek ומחזיר stateDigest צפוי. בלי adapter אסור להעמיד פנים שה-write
   האחרון לכל slider משחזר את מצב הפיזיקה שנצבר עד אותו זמן.

ה-player הוא סמכות הזמן ושולח envelope גרסאי:

~~~ts
interface TimelineClockSyncV1 {
  epoch: number;
  seq: number;
  sectionOffsetMs: number;
  activationOriginOffsetMs: number;
  running: boolean;
  playbackRate: number;
}
~~~

- נוסחת entry-relative היא
  `clamp(sectionOffsetMs - activationOriginOffsetMs, 0, recordingDurationMs)`; נוסחת
  section-synchronous היא `clamp(sectionOffsetMs, 0, recordingDurationMs)`. final-state אינו
  צורך clock.
- ה-position הראשוני נשלח עם PREPARE_SECTION ב-v3 או startScript ב-v2, לפני ACK ו-reveal.
  sync נוסף נשלח ב-play, pause, seek, rate change ו-periodic drift correction.
- parent ו-child אינם מניחים של-performance.now שלהם אותו origin. בעת receipt ה-child דוגם
  את השעון המקומי ומתקדם מה-media position שהתקבל לפי rate. timestamp של parent, אם יישמר
  ל-telemetry, לעולם אינו מופחת ישירות משעון child בלי calibration מוכח.
- epoch עולה רק ב-seek, re-entry, reset או discontinuity אמיתי; seq עולה בכל הודעה. epoch/seq
  ישנים, offsets/rates לא finite או מחוץ למדיניות המוצר, ו-position אחורי בלי epoch חדש נדחים.
  בתוך epoch cursor הפעולות לעולם אינו נסוג. drift קטן עובר slew עד threshold מדוד; drift
  גדול קדימה עושה snap ומרוקן due actions פעם אחת; correction קטן אינו reload ואינו replay.
- ה-clock הוא activation-scoped אך אינו presentation policy, אינו חלק
  מ-SimPresentationConfig ואינו נכנס ל-configHash. reset/seek נגזרים רק מ-ExecutionPolicyV1
  המקובעת; הודעה שמנסה לבחור policy אחר היא protocol error.
- scheduler יחיד מחזיק cursor ו-handle אחד. הוא מחשב logical time, מרוקן due steps ואז
  מתזמן רק את ה-deadline הבא. ב-v3 הוא משתמש ב-ManagedScopeHandle; ב-v2 ה-handle היחיד
  נרשם במפורש כ-automation ולא נבלע בין timers של מנוע הסימולציה.
- pause מבטל את ה-handle בלי לקדם logical time; resume משתמש ב-remaining logical delay.
- ב-restart-on-seek, discontinuity מבטל את activation ומתחיל reset generation אחת. ב-adapter
  seek, ה-parent מחזיק cover עד CLOCK_APPLIED עם epoch ו-digest מתאים. timeout או digest mismatch
  הם כשל גלוי.
- export משתמש באותו coordinator וב-virtual clock; השעון נעצר בכל readiness barrier. אין
  מסלול timing שני.
- autoScript=false מכבה את כל ה-recorded automation, לרבות final-state. hide/show UI נשאר
  policy נפרד. אם המוצר ירצה בעתיד final-state גם כשהאוטומציה כבויה, יש להוסיף policy מפורש
  חדש ולעדכן UI, shared types ו-identity hash.

Lifecycle יחיד מונע double navigation ומסמך מלוכלך:

~~~text
activation becomes dirty
→ exit/seek: cover + cancel scheduler/adapter + increment epoch
→ create or join exactly one reset generation
→ real navigation/remount
→ matching READY(documentId, revisionId, generation)
→ PAINTED
→ PREPARE_SECTION
→ ACTION_PLAN_READY (and CLOCK_APPLIED when required)
→ re-check freshness/baseline
→ reveal/activate
~~~

re-entry שמגיע בזמן reset מצטרף לאותו generation ואינו מתחיל reload נוסף. שינוי src לאותו
URL אינו מספיק: נדרש remount/navigation אמיתי באמצעות generation key או nonce שמור; ה-nonce
אינו חלק מזהות package/plan ואסור שישפיע על semantics של הסימולציה. לכל barrier יש deadline,
retry מוגבל של אותו artifact ו-fail-closed ל-poster/error; לעולם לא חושפים את document הישן.

FreshnessContractV1 מחייב revision/package/entry/environment זהים ו-baseline hash חדש לפני
reveal. localStorage, IndexedDB, cookies, service worker ו-server side effects חייבים להיות לא
רלוונטיים או מאופסים דרך namespace/reset בבעלות הפלטפורמה; documentId חדש לבדו אינו מספיק.
seed הוא capability מוכחת, לא שדה אופציונלי שמייצר הבטחת דטרמיניזם. generic prewarm מותר רק
אחרי idle-stability proof לאורך חלון ה-prewarm; אחרת Phase 2 מבצע cold reload מכוסה סמוך לכניסה.
adapter-restore חייב להחזיר baseline digest; plan שסותר את המדיניות אינו managed.

ACK קיימת אינה משנה משמעות: SCRIPT_APPLIED אומר שה-setup הוחל וה-plan הותקן, לא שכל
האירועים העתידיים הסתיימו. diagnostics נוספים הם ACTION_PLAN_READY, ACTION_STEP_ERROR
ו-ACTION_PLAN_COMPLETE; מצב seekable מוסיף CLOCK_APPLIED. כולם קשורים ל-activation
id/token ול-epoch כדי שאירוע ישן לא יזהם activation חדש.

### 8.6 authoring transport

ה-parent יוצר MessageChannel רק אחרי READY של document חדש ושולח port ב-targetOrigin
מדויק. ה-bootstrap בודק source, parent origin allowlist, protocol, documentId ו-source
revision לפני שהוא מקבל את ה-port.

~~~ts
interface AuthoringEnvelopeV1<T> {
  namespace: "flowvid.sim-authoring";
  protocolVersion: 1;
  sessionId: string;
  documentId: string;
  revisionId: string;
  seq: number;
  type: string;
  payload: T;
}
~~~

סוגי הודעות: CAPABILITIES, CONNECT, CONNECTED, START_PICK, STOP_PICK, START_RECORDING,
STARTED, EVENT_BATCH, STOP_RECORDING, STOPPED, CANCEL, ACK ו-ERROR.

START ו-STOP idempotent. STOPPED כולל lastSeq, rawEventCount, normalizedCandidateCount,
byteLength, coalescedCount, droppedCount ו-reason. batch שלא אושר מגביל את החלון; overflow
מפסיק את ההקלטה עם שגיאה גלויה ולא חותך בשקט.

גבולות התחלתיים למדידה, לא קבועי אמת:

| גבול | ערך V1 מוצע |
|---|---:|
| משך recording | 180 שניות |
| raw semantic events | 5,000 |
| normalized actions | 1,000 |
| canonical IR | 512KiB |
| batch | עד 64 events או 64KiB |
| flush | כל 50ms לכל היותר |
| unacknowledged batches | 4 |
| locator | 512 bytes |
| enum/select value | 128 bytes |
| plans פעילים ל-simulation revision | 32 |
| total decoded plans ב-revision | 2MiB |
| encoded plan assets / bridge overhead | 2.75MiB |
| package growth מה-recordings | 4MiB |
| compile CPU | 2 שניות לבקשה |
| proof wall clock | 60 שניות ל-candidate, כולל שתי ריצות |

ה-caps המצטברים נאכפים לפני publication, לא רק לכל section. אם המדידה מראה שה-bridge
המשותף חורג מתקציב dormant parse, תוכניות נשמרות כ-assets immutable לכל section, עם hash,
ונטענות מאותו revision רק ב-PREPARE_SECTION; הן עדיין נכללות ב-offline/export closure.
max sections, candidate/package bytes, decoded bytes, CPU, memory, PIDs ו-wall clock הם
hard limits עם 413/422 יציבים, לא telemetry בלבד. המספרים לעיל הם guardrails ראשוניים
ששלב 0 חייב לאמת ולכוון לפני launch.

קוד הסימולציה וה-bootstrap חולקים realm, ולכן sessionId אינו boundary קריפטוגרפי מול
package זדוני. הוא מונע races, stale documents ו-drift. גבול האמון האמיתי הוא validation
וה-compile בשרת.

### 8.7 הבוחר וה-tri-state

double-click אינו מתאים: הדפדפן יורה click לפני dblclick, והתוצאה מהבהבת ותלויה בתזמון.
ה-UI המדויק:

- toolbar עם ארבעה מצבים: Interact, Keep visible, Hide, Clear mark;
- Keep מוצג בירוק עם icon וטקסט; Hide באדום עם icon וטקסט — לא צבע בלבד;
- Escape מבטל, Undo מחזיר סימון, וה-list הקיים נשאר fallback נגיש;
- במצב Interact ה-overlay אינו בולע events, ולכן אפשר לפתוח Advanced ואז לחזור ל-Pick;
- control hidden או מחוץ למסך נשאר ניתן לבחירה דרך הרשימה.

המשמעות של tri-state תלויה ב-derivationMode:

~~~text
Auto  = ללא override ידני
Keep  = override ידני להצגה
Hide  = override ידני להסתרה

manual Hide > manual Keep > derivation policy > base selection
~~~

UiIntentV1 שומר derivationMode מסוג off או recording, את base selection שהיה בכניסה,
scanId/sourceRevision/truncated ואת manualMarks לפי locator id.

אם derivationMode הוא off, Auto שומר את הבחירה הקודמת. עבור base show/hide מסוג BS/BH:

~~~text
effectiveShow = (BS union G) minus R
effectiveHide = (BH union R) minus G
~~~

רק כאשר היוצר מאשר במפורש Apply recording suggestion, derivationMode הוא recording.
אם scanned controls הם C, touched הם T, marks הירוקים G והאדומים R:

~~~text
effectiveShow = (G union (T intersect C)) minus R
effectiveHide = (C minus effectiveShow) union R
~~~

השרת אוכף marks זרים, כפילויות וחפיפה. אם הסריקה truncated או stale, derivationMode
נופל ל-off; אין hide-the-rest אוטומטי. מוצגת הצעה חלקית בלבד, ו-controls חדשים שלא היו
בסריקה אינם מוסתרים.

### 8.8 פרטיות ואבטחה

- raw capture נשאר בזיכרון העורך ונמחק ב-cancel/navigation/unmount או רק אחרי Apply
  acknowledgement מוצלח. timeout/response אבוד אינם מוחקים עבודה; המשתמש יכול retry עם אותו
  Idempotency-Key או למחוק במפורש. הוא אינו נשלח ללוגים.
- השרת מקבל רק normalized IR. ברירת המחדל היא לא לשמור draft; אם המוצר מאפשר draft, Phase 0
  חייב לזהות במפורש את שכבת ההצפנה at rest, בעלות ה-KMS/key, TTL ומחיקה — לא להסתפק במשפט
  "encrypted under policy".
- password, file, hidden, contenteditable וטקסט חופשי חסומים ב-V1.
- type allowlist אינה sensitivity allowlist. כל control חייב opt-in מפורש כ-public-artifact-safe
  ב-manifest מהימן של הפרויקט, וה-review מציג ומאשר את כל ה-publication diff: locators, action
  kinds, timestamps, metadata וכל value. enum/number אינם בטוחים מעצם סוגם.
- uiIntent שולח locator ids ולא selector strings חופשיים. רק השרת גוזר hideSelectors
  מ-locators שנוצרו, עברו parsing והוכחו כיחידים; boot fragment מקבל רק רשימה מאומתת זו.
- ה-plan עובר canonical JSON ואז base64url לפני שילובו ב-section entry. כך value אינו יכול
  לסגור marker, לשבור parser או לייצר false positive כמו fetch בתוך regex validator;
  base64url הוא encoding בטוח בלבד ואינו confidentiality.
- executor הוא קוד מערכת קבוע. אין eval, Function, HTML insertion או selector שנבנה מערך.
- exact targetOrigin, allowlisted parent origin ו-MessagePort מחליפים postMessage עם כוכבית
  בנתיב authoring.
- rate limits ו-body limit קיימים גם ב-controller, לפני Zod parse עמוק.
- metrics ולוגים כוללים counts, hashes וקודי שגיאה בלבד — לא selectors, labels או values.

---

## 9. Backend, נתונים ופרסום

### 9.1 endpoint חדש

~~~text
POST /api/v1/projects/:projectId/sections/:sectionId/action-recordings/apply
Idempotency-Key: <uuid>
~~~

Body:

~~~ts
{
  recording: ActionRecordingV1;
}
~~~

ה-endpoint אינו מקבל bridgeBody או מקור אמת כפול. projectId/sectionId נגזרים מה-route;
revision/package/ui intent מגיעים פעם אחת מתוך recording ונבדקים מול snapshot של השרת.
simulationId/sectionId בתוך ה-IR חייבים להיות זהים ליחסים שנקראו, אחרת 400/409. סדר הפעולות:

1. authenticate, בדוק project edit permission ואכוף body limit לפני parse עמוק;
2. אמת schema, בנה command סמכותי מה-route ומה-recording, חשב requestHash ותבע שורת
   idempotency במצב received;
3. קרא snapshot קצר ללא lock ארוך: project/section/simulation, sectionVersion, duration,
   active revision ו-sourcePackageHash;
4. אמת את כל זהויות source, freshness, section וה-environment מול ה-snapshot;
5. חשב recordingHash, עבור ל-compiling, קמפל ActionPlanV1 ורק אז חשב planHash;
6. הרץ static plan validation ואכוף caps לכל plan ולכל candidate package;
7. stage את ה-bytes המדויקים ב-proof_pending פרטי, שמור artifactHash ועבור ל-proving;
8. הרץ replay proof מבודד מול אותם bytes; אם העבודה חורגת מתקציב הסינכרוני, החזר 202
   עם recordingId ו-status URL והמשך כ-job — לעולם לא מפרסמים כדי לבדוק אחר כך;
9. לפני activation קרא שוב את כל ה-fences. בתוך transaction hook בצע revision CAS ו-UPDATE
   מותנה של timeline_sections על id, project, simulation, sectionVersion ו-duration; עדכן גם
   recording result ו-sim_meta;
10. שמור את גוף/status התגובה הטרמינלית והחזר revisionId, sectionUrl, artifactHash,
    bridgeHash, planHash ו-diagnostics.

שגיאות יציבות:

| HTTP | code | משמעות |
|---:|---|---|
| 400 | invalid_recording | schema/canonicalization |
| 403 | forbidden | אין הרשאת עריכה |
| 409 | stale_recording | revision/package/section השתנו |
| 409 | idempotency_conflict | אותו key עם body אחר |
| 413 | recording_too_large | bytes/events/duration |
| 422 | unsupported_action | control/locator/lifecycle לא נתמכים |
| 422 | replay_mismatch | preview/canary לא הגיע ל-state הצפוי |
| 409 | publication_conflict | revision או section fence אבדו; אין rebase ב-V1 |
| 503 | proof_unavailable | runner מבודד אינו זמין; candidate נשאר לא-ציבורי |

### 9.2 source fence, CAS ו-idempotency

ה-CAS הקיים מגן משינוי שמתרחש בזמן build, אבל לא מהקלטה שנעשתה שעה קודם מול revision
ישן. לכן sourceRevisionId הוא fence נפרד וחובה. V1 מחזיר 409 על כל drift. שלב עתידי יוכל
לבצע rebase פעם אחת רק אם hash של קבצי המשתמש, שאינו כולל platform bridge, נשאר זהה.

idempotency נתבעת לפי requestHash לפני compile; planHash אינו קיים עדיין בנקודה הזאת. ה-row
עובר received → compiling → staged → proving → activating → applied/failed ומחזיק leaseOwner,
leaseExpiresAt, attemptCount ו-updatedAt. worker שמת משאיר lease שפג; worker אחר רשאי להמשיך
רק מאותו command, source fence ו-artifact hash.

- Idempotency-Key זהה עם requestHash שונה מחזיר 409;
- retry של row טרמינלי מחזיר בדיוק את responseHttpStatus ו-responseJson שנשמרו — לעולם לא
  משחזרים תשובה מ-sim_meta הפעיל, שעשוי כבר להתחלף;
- retry של row פעיל מחזיר 202/status או ממתין זמן מוגבל; הוא אינו מתחיל build שני;
- שני workers נשענים על uniqueness ב-DB, lease ו-revision CAS, לא על withBridgeLock מקומי;
- V1 אינו עושה retry על active revision חדש, גם אם section אחר פרסם. CAS/section drift הוא
  409 טרמינלי; rebase עתידי דורש user-content hash ואלגוריתם merge מפורשים;
- retry תשתיתי מותר רק לאותו candidate immutable ובתוך fences זהים;
- כשל לפני activation משאיר artifact פרטי ל-TTL/GC; כשל transaction אינו משנה את section
  הפעיל, ושומר failure response אידמפוטנטי.

### 9.3 persistence

מומלצת טבלה פרטית ולא הכנסת כל ה-plan ל-sim_meta:

~~~sql
sim_action_recordings (
  id uuid primary key,
  project_id uuid not null,
  section_id uuid not null,
  simulation_id uuid not null,
  created_by uuid not null,
  source_revision_id uuid not null,
  source_package_hash text not null,
  section_version bigint not null,
  schema_version integer not null,
  compiler_version text not null,
  execution_kind text not null,
  source_recording jsonb not null,
  recording_hash text not null,
  plan jsonb,
  plan_hash text,
  idempotency_key text not null,
  request_hash text not null,
  status text not null,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  published_revision_id uuid,
  bridge_hash text,
  artifact_hash text,
  proof_artifact_hash text,
  failure_code text,
  response_http_status integer,
  response_json jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  applied_at timestamptz
)
~~~

אילוצים:

- unique על project_id + idempotency_key;
- index על section_id + created_at;
- check ל-state transitions ול-execution_kind; plan/plan_hash הם null רק לפני compiled;
- partial index על lease_expires_at ל-recovery ו-index על status + updated_at ל-GC;
- מחיקת project/section והתנהגות audit נקבעות במדיניות retention מפורשת אחת בשתי השפות;
- source_recording וה-plan הם normalized typed data בלבד, לא rrweb log או HTML; שומרים את
  שניהם כדי ש-edit יטען מקור סמנטי ו-recompile לא ינסה להפוך artifact חזרה ל-IR;
- draft שלא הוחל מקבל TTL; recording שהוחל נשמר לצורך edit/audit כל עוד ה-section קיים.

sim_meta נשאר provenance קומפקטי:

~~~ts
{
  planVersion: "8",
  generatedBy: "recording",
  recordingId: string,
  recordingHash: string,
  recordingSchemaVersion: 1,
  compilerVersion: string,
  sourceRevisionId: string,
  sourcePackageHash: string,
  execution: ExecutionPolicyV1,
  durationMs: number,
  actionCount: number,
  artifactHash: string,
  warnings: string[],
  validationLevel: "static" | "structural" | "semantic",
  runtimeValidated: boolean,
  uiControls: SimUiSelection,
  uiIntent: UiIntentV1
}
~~~

יש לעדכן את SimMeta ב-shared/generated client ואת simMetaShape tests. runtimeValidated
יהיה true רק כאשר validationLevel הוא semantic ולאחר browser proof עם expected digest
מ-adapter פלטפורמה allowlisted ומקובע. structural proof של DOM בלבד אינו מקבל את התווית;
visual proof עתידי הוא level נפרד ולא נקרא semantic.

### 9.4 compiler ו-runtime artifact

ה-compiler אינו פולט רצף JavaScript חופשי. הוא:

1. מאמת ומנרמל ActionRecordingV1;
2. מפיק setup, baseline, timeline, checkpoints ו-locator table;
3. מקודד ActionPlanV1 canonical כ-base64url;
4. קושר אותו ל-executor מערכת קבוע;
5. מפיק contract של locators/actions עבור SavedBridgeService ו-canary;
6. מחזיר bytes דטרמיניסטיים ו-hash.

section body מינימלי מבחינה לוגית:

~~~js
return window.__SIM_ACTION_PLAN_V1__.run(params, encodedPlan);
~~~

הפונקציה עצמה נבנית בשרת ממחרוזת קבועה ומבוקרת; encodedPlan לעולם אינו concatenated
כקוד. ה-validator החדש בודק schema, executor version, marker safety, max decoded bytes ו-contract.
validateGeneratedBridge הקיים נשאר שכבת regression, לא הוכחת semantics.

Saved bridges צריכים לשמור recordingId/plan כאשר המקור הוא recording. בעת apply למטרה
אחרת בודקים LocatorContract מחדש; אין להסתפק ב-regex שמחפש getElementById בגוף הקצר.

### 9.5 runtime proof לפני activation

יש להבדיל בין רמות הוכחה:

- **static:** schema, limits, contract ו-executor version בלבד;
- **structural:** locator נמצא, action adapter רץ, control state צפוי, אין שגיאות/leaks;
- **semantic:** expected digest שנקשר להקלטה ומחושב מחדש ב-adapter פלטפורמה allowlisted מוכיח
  גם את מצב הסימולציה;
- **visual, עתידי:** oracle עצמאי עם environment/tolerance/masking/retention מפורשים. הוא אינו
  קיצור דרך ל-semantic ואינו שומר screenshot ב-plan או בלוג.

proof מינימלי משתמש באותו parent coordinator, transport, cover/reveal, sandbox, CSP ו-serve-time
injection של viewer/export — לא רק ב-child executor:

1. resolve כל locator ובדוק uniqueness/fingerprint;
2. אמת FreshnessContract: revision/package/entry/environment, cross-document policy ו-baseline
   control hash לפני reveal;
3. הרץ final-state או virtual timeline עד כל expected checkpoint והשווה controlStateHash;
4. semantic path משווה גם adapterStateDigest צפוי; digest שה-package עצמו מדווח הוא diagnostic
   בלבד ואינו oracle;
5. הפעל cleanup/reset דרך ה-parent lifecycle: ב-adapter mode אמת baseline digest; ב-reload mode
   צור navigation generation חדש, handshake חדש ו-baseline recheck — documentId חדש לבדו אינו
   מכונה pristine;
6. הרץ פעם שנייה במסמך חדש באמת כדי להוכיח repeatability ואת cover/epoch/readiness barriers;
7. ודא שאין timer/listener/overlay leak, stale ACK או async SCRIPT_ERROR, ושה-artifactHash שנבדק
   זהה בדיוק ל-artifact שמועבר ל-activation.

יש להריץ את ה-proof על staged revision לפני activation באמצעות harness פנימי ומאומת או
serve מקומי של bytes staged. המצב הקיים דורש refactor: validate מעביר candidate
ל-canary_passed, וסטטוס זה ציבורי כיום. יש להוסיף proof_pending/proof_passed שאינם ציבוריים,
או להשאיר את ה-row ב-validating עד סוף ה-proof, ולהעביר את canary ל-harness הפנימי. רק active
רשאי להפוך candidate חדש לציבורי. אין להחליש את publication gate כדי לאפשר את הבדיקה.

ה-harness מריץ JavaScript שרירותי ולכן הוא boundary של קוד עוין: worker אפמרלי ללא credentials
שנגישים ל-page, network egress חסום (`--network none`) עם loopback בלבד, filesystem read-only,
user לא-root, drop capabilities/no-new-privileges, origin נפרד, quotas ל-CPU/memory/PIDs/tmpfs,
wall-clock kill ו-logs מסוננים. יש למחזר את primitives של export capture isolation, אך לא
לשתף browser context, cookies או tokens עם backend/authoring.

Phase 0 חייב למדוד latency ועלות. אם p95 אינו מתאים למסלול synchronous, Apply מחזיר 202
וה-proof ממשיך כ-job פרטי לפני activation. אין fallback של publish-then-proof: canary_passed,
retired ו-rolled_back נגישים ציבורית כיום, ולכן rollback אינו revocation. structural proof יכול
לאשר פעולות native עם reload-document אך runtimeValidated נשאר false; generic button חסום,
ו-adapter claims דורשים semantic proof מהימן.

---

## 10. תוכנית בנייה, בדיקות והשקה

### שלב 0 — ADR ו-spikes חוסמים

- אשר ב-ADR את semantics שנקבעו: reload-document ו-entry-relative כברירת מחדל,
  adapter-restore ו-section-synchronous רק כאשר capability מוכחת.
- בנה fixtures: Vanilla, React controlled inputs, DOM rerender, duplicate/special ids,
  radio group, hidden Advanced panel ו-unsupported canvas.
- הוכח serve-time bootstrap על revision ישן וחדש, local/cloud, ללא rebuild.
- תכנן וממש state לא-ציבורי ל-proof; canary_passed הקיים אינו מתאים כי הוא מוגש לציבור.
- הוכח scheduler מול clock מזויף: pause, resume, rate, generic restart-on-seek ו-adapter seek.
- הוכח lifecycle מלא עם generation יחיד, READY/PAINTED/PLAN barriers, deadline ו-fail-closed.
- תכנן idempotency states/lease recovery ו-sectionVersion fence לפני כתיבת endpoint.
- מדוד isolated fresh-document proof, package publication ו-dormant bootstrap overhead.
- קבע schema, limits, privacy, TTL ו-license process.
- יציאה מהשלב: ADR מאושר, golden fixtures עוברים, ואין generic click ב-supported matrix.

### שלב 1 — visual picker מאחורי feature flag

- authoring bootstrap ו-SimAuthoringClient עם capabilities ו-session identity;
- LocatorV1 עם escaping, uniqueness ו-fingerprint;
- Interact / Keep / Hide, Undo, Escape, keyboard ו-list fallback;
- tri-state persistence ו-effective show/hide derivation;
- scan truncation/staleness warning;
- telemetry ללא selector/value;
- fallback מלא ל-checkbox list כאשר capability חסרה.

זהו שלב שימושי לבדו. בניגוד להצעה המקורית הוא כולל שינויי contract ו-tests, אך אינו
דורש DB column או dependency חדשה.

### שלב 2 — vertical slice של recording

- fresh/pristine authoring session;
- semantic capture ל-range, number, checkbox, radio ו-select;
- baseline, final state, normalization ו-review UI;
- בחירה מפורשת Final state / Replay timing;
- local replay פעמיים עם diagnostics;
- ActionRecordingV1, endpoint, DB row, server compiler ו-fixed executor;
- source fence, idempotency ו-atomic publication;
- clock sync ל-player ול-export; generic timeline הוא entry-relative ו-seek מפעיל restart;
- candidate staging ו-structural fresh-document proof לפני activation;
- player reset generation אמיתי: cold reload מכוסה, readiness barrier, seek restart, timeout,
  cancellation ו-stale generation rejection;
- metadata ו-observability.

אין לשחרר recorder-only ששומר לוג שאי אפשר להשתמש בו. ה-feature נפתח רק כשהמסלול
Record → Review → Preview → Apply → Viewer/Export עובד מקצה לקצה.

### שלב 3 — hardening ו-rollout

- hardening של proof harness, validation levels ו-latency budgets;
- multi-worker concurrency, lease recovery, lost-response replay ו-emergency compensation;
- prewarm/pooling רק לסימולציות שעוברות idle-stability ו-freshness proof;
- canary על allowlist של simulations/projects;
- performance budgets ו-kill switch;
- integration עם Save Bridge ו-project duplication;
- dashboard של failure codes, selector drift ו-publication latency.

### שלב 4 — adapters ו-interop

- SimRecordingAdapterV1 בבעלות הפלטפורמה לסימולציות מוכרות, עם registry חתום ו-hash pinned;
- החלטה נפרדת ל-canvas/WebGL, shadow roots ו-same-origin iframe;
- cross-origin iframe נשאר unsupported עד threat model נפרד;
- import/export adapter ל-Chrome DevTools UserFlow;
- ניסוי rrweb lazy-loaded רק אם telemetry מוכיחה שחסר session context שהמקליט הסמנטי
  אינו יכול לספק.

### שלב 5 — LLM polish

המודל מקבל normalized plan ומחזיר union סגור בלבד:

~~~ts
interface PlanPatchV1 {
  schemaVersion: 1;
  basePlanHash: string;
  operations: Array<
    | { kind: "trim"; startMs: number; endMs: number }
    | { kind: "scale-duration"; numerator: number; denominator: number }
    | { kind: "set-easing"; locatorId: string; easing: "linear" | "ease-in" | "ease-out" | "ease-in-out" }
    | { kind: "resample"; maxHz: number }
  >;
}
~~~

הוא אינו רשאי לשנות locator, value, action kind, execution/freshness policy או להחזיר JS.
ה-server מחיל patch דטרמיניסטית רק אם basePlanHash תואם; הפלט עובר schema, limits, compile
ו-replay proof מחדש. יש למדוד בפועל input/cached/output tokens; המסלול הישן source-aware
נשאר fallback מפורש רק לבקשה שאינה ניתנת לביטוי ב-IR.

### 10.1 מטריצת בדיקות מחייבת

| תחום | בדיקות קבלה |
|---|---|
| IR | schema version, canonical ordering, same input → same bytes/hash, NaN/overflow rejection |
| Locator | colon/space/digit id, quoted name, duplicate id, radio name, stale DOM, ambiguous match |
| Capture | only trusted user events, target via composedPath, input/change dedupe, iframe remount |
| Normalize | first/final/turning points, per-control rate, same-time ordering, absolute final target + baseline hash |
| Runtime | native + React range/checkbox/radio/select, missing locator is error, no double event |
| Clock | autoScript=false, pause 5s, resume remaining delay, rate, restart-on-seek, adapter seek both ways |
| Cleanup | cancel future action, single reset generation/barrier, new document + baseline recheck, adapter digest restore, run twice, no leak |
| Transport | duplicate START/STOP, old document, wrong origin, wrong session, seq gap, overflow, lost ACK |
| API | auth, project/section/simulation binding, 413 caps, stale 409, idempotency conflict |
| Concurrency | two workers, lease expiry/recovery, competing publish → 409, lost response returns stored status/body |
| Privacy | blocked inputs absent, public-safe control opt-in, exact artifact diff, no raw DOM/value in logs |
| Picker | Interact/Pick switch, hidden control fallback, keyboard, icons/text beyond color, truncated scan |
| Publication | private proof state never served, proof/activation artifact hashes match, staged failure preserves prior active section |
| E2E | record → preview → apply → viewer; export virtual clock yields identical checkpoints |
| Performance | dormant overhead, active latency, 60fps churn, per-plan + aggregate package budgets, proof CPU/memory/wall time |

### 10.2 observability

למדוד:

- authoring connect/start/stop/cancel reason;
- recording duration, raw/normalized count, bytes, coalescing ratio ו-overflow;
- locator missing/ambiguous/fingerprint mismatch לפי action kind בלבד;
- preview mismatch ו-restore failure;
- validate/compile/proof/publish latency בנפרד;
- revision bytes read/reused/written, CAS conflict, lease recovery ו-idempotent response replay;
- runtime step errors, seek rebuilds, freshness/baseline failure ו-clock drift;
- viewer bootstrap bytes, parse cost ו-frame-time regression;
- token input/cached/output רק במסלול LLM.

אין להכניס project id, selector, label או value ל-metric labels. hashes קצרים יכולים
להופיע בלוג מאובטח לצורך correlation בלבד.

יעדי launch מוצעים, שיש לאמת ב-canary:

- 100% golden determinism ו-100% lifecycle/cleanup fixtures;
- אפס דליפה של input חסום או field שלא אושר בבדיקות artifact ולוגים; business sensitivity
  שאושרה בטעות נשארת סיכון אנושי ומחייבת review מפורש;
- dormant bootstrap עד 5KB gzip, ללא observer פעיל לפני ARM;
- פחות מ-1% regression ב-viewer frame time במדגם;
- p95 capture handler מתחת ל-2ms על fixtures;
- מעל 99% Apply success לפעולות שמוגדרות supported;
- selector miss מתחת ל-0.5% בקבוצת canary;
- runtime kill switch מבטל plan פעיל ומונע activation חדש בתוך דקות; recovery של revision
  נמדד בנפרד ואינו מוצג כ-revocation של URL שכבר פורסם.

### 10.3 rollout, containment ו-recovery

1. deploy bootstrap capability בלבד; parent UI עדיין כבוי.
2. אמת telemetry שאין viewer regression וש-revisions ישנים עונים נכון.
3. פתח picker ל-internal projects.
4. פתח recording vertical slice ל-allowlist של standard-control simulations.
5. הרחב לפי success rate, לא לפי תאריך.
6. kill switch נאכף גם ב-parent וגם ב-runtime executor: הוא מבטל scheduler/adapter פעילים,
   מונע PREPARE/ARM חדשים ויכול לחסום executorVersion ב-serve-time bootstrap. bootstrap נשאר inert.
7. כשל runtime חמור מפסיק rollout ומפעיל containment. recovery ל-revision קודם מותר רק עם
   expected-current CAS ו-transaction hook שמחזיר section/recording/provenance יחד. אם publication
   אחר כבר ניצח, אין rollback גלובלי שמוחק אותו: נדרשת compensating publication של גוף ה-section
   מול ה-revision הנוכחי, או השבתה עד תיקון.
8. אין להריץ mass rebuild אוטומטי: serve-time injection מייתר backfill מסוכן.

retired/rolled_back revisions נשארים נגישים ב-/sim-public במימוש הנוכחי; recovery משנה את
ה-active pointer אך אינו מוחק או מבטל URL שפורסם. לכן אסור להשתמש ב-rollback כתחליף ל-proof
לפני activation, ויש להציג במפורש את גבול ה-containment הזה ב-runbook.

### 10.4 risk register

| סיכון | חומרה | מניעה | סיכון שיורי |
|---|---|---|---|
| locator מצביע ל-control אחר אחרי replace | גבוהה | revision fence + uniqueness + fingerprint + canary | שינוי דינמי בתוך אותו revision |
| click משנה state פנימי או דורש trusted activation | קריטית | חסום ב-V1; semantic adapter מוכח בלבד | כיסוי פיצ'רים מצומצם |
| replay סוטה מה-video אחרי seek/stall | קריטית | restart-on-seek כברירת מחדל; adapter seek + export clock | restart מורגש למשתמש |
| value רגיש הופך ציבורי | קריטית | public-safe opt-in + exact diff approval + blocked-input tests | author עלול לסווג business value כציבורי |
| שני workers מפרסמים יחד | גבוהה | DB idempotency + lease + source/section fence + revision CAS | 409/latency |
| package זדוני מזייף authoring message | גבוהה | channel identity + server validation + canary | same-realm אינו isolation |
| bootstrap פוגע בכל viewer | גבוהה | inert serve injection + budgets + kill switch | bytes קטנים קבועים |
| scan חלקי מסתיר control חשוב | גבוהה | truncated warning; no auto-hide-rest | author manual error |
| proof בדפדפן איטי | בינונית | 202 async pre-activation, bounded pooling, hard quotas | apply latency |
| dependency/license drift | בינונית | no-dependency V1; exact pin + notices אם מתווסף | תחזוקת SBOM |

---

## 11. החלטות סופיות לפני קוד

### נקבע בדוח

- MVP משתמש ב-semantic recorder ללא rrweb.
- ActionRecordingV1 הוא ה-IR הקנוני; Puppeteer UserFlow הוא adapter בלבד.
- הלקוח אינו יוצר או שולח JavaScript.
- V1 תומך ב-native controls מוחלטים, עם reload-document כברירת מחדל; הוא אינו טוען
  ששינוי DOM מחזיר state פנימי.
- final-state ו-timeline הם בחירת משתמש מפורשת.
- timed replay גנרי מסונכרן למדיה בזמן playback רציף ותומך pause/resume/rate/export;
  seek מתחיל מחדש. section-synchronous seek דורש adapter מוכח.
- generic click, canvas, custom widget, shadow DOM ו-iframe אינם supported בלי adapter.
- preview אינו מפרסם; Apply יחיד מפרסם.
- raw capture ephemeral; normalized plan פרטי; artifact שפורסם מכיל allowlisted values בלבד.
- visual picker משתמש ב-Interact/Keep/Hide וב-list fallback.
- hide-the-rest הוא suggestion הניתנת לעריכה, ולא החלטה בלתי הפיכה.
- LLM משנה patch טיפוסי בלבד.

### החלטות שיש למדוד בשלב 0

1. האם fresh-document proof יכול להיכנס ל-p95 latency מקובל לפני activation.
2. התקציב המדויק ל-bootstrap ול-active capture על מכשיר low-end.
3. TTL של draft recordings ומדיניות מחיקה לאחר section deletion.
4. עלות reload-document, אסטרטגיית prewarm וה-latency של re-entry.
5. מהו source content hash שמאפשר rebase עתידי בלי להתעלם משינוי קבצי משתמש.

### המלצה סופית

לא להתחיל משלבים B–D המקוריים. להתחיל ב-Phase 0 קצר וב-picker מוקשח, ואז לבנות vertical
slice אחד עם simulation fixtures אמיתיים. הארכיטקטורה הנכונה היא:

~~~text
serve-time inert bootstrap
→ versioned MessageChannel
→ semantic typed recording
→ local deterministic preview
→ authenticated IR-only endpoint
→ server-side fixed executor plan
→ fresh-document proof
→ revision CAS + atomic provenance
→ media-clock-synchronized runtime
~~~

כך נשמרים היתרונות שבבסיס הרעיון — authoring ויזואלי, חיסכון גדול ב-LLM ודטרמיניזם —
בלי להפוך session replay גולמי לקוד ציבורי, בלי silent selector failures ובלי לשבור את
חוזי pause, seek ו-cleanup שעליהם ה-viewer כבר נשען.

---

# English version — authoritative reviewed design, subject to Phase-0 gates

The English sections below are the complete equivalent of the reviewed architecture in Sections
6–11. They intentionally do not translate superseded assumptions from the original draft as if
those assumptions were still recommendations.

## 12. Deep-review verdict

### 12.1 Decision

The product direction is strong, but the architecture in Sections 1–5 is not safe or precise
enough to implement as written.

| Area | Decision | Condition |
|---|---|---|
| Visual control picker | **Conditional GO** | New locator contract, defined tri-state, versioned authoring channel, list fallback |
| rrweb embedded in every package | **NO-GO for MVP** | Start with a small semantic recorder; keep rrweb as a measured future experiment |
| Browser-generated JavaScript | **NO-GO** | The browser sends typed IR; only the server compiles |
| Puppeteer UserFlow as canonical IR | **NO-GO** | Use internal ActionRecordingV1; add UserFlow adapters later |
| One setTimeout per event | **NO-GO** | Fixed executor, one scheduler, product timeline clock |
| Final-state capture | **GO** | Store a baseline plus absolute target state for plan-owned controls |
| Generic click, canvas, custom widgets | **Out of V1** | Require an adapter that proves apply, restore, and seek semantics |
| LLM polish | **Optional, later** | May return a constrained PlanPatch only, never arbitrary JavaScript |

The central value remains intact: the author creates a small deterministic action plan instead of
sending source files and tens of thousands of tokens to a model. The plan must be semantic,
bounded, reviewable, and synchronized with the product timeline rather than being a raw session
replay.

### 12.2 Required corrections to the original proposal

| Original claim | Review finding | Corrected statement |
|---|---|---|
| CSP is not a blocker | True for injection, but CSP is not authentication | A same-origin bootstrap can be injected; the server remains the trust boundary |
| Existing selectors are stable and production-proven | Raw id/name values are neither escaped nor proven unique | Reuse the scan concept, not the current identity contract |
| Picker needs zero backend work | True only for a temporary binary picker | Persistent tri-state needs shared types, validation, and sim_meta changes |
| Runtime v3 is dormant | v3 is embedded in newly published packages | The modern path is still unavailable to most packages; feature-detect capabilities |
| Messaging has no size limit | The claim mixes an HTTP route with postMessage | Define caps, batching, backpressure, and a terminal acknowledgement |
| Static versus dynamic can be inferred | Timestamp count does not reveal author intent | Suggest a mode, but let the author choose Final state or Replay timing |
| Clearing all timeouts makes replay safe | It does not implement pause, seek, or state restoration | Use one scheduler, an explicit ExecutionPolicy, and a lifecycle contract |
| Restoring a control baseline restores the simulation | A DOM value does not rewind physics, canvas, or framework state | Default to document reload; require a proven adapter for restore and seek |
| applySavedBridgeBody is a ready editor path | It is a trusted service method, not an editor API | Add an authenticated endpoint that accepts IR only |
| validateGeneratedBridge is runtime insurance | It is a static validator | Add plan validation, fresh-document replay proof, and canary coverage |
| A FullSnapshot resolves all rrweb node ids | Later nodes depend on ordered mutations | Do not use a single FullSnapshot as a configuration compiler |
| UserFlow plus timing provides free interoperability | UserFlow targets browser automation; custom timing is not standard | Add explicit adapters after MVP |
| All four phases are independent | Recording without compilation is only an unusable log | Ship an end-to-end vertical slice |
| Every generation saves 50–55K tokens | That number is an upper bound of the current path | Measure actual input, cached input, and output tokens |

### 12.3 Evidence in the current repository

- SimulationService.ts:541–562 constructs selectors from id, name, or nth-of-type paths without
  CSS escaping or a uniqueness proof. A radio group with a shared name is a direct collision.
- SimUiControls.ts:56–79 rejects only a narrow set of characters. It is not a CSS parser and does
  not prove that a selector identifies one control.
- SectionEditor.tsx:1423–1448 implements a small one-shot request with a timeout. It is not a
  transport design for a long event stream.
- SimTransport.ts and shared/src/sim/runtimeProtocol.ts already provide MessageChannel transport,
  document identity, sequence handling, and tombstones. The authoring channel should reuse that
  design pattern.
- SimulationService.ts:1518–1652 pauses only handles explicitly registered through simDemoTimer.
  The proposed timeouts are not registered, and recreating them with their original delay would
  still lose the remaining delay.
- useProjectPlayer.ts:4166–4170 assumes stopScript returns a resident document to a pristine
  state. A generic click that mutates a model, canvas, or WebGL scene violates that invariant.
- SimStartParams currently carries simpleUi, autoScript, and hideSelectors. It has no section
  offset, clock epoch, or playback rate, so replay after a seek cannot be timeline-correct.
- sections.controller.ts:955–960 has no recording IR input. The current route to
  applySavedBridgeBody exists only in the saved-preset flow.
- SimulationService.ts:1987–1988 explicitly states that runtime validation is future work.
- uploadSectionBridge provides valuable staging, revision CAS, and a transaction hook, but a
  publication still processes a package. It is neither free nor an idempotency mechanism.
- sim-public.controller.ts already injects SIM_BOOT_SNIPPET at serve time, including for existing
  revisions. That is a better home for a small authoring bootstrap than a gate bump that reaches
  only the next publication.
- revisionIdentity.ts keeps draft/uploading/validating/failed private, but deliberately serves
  canary_passed. A new proof flow therefore cannot use that status or /sim-public before activation
  without changing the revision state machine.
- Active revision files and bridge.js are served through unauthenticated /sim-public URLs.
  Any recorded value embedded in a published plan is effectively public.

### 12.4 External research and consequences

- The official rrweb guide documents maskAllInputs as false by default, recordCanvas as false, and
  requires rrweb to be injected into each child frame for cross-origin frame recording. Privacy
  and frame coverage are therefore not automatic:
  [rrweb guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md).
- rrweb event documentation defines a FullSnapshot followed by cumulative IncrementalSnapshot
  mutations that depend on order. A node id plus one initial snapshot is not a semantic compiler:
  [rrweb events](https://github.com/rrweb-io/rrweb/blob/main/docs/events.md).
- Puppeteer Replay is officially an API for replaying and stringifying Chrome DevTools Recorder
  recordings, not a product timing contract:
  [Puppeteer Replay](https://github.com/puppeteer/replay/blob/main/README.md).
- Chrome Recorder normally replays a flow as quickly as it can; replay speed is a debugging aid.
  A private timing field does not create free interoperability:
  [Chrome Recorder reference](https://developer.chrome.com/docs/devtools/recorder/reference).
- The HTML Standard recommends waiting for readiness from a newly loaded iframe and specifies
  that a target-origin mismatch discards a message. This supports an explicit handshake and exact
  target origins:
  [HTML cross-document messaging](https://html.spec.whatwg.org/dev/web-messaging.html).
- The DOM Standard specifies that dispatchEvent events and the event produced by element.click
  are not trusted. User-activation-dependent behavior cannot be reproduced generically:
  [DOM Standard](https://dom.spec.whatwg.org/).
- CSSOM defines CSS.escape. Concatenating an unescaped id after a hash is not correct selector
  serialization:
  [CSSOM](https://www.w3.org/TR/cssom-1/).
- React documents that a controlled input is forced back to application state, and that
  checkboxes and radios use checked rather than value. Direct DOM assignment alone is not a
  replay contract:
  [React input](https://react.dev/reference/react-dom/components/input).

The npm measurements taken on the report date found @rrweb/record 2.1.1 under MIT, three runtime
dependencies, and about 2.22MB unpacked. Its measured minified browser bundle was about 77.9KB and
23.9KB gzip. @puppeteer/replay 4.0.2 was Apache-2.0 and about 194KB unpacked, with no reported
runtime dependencies. These values are volatile. If either package enters the product, pin the
exact version and preserve LICENSE, NOTICE, provenance, and SBOM records. V1 should add neither.

---

## 13. Target architecture

### 13.1 Principles

1. **Data, not code.** The client creates ActionRecordingV1 and never submits JavaScript.
2. **The server is authoritative.** Authorization, source fencing, limits, canonicalization,
   compilation, and publication run on the server.
3. **A fixed executor.** The bridge carries a versioned system interpreter and a data plan, not
   generated timeout functions.
4. **Honest clock semantics.** During uninterrupted playback, timed replay follows media time.
   Generic V1 restarts after a seek; exact seek synchronization requires a proven adapter.
5. **Typed actions and an explicit reset policy.** Even an absolute slider write may mutate
   irreversible physics state. The default is document reload; in-place restore requires an adapter.
6. **Separate version domains.** Authoring protocol, runtime protocol, and rAF gate versions are
   independent.
7. **No silent no-op.** Missing, ambiguous, stale, or unsupported locators are blocking
   diagnostics.
8. **Preview before publication.** Stop completes capture; only an explicit Apply publishes.

### 13.2 System flow

~~~mermaid
flowchart LR
    E[SectionEditor] --> C[SimAuthoringClient]
    C <-->|MessageChannel + session/document/seq| B[Serve-time Authoring Bootstrap]
    B --> R[Semantic Recorder + Visual Picker]
    R --> N[Normalize + Review + Local Replay]
    N -->|ActionRecordingV1 only| A[Authenticated Apply Endpoint]
    A --> V[Source Fence + Schema + Limits]
    V --> K[Deterministic Plan Compiler]
    K --> S[Stage Candidate Revision]
    S --> P[Fresh-document Replay Proof]
    P --> U[Revision CAS Activation]
    U --> T[Atomic Section + Provenance Update]
    T --> X[Fixed ActionPlan Runtime]
    X <-->|Clock sync: play pause seek rate| M[Project Player / Export Clock]
~~~

### 13.3 Serve-time authoring bootstrap

Extend the existing entry-HTML serve transform in sim-public.controller.ts:

- existing active revisions gain the capability without rebuild or byte mutation;
- there is no dependency on the next RAF_GATE_VERSION;
- the bootstrap is dormant: one handshake listener and a capability response until armed;
- semantic capture can remain a few kilobytes inline, or load a same-origin authoring-only asset
  after ARM if measurements justify it;
- allowed parent origins are embedded from browserOrigins, independently of export messaging;
- an ordinary viewer never opens an authoring port.

Do not expand the two large orchestration files further. Recommended ownership:

| Layer | New module |
|---|---|
| Shared wire contract | shared/src/sim/authoringProtocol.ts |
| IR and Zod schema | shared/src/sim/actionRecording.ts |
| Serve transform | backend-api/src/services/simulation/SimAuthoringBootstrap.ts |
| Client transport and FSM | client-web/lib/sim/SimAuthoringClient.ts |
| React orchestration | client-web/hooks/useSimAuthoring.ts |
| API controller | backend-api/src/controllers/v1/actionRecordings.controller.ts |
| Validation and canonicalization | backend-api/src/services/simulation/ActionRecordingService.ts |
| Deterministic compiler | backend-api/src/services/simulation/ActionPlanCompiler.ts |
| Fixed runtime source | backend-api/src/services/simulation/ActionPlanRuntime.ts |

SimulationService should expose a narrow applyRecordedActionPlan orchestration method. Split or
extend the publication primitive to expose stage → proof callback → CAS activation while reusing
the internals of uploadSectionBridge. It should not own parsing, normalization, or runtime
execution.

### 13.4 End-to-end authoring flow

1. The editor checks the iframe capability and source identity.
2. Entering authoring creates a fresh document for an exact revision, suppresses the existing
   section script, waits for readiness and a real frame, then captures a baseline.
3. The author selects one explicit intent:
   - **Apply final state:** persist the baseline-to-final diff and apply it synchronously.
   - **Replay timing:** persist a timeline; suggest trimming, but require author confirmation.
4. START creates a new session, a short countdown, and a performance.now time origin.
5. The bootstrap records trusted user events only for supported controls, normalizes each event to
   a control root, and emits bounded batches.
6. STOP returns a terminal summary containing counts, bytes, dropped/coalesced events, and final
   state.
7. Review shows the actions, controls, unsupported events, duration, silence, and proposed UI
   visibility.
8. Preview runs in a fresh document twice and must converge to the same final state.
9. Apply submits IR to the server. Revision drift between Record and Apply returns 409.
10. After validation and replay proof, the server publishes once and atomically persists
    provenance.

A recording replacement starts from a pristine package and does not layer on arbitrary generated
code. Editing a recorded plan loads its stored ActionPlan. Replacing a legacy LLM bridge is an
explicit replacement. Hybrid recording on top of an arbitrary legacy body is outside V1.

### 13.5 Editor state machine

~~~text
idle
  → connecting
  → picking ↔ interacting
  → ready
  → recording
  → stopping
  → reviewing
  → previewing
  → applying
  → applied

Every state may transition to error or cancelled.
Navigation, iframe load, preview-epoch change, simulation change, and unmount cancel the session.
Only one of picking, recording, previewing, and applying may be active.
~~~

---

## 14. Technical contracts

### 14.1 ActionRecordingV1

The canonical IR is small, versioned, deterministic, and independent of rrweb and Puppeteer. Its
playback contract is a discriminated union, so an impossible combination such as
section-synchronous without an adapter cannot be represented:

~~~ts
type AdapterCapabilityV1 = "capture" | "apply" | "digest" | "restore" | "seek";

interface AdapterRefV1 {
  id: string;
  apiVersion: number;
  implementationHash: string;
  actionSchemaVersion: number;
  stateSchemaVersion: number;
  capabilities: AdapterCapabilityV1[];
}

type ReloadResetV1 = { kind: "reload-document" };
type AdapterResetV1 = { kind: "adapter-restore"; adapter: AdapterRefV1 };

type ExecutionPolicyV1 =
  | {
      kind: "final-state";
      reset: ReloadResetV1 | AdapterResetV1;
    }
  | {
      kind: "timeline-entry-relative";
      seek: { kind: "restart-on-seek" };
      reset: ReloadResetV1;
    }
  | {
      kind: "timeline-section-synchronous";
      seek: { kind: "adapter-seek"; adapter: AdapterRefV1 };
      reset: ReloadResetV1 | AdapterResetV1;
    };

interface FreshnessContractV1 {
  revisionId: string;
  packageHash: string;
  entryPath: string;
  environmentHash: string;
  baselineControlHash: string;
  crossDocumentState: "none" | "platform-namespaced-reset";
  determinism:
    | { kind: "not-claimed" }
    | { kind: "seeded"; seed: string; capabilityHash: string };
}

interface ExpectedEvidenceV1 {
  sourceRevisionId: string;
  sourcePackageHash: string;
  environmentHash: string;
  checkpoints: Array<{
    atMs: number;
    controlStateHash: string;
    adapterStateDigest?: string;
  }>;
}

interface ActionRecordingV1 {
  schemaVersion: 1;
  recorderVersion: string;
  recordingId: string;
  source: {
    simulationId: string;
    revisionId: string;
    packageHash: string;
    documentId: string;
    entryPath: string;
  };
  section: {
    sectionId: string;
    durationMs: number;
    execution: ExecutionPolicyV1;
  };
  environment: {
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    seed?: string;
  };
  baseline: ControlStateV1[];
  actions: ActionV1[];
  finalState: ControlStateV1[];
  freshness: FreshnessContractV1;
  expectedEvidence: ExpectedEvidenceV1;
  uiIntent: UiIntentV1;
  stats: {
    rawEvents: number;
    normalizedActions: number;
    coalesced: number;
    dropped: number;
    byteLength: number;
  };
}
~~~

If section-synchronous uses both adapter-seek and adapter-restore, both references must have the
same id and implementationHash. The compiler freezes ExecutionPolicyV1 into the plan; the parent
cannot choose reset or seek at runtime. Sort capabilities canonically, and require a method only
when its corresponding capability is declared.

Timestamps are integer milliseconds relative to a monotonic origin. Canonical order is atMs then
seq. Reject duplicate sequence numbers, negative time, NaN, Infinity, non-canonical or
out-of-range values, and final state that disagrees with the last action. The client normalizer may
clamp and quantize before constructing IR; the server never silently repairs submitted IR.

Hash scopes are deliberately separate. requestHash covers the authoritative HTTP command.
recordingHash covers normalized semantic recording while excluding recordingId, documentId,
stats, and transport details. planHash covers canonical ActionPlan plus sourcePackageHash,
compilerVersion, and executorVersion. artifactHash covers a canonical manifest of the exact bytes
published. sourcePackageHash is SHA-256 over path, byte hash, and size entries sorted by path,
before bridge modification. bridgeHash remains a separate hash of bridge.js for targeted
diagnostics.

The IR contains no DOM snapshot, HTML, stylesheet text, full innerText, screenshot, arbitrary
object, function, or custom-event payload. The server derives projectId and userId from the route
and authenticated session, never from the payload.

### 14.2 LocatorV1

~~~ts
interface LocatorV1 {
  id: string;
  root: "document";
  candidates: Array<{
    strategy: "sim-control" | "id" | "name" | "structural-css";
    value: string;
  }>;
  fingerprint: {
    tag: string;
    inputType?: string;
    role?: string;
    kind: "range" | "number" | "checkbox" | "radio" | "select" | "button";
    min?: number;
    max?: number;
    step?: number;
  };
}
~~~

Generation order:

1. A unique data-sim-control attribute, recommended for new simulations.
2. An id serialized with CSS.escape and proven to identify exactly one element.
3. A safely serialized name only when unique; a shared radio-group name is not a locator.
4. A structural CSS path anchored to a safe unique element, as the final fallback.
5. If no candidate is unique, mark the target unsupported instead of guessing.

At capture, preview, server canary, and runtime:

- parsing must not throw;
- querySelectorAll must produce exactly one result;
- capture must prove the result is the original target;
- the fingerprint must match;
- a miss or ambiguity reports locator id and action index.

V1 supports only the light DOM in the entry document. Shadow DOM, nested frames, cross-origin
frames, XPath, and ARIA locators require a separate root-chain resolver. Until that exists, they
fail explicitly and are never passed to document.querySelector.

Core contracts are closed unions rather than placeholders:

~~~ts
type DecimalStringV1 = string; // /^-?(0|[1-9]\d*)(\.\d+)?$/; no exponent or -0

type ControlValueV1 =
  | { type: "decimal"; value: DecimalStringV1 }
  | { type: "boolean"; value: boolean }
  | { type: "enum"; value: string };

interface ControlStateV1 {
  locatorId: string;
  controlKind: "range" | "number" | "checkbox" | "radio" | "select";
  value: ControlValueV1;
}

type ActionV1 =
  | { kind: "set-range" | "set-number"; locatorId: string; value: DecimalStringV1; atMs: number; seq: number }
  | { kind: "set-checked"; locatorId: string; value: boolean; atMs: number; seq: number }
  | { kind: "select-radio" | "select-option"; locatorId: string; value: string; atMs: number; seq: number }
  | { kind: "adapter-action"; locatorId: string; adapter: AdapterRefV1; payload: JsonValue; atMs: number; seq: number };

interface UiIntentV1 {
  derivationMode: "off" | "recording";
  scan: {
    scanId: string;
    sourceRevisionId: string;
    truncated: boolean;
    locatorIds: string[];
  };
  base: { showLocatorIds: string[]; hideLocatorIds: string[] };
  manualMarks: Array<{ locatorId: string; mark: "keep" | "hide" }>;
}

type ActionPlanV1 = {
  schemaVersion: 1;
  compilerVersion: string;
  executorVersion: string;
  sourcePackageHash: string;
  durationMs: number;
  execution: ExecutionPolicyV1;
  freshness: FreshnessContractV1;
  locators: LocatorV1[];
  baseline: ControlStateV1[];
  expectedEvidence: ExpectedEvidenceV1;
  uiIntent: UiIntentV1;
} & (
  | { mode: "final-state"; targetState: ControlStateV1[] }
  | { mode: "timeline"; actions: ActionV1[]; targetState: ControlStateV1[] }
);

interface PlanDiagnosticV1 {
  code: "locator_missing" | "locator_ambiguous" | "fingerprint_mismatch" |
    "baseline_mismatch" | "action_failed" | "deadline_exceeded" | "stale_epoch";
  severity: "warning" | "error";
  phase: "capture" | "preview" | "compile" | "proof" | "runtime";
  actionIndex?: number;
  locatorId?: string;
}
~~~

Parse DecimalStringV1 exactly, then validate bounds and step against the fingerprint. Canonically
sort lists and locators; reject duplicate ids, unknown keys, and adapter payloads outside their
pinned schema. A final-state plan stores baseline hash plus absolute target state for every
plan-owned control, not a partial diff. Before apply or reveal, compare baseline; one reset is
allowed, then fail visibly. Reject an unknown major version. Any future migration is a pure,
versioned server function that emits new canonical V1 and requires compile and proof again; there
is no silent runtime migration.

### 14.3 Supported action matrix

| Control/action | Capture | V1 replay | Restore | Notes |
|---|---:|---:|---:|---|
| range / number | Yes | Absolute setRange | Reload or adapter | input during track, one change at commit |
| checkbox | Yes | Absolute setChecked | Reload or adapter | Never replay as a toggle |
| radio | Yes | Absolute selectRadio | Reload or adapter | Locator identifies the option |
| select | Yes | Absolute selectOption | Reload or adapter | Value must name an existing option |
| generic text / textarea | No in V1 | No | — | Separate post-V1 opt-in only; artifact is public |
| password / file / hidden | Blocked | Blocked | — | Must never enter the log |
| generic button click | Touched only | Blocked | Not generic | Adapter required |
| pointer drag / canvas / WebGL | Diagnostic only | Blocked | Not generic | Coordinates are not state semantics |
| ARIA/custom widget | Diagnostic only | Blocked | Not generic | Semantic adapter required |

The executor uses a control-specific adapter, including the native property setter where needed,
and emits the exact event semantics for that control. It does not dispatch both input and change
for every keyframe. Synthetic events remain untrusted. If observable control state does not
converge during replay proof, the control is rejected. Internal state is not considered proven
without an adapter, and there is no silent click fallback.

Restoring value or checked proves only DOM state. It does not rewind particles, a physics
integrator, random state, canvas, or framework-owned application state. ActionPlanV1 therefore
uses ExecutionPolicyV1. Every AdapterRef carries an implementation hash and API/action/state
versions; adapter identity remains part of the plan even when reset itself is reload-document.

reload-document is the default for every generic plan. The player cancels the scheduler
immediately, keeps the outgoing frame covered through the fade, then loads a new document before
re-entry. A new documentId is necessary but does not prove pristine state; FreshnessContractV1
and baseline hash are the precondition. Only an adapter that passes restore proof may request
in-place cleanup.

Future extension contract:

~~~ts
interface AdapterCallContextV1 {
  signal: AbortSignal;
  deadlineMs: number;
  epoch: number;
}

interface SimRecordingAdapterV1 {
  ref: AdapterRefV1;
  describeTarget(element: Element): AdapterCapability | null;
  capture(event: Event): TypedAdapterAction | null;
  snapshot?(ctx: AdapterCallContextV1): Promise<{ state: JsonValue; stateDigest: string }>;
  apply?(action: TypedAdapterAction, ctx: AdapterCallContextV1): Promise<{ stateDigest?: string }>;
  restore?(input: { baseline: JsonValue }, ctx: AdapterCallContextV1): Promise<{ stateDigest: string }>;
  seek?(
    input: { actions: TypedAdapterAction[]; targetOffsetMs: number; baseline: JsonValue },
    ctx: AdapterCallContextV1
  ): Promise<{ stateDigest: string }>;
}
~~~

The adapter declares a schema and limits. Arbitrary callbacks and JavaScript never enter the IR.
Generic click remains blocked even with reload-document: reload solves cleanup but does not prove
that an untrusted synthetic click performed the intended semantic action. It becomes eligible only
with proven apply and semantic digest behavior; restore and seek are required only by policies
that declare them. seek is absolute and idempotent from baseline to targetOffsetMs in both
directions. Every asynchronous operation receives AbortSignal and a deadline; timeout cancels it,
and a result after cancellation or a newer epoch is discarded.

V1 semantic validation accepts only platform-owned, signed/allowlisted adapters pinned by
implementationHash. A digest reported solely by package code is package-declared evidence and
cannot set runtimeValidated. expectedEvidence is bound to source revision, environment, and an
authoring checkpoint, then recomputed by the trusted adapter on the server. An independent visual
oracle is a separate future capability. If added, raw screenshots are ephemeral and masked; the
artifact retains only a hash, tolerance, and environment contract, never pixels in logs.

### 14.4 Timeline normalization

- Continuous input is sampled at no more than 20Hz per locator; retain the last value in each
  50ms bucket.
- Always retain the first sample, final sample, and range direction changes.
- Deduplicate identical adjacent writes; preserve sequence order at equal timestamps.
- Final-state review may display a diff, but the plan encodes absolute target state for every
  plan-owned control plus baseline hash.
- Timeline mode stores explicit leading and trailing trim. If the recording is longer than the
  section, require the author to trim, extend the section, or cancel. Never clip silently.
- Mode is an author choice. A heuristic may suggest a mode but cannot decide it.

Before IR construction, numeric values are clamped to min/max and quantized to step. The server
verifies that submitted values are already canonical and match final state; it rejects rather
than silently changing meaning. Normalization and serialization are pure functions with golden
tests, so identical IR and a compiler version produce identical bytes and hashes.

### 14.5 Clock, pause, resume, and seek

Two capability levels are required. Otherwise the design promises seek behavior that a generic
simulation cannot deliver:

1. **Entry-relative, the generic V1 default.** During uninterrupted playback, the recording is
   synchronized to media progress since activation. Pause, resume, and rate are supported. A seek
   or re-entry creates a pristine document and restarts the recording at t=0. This is a visible
   product limitation, but its semantics are truthful.
2. **Section-synchronous, adapter only.** Entering or seeking to a mid-section offset requires an
   adapter that implements seek and returns the expected stateDigest. Without that adapter, the
   last slider write cannot reconstruct accumulated physics state.

The parent player owns time and sends:

~~~ts
interface TimelineClockSyncV1 {
  epoch: number;
  seq: number;
  sectionOffsetMs: number;
  activationOriginOffsetMs: number;
  running: boolean;
  playbackRate: number;
}
~~~

- Entry-relative logical time is
  `clamp(sectionOffsetMs - activationOriginOffsetMs, 0, recordingDurationMs)`.
  Section-synchronous time is `clamp(sectionOffsetMs, 0, recordingDurationMs)`. Final-state does
  not consume a clock.
- Send the initial position with PREPARE_SECTION in v3 or startScript in v2, before acknowledgement
  and reveal. Send further sync on play, pause, seek, rate change, and periodic drift correction.
- Parent and child never assume their performance.now clocks share an origin. At receipt the child
  samples its local clock and extrapolates from the received media position and rate. A parent
  timestamp, if retained for telemetry, is never subtracted from child time without calibration.
- Increment epoch only for a real seek, re-entry, reset, or discontinuity; increment seq for every
  message. Reject old epoch/seq, non-finite or policy-out-of-range positions/rates, and backward
  position without a new epoch. The action cursor never retreats within an epoch. Slew small drift
  within a measured threshold; for a large forward correction, snap and drain due actions once.
  Small correction neither reloads nor replays an action.
- The clock is activation-scoped but is not presentation policy, does not belong in
  SimPresentationConfig, and must not enter configHash. Reset and seek come only from the frozen
  ExecutionPolicyV1; a message that tries to choose another policy is a protocol error.
- One scheduler owns one cursor and one handle. It computes logical time, drains due actions, and
  schedules only the next deadline. It uses ManagedScopeHandle in v3; the single v2 handle is
  explicitly registered as automation rather than mixed with simulation-engine timers.
- Pause cancels the handle without advancing logical time; resume uses the remaining logical delay.
- Under restart-on-seek, a discontinuity cancels activation and starts exactly one reset
  generation. Under adapter-seek, the parent keeps cover until CLOCK_APPLIED returns the matching
  epoch and digest. Timeout or digest mismatch is explicit failure.
- Export uses the same coordinator with a virtual clock and pauses at every readiness barrier.
- autoScript=false disables every recorded action, including final-state. Show/hide UI remains a
  separate policy. If final-state must later apply while automation is disabled, add an explicit
  policy and update UI, shared types, and identity hashing.

Use one lifecycle to prevent double navigation and dirty-document reveal:

~~~text
activation becomes dirty
→ exit/seek: cover + cancel scheduler/adapter + increment epoch
→ create or join exactly one reset generation
→ real navigation/remount
→ matching READY(documentId, revisionId, generation)
→ PAINTED
→ PREPARE_SECTION
→ ACTION_PLAN_READY (and CLOCK_APPLIED when required)
→ re-check freshness/baseline
→ reveal/activate
~~~

A re-entry arriving during reset joins that generation rather than navigating again. Assigning the
same src is insufficient; force a real remount/navigation with an internal generation key or
reserved nonce. The nonce never enters package/plan identity and must not affect simulation
semantics. Every barrier has a deadline, a bounded retry of the same artifact, and fail-closed
poster/error fallback; never reveal the previous dirty document.

FreshnessContractV1 requires matching revision/package/entry/environment and a fresh baseline hash
before reveal. localStorage, IndexedDB, cookies, service workers, and server side effects must be
irrelevant or reset through a platform-owned namespace. A new documentId alone is insufficient.
A seed is a proven capability, not an optional field that implies determinism. Generic prewarm is
allowed only after idle-stability proof across the prewarm interval; otherwise Phase 2 performs a
covered cold reload near entry. adapter-restore must return the baseline digest; a plan that
contradicts its policy is not managed.

Existing acknowledgement semantics remain intact: SCRIPT_APPLIED means synchronous setup is
applied and the plan is installed, not that future steps completed. Additional diagnostics are
ACTION_PLAN_READY, ACTION_STEP_ERROR, and ACTION_PLAN_COMPLETE; seekable mode also emits
CLOCK_APPLIED. Every diagnostic is scoped to the current activation id or token and clock epoch.

### 14.6 Authoring transport

After READY from a new document, the parent creates a MessageChannel and transfers one port with
an exact targetOrigin. The bootstrap verifies source, allowed parent origin, protocol, documentId,
and source revision before accepting the port.

~~~ts
interface AuthoringEnvelopeV1<T> {
  namespace: "flowvid.sim-authoring";
  protocolVersion: 1;
  sessionId: string;
  documentId: string;
  revisionId: string;
  seq: number;
  type: string;
  payload: T;
}
~~~

Message types: CAPABILITIES, CONNECT, CONNECTED, START_PICK, STOP_PICK, START_RECORDING,
STARTED, EVENT_BATCH, STOP_RECORDING, STOPPED, CANCEL, ACK, and ERROR.

START and STOP are idempotent. STOPPED reports lastSeq, rawEventCount,
normalizedCandidateCount, byteLength, coalescedCount, droppedCount, and reason. The number of
unacknowledged batches is bounded. Overflow terminates with a visible error instead of silently
truncating the recording.

Initial limits to validate empirically:

| Limit | Proposed V1 value |
|---|---:|
| Recording duration | 180 seconds |
| Raw semantic events | 5,000 |
| Normalized actions | 1,000 |
| Canonical IR | 512KiB |
| Batch | Up to 64 events or 64KiB |
| Flush interval | At most 50ms |
| Unacknowledged batches | 4 |
| Locator | 512 bytes |
| Enum/select value | 128 bytes |
| Active plans per simulation revision | 32 |
| Total decoded plans per revision | 2MiB |
| Encoded plan assets / bridge overhead | 2.75MiB |
| Package growth from recordings | 4MiB |
| Compile CPU | 2 seconds per request |
| Proof wall clock | 60 seconds per candidate, including two runs |

Enforce aggregate caps before publication, not only per section. If measurements show that a
shared bridge exceeds dormant parse budget, store immutable per-section plan assets with hashes
and load them from the same revision only during PREPARE_SECTION; they remain part of the
offline/export closure. Max sections, candidate/package bytes, decoded bytes, CPU, memory, PIDs,
and wall clock are hard limits with stable failures, not telemetry only. These numbers are initial
guardrails that Phase 0 must validate and tune before launch.

Simulation code and the bootstrap share a realm, so sessionId is not a cryptographic boundary
against a malicious package. It prevents races, stale-document events, and protocol drift. Server
validation and compilation are the actual trust boundary.

### 14.7 Visual picker and tri-state

Do not use double-click: a browser emits click before dblclick, producing timing-dependent
intermediate state. Use a toolbar with four explicit modes:

- Interact, Keep visible, Hide, and Clear mark;
- green plus icon and text for Keep; red plus icon and text for Hide, never color alone;
- Escape, Undo, keyboard support, and the existing list as an accessible fallback;
- Interact lets the author open an Advanced panel before returning to a pick mode;
- hidden and off-screen controls remain selectable from the list.

Tri-state semantics depend on derivationMode:

~~~text
Auto = no manual override
Keep = manual visible override
Hide = manual hidden override

manual Hide > manual Keep > derivation policy > base selection
~~~

UiIntentV1 stores derivationMode as off or recording, the base selection on entry,
scanId/sourceRevision/truncated, and manualMarks by locator id.

When derivationMode is off, Auto preserves the prior selection. For base show/hide BS/BH:

~~~text
effectiveShow = (BS union G) minus R
effectiveHide = (BH union R) minus G
~~~

Only after the author explicitly accepts Apply recording suggestion does derivationMode become
recording. For scanned controls C, touched controls T, green marks G, and red marks R:

~~~text
effectiveShow = (G union (T intersect C)) minus R
effectiveHide = (C minus effectiveShow) union R
~~~

The server rejects foreign marks, duplicates, and overlap. If a scan is truncated or stale,
derivationMode falls back to off; do not auto-hide the remainder. Show a partial suggestion, and
leave controls absent from the scan unaffected.

### 14.8 Privacy and security

- Raw capture remains in editor memory and is erased on cancel, navigation, unmount, or only after
  a successful Apply acknowledgement. A timeout or lost response does not destroy work; retry uses
  the same Idempotency-Key, or the author explicitly discards it. Raw capture never enters logs.
- The server receives normalized IR only. The default is not to persist a draft. If drafts are
  enabled, Phase 0 must name the actual at-rest encryption layer, KMS/key ownership, TTL, and
  deletion behavior rather than promise vague "encryption under policy."
- Password, file, hidden, contenteditable, and free-text inputs are blocked in V1.
- A type allowlist is not a sensitivity allowlist. Every control requires an explicit
  public-artifact-safe opt-in in trusted project metadata, and Review confirms the entire public
  diff: locators, action kinds, timestamps, metadata, and every value. Enum and number values are
  not intrinsically safe.
- uiIntent submits locator ids rather than free-form selector strings. Only the server derives
  hideSelectors from generated, parsed, uniqueness-proven locators; the boot fragment receives
  only that validated list.
- Canonical plan JSON is base64url-encoded before insertion into a section entry. A recorded value
  cannot close a section marker, corrupt parsing, or trigger validator regex text. base64url is
  safe encoding, not confidentiality.
- The executor is fixed system code. No eval, Function, HTML insertion, or selector-from-value.
- Exact targetOrigin, an allowed parent origin, and MessagePort replace wildcard messaging for
  authoring.
- Apply rate limits and request-body limits before deep schema parsing.
- Logs and metrics contain counts, hashes, and error codes only, never selectors, labels, or values.

---

## 15. Backend, persistence, and publication

### 15.1 New apply endpoint

~~~text
POST /api/v1/projects/:projectId/sections/:sectionId/action-recordings/apply
Idempotency-Key: <uuid>
~~~

Request body:

~~~ts
{
  recording: ActionRecordingV1;
}
~~~

The endpoint never accepts bridgeBody or duplicate sources of truth. projectId and sectionId come
from the route; revision, package, and UI intent occur once inside recording and are compared with
the server snapshot. simulationId and sectionId in IR must match the loaded relationship, or the
request fails. Processing order:

1. authenticate, authorize project editing, and enforce body size before deep parsing;
2. validate schema, construct the authoritative command from route plus recording, calculate
   requestHash, and claim an idempotency row in received state;
3. read a short snapshot without a long-held lock: project/section/simulation, sectionVersion,
   duration, active revision, and sourcePackageHash;
4. verify all source, freshness, section, and environment identities against that snapshot;
5. calculate recordingHash, enter compiling, compile ActionPlanV1, and only then calculate
   planHash;
6. run static plan validation and enforce per-plan and aggregate candidate-package caps;
7. stage exact bytes in a private proof_pending state, persist artifactHash, and enter proving;
8. run isolated replay proof on those bytes. If it exceeds the synchronous budget, return 202 with
   recordingId and a status URL and continue as a job; never publish in order to test afterward;
9. re-read all fences before activation. In the transaction hook, perform revision CAS plus a
   conditional timeline_sections update by id, project, simulation, sectionVersion, and duration;
   update the recording result and sim_meta in the same transaction;
10. persist the terminal response status/body and return revisionId, sectionUrl, artifactHash,
    bridgeHash, planHash, and diagnostics.

Stable failures:

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | invalid_recording | Schema or canonicalization failure |
| 403 | forbidden | No edit permission |
| 409 | stale_recording | Revision, package, or section changed |
| 409 | idempotency_conflict | Same key with a different body |
| 413 | recording_too_large | Byte, event, or duration limit |
| 422 | unsupported_action | Unsupported control, locator, or lifecycle |
| 422 | replay_mismatch | Preview or canary did not reach expected state |
| 409 | publication_conflict | Revision or section fence changed; V1 does not rebase |
| 503 | proof_unavailable | Isolated runner unavailable; candidate remains private |

### 15.2 Source fencing, CAS, and idempotency

The existing CAS protects against a change during the build. It does not detect a recording made
against a revision that was already stale before the request began. sourceRevisionId is therefore
a separate mandatory fence. V1 returns 409 for any drift. A later phase may attempt one rebase only
when a user-content hash that excludes the platform bridge is unchanged.

Claim idempotency with requestHash before compile; planHash does not exist at that point. The row
transitions received → compiling → staged → proving → activating → applied/failed and stores
leaseOwner, leaseExpiresAt, attemptCount, and updatedAt. A dead worker leaves an expiring lease;
another worker may resume only the same command, source fence, and artifact hash.

- the same Idempotency-Key with a different requestHash returns 409;
- retry of a terminal row returns the exact stored responseHttpStatus and responseJson; never
  reconstruct it from active sim_meta, which may have changed later;
- retry of an active row returns 202/status or waits for a bounded interval; it never starts a
  second build;
- cross-worker safety relies on database uniqueness, a lease, and revision CAS, not an in-memory
  lock;
- V1 never retries on a newer active revision, even when another section published. CAS/section
  drift is terminal 409; a future rebase requires an explicit user-content hash and merge contract;
- infrastructure retry is allowed only for the same immutable candidate under identical fences;
- pre-activation failure leaves a private artifact for TTL/GC; transaction failure preserves the
  active section and stores an idempotent failure response.

### 15.3 Persistence

Store the private normalized plan in a dedicated table rather than expanding sim_meta:

~~~sql
sim_action_recordings (
  id uuid primary key,
  project_id uuid not null,
  section_id uuid not null,
  simulation_id uuid not null,
  created_by uuid not null,
  source_revision_id uuid not null,
  source_package_hash text not null,
  section_version bigint not null,
  schema_version integer not null,
  compiler_version text not null,
  execution_kind text not null,
  source_recording jsonb not null,
  recording_hash text not null,
  plan jsonb,
  plan_hash text,
  idempotency_key text not null,
  request_hash text not null,
  status text not null,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  published_revision_id uuid,
  bridge_hash text,
  artifact_hash text,
  proof_artifact_hash text,
  failure_code text,
  response_http_status integer,
  response_json jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  applied_at timestamptz
)
~~~

Constraints and policy:

- unique project_id plus idempotency_key;
- index section_id plus created_at;
- checks for state transitions and execution_kind; plan and plan_hash are null only before compile;
- a partial lease_expires_at index supports recovery, and status plus updated_at supports GC;
- project/section deletion and audit behavior follow one explicit retention policy in both languages;
- source_recording and plan contain normalized typed data only, never rrweb or HTML. Store both so
  editing loads semantic source and recompilation never reverse-engineers an artifact;
- unapplied drafts receive a TTL; an applied recording remains editable and auditable while its
  section exists.

sim_meta remains compact provenance:

~~~ts
{
  planVersion: "8",
  generatedBy: "recording",
  recordingId: string,
  recordingHash: string,
  recordingSchemaVersion: 1,
  compilerVersion: string,
  sourceRevisionId: string,
  sourcePackageHash: string,
  execution: ExecutionPolicyV1,
  durationMs: number,
  actionCount: number,
  artifactHash: string,
  warnings: string[],
  validationLevel: "static" | "structural" | "semantic",
  runtimeValidated: boolean,
  uiControls: SimUiSelection,
  uiIntent: UiIntentV1
}
~~~

Update the shared/generated SimMeta type and simMetaShape tests. Set runtimeValidated to true only
when validationLevel is semantic and browser proof matches expected digest from a pinned,
allowlisted platform adapter. DOM-only structural proof does not receive that label; a future
visual proof is a separate level rather than semantic.

### 15.4 Compiler and runtime artifact

The compiler does not generate a free-form JavaScript sequence. It:

1. validates and normalizes ActionRecordingV1;
2. creates setup, baseline, timeline, checkpoints, and a locator table;
3. base64url-encodes canonical ActionPlanV1;
4. binds it to a fixed system executor;
5. creates a locator/action contract for SavedBridgeService and canary;
6. returns deterministic bytes and a hash.

The section body is logically minimal:

~~~js
return window.__SIM_ACTION_PLAN_V1__.run(params, encodedPlan);
~~~

The server emits that function from fixed reviewed source; encodedPlan is never concatenated as
code. A new validator checks schema, executor version, marker safety, decoded byte caps, and the
locator contract. validateGeneratedBridge remains a regression layer, not semantic proof.

When a saved bridge originates from a recording, persist its recording id and plan. Applying it to
a different target must re-check LocatorContract; a regex that only discovers getElementById calls
cannot validate the short executor body.

### 15.5 Runtime proof before activation

Distinguish proof levels:

- **static:** schema, limits, contract, and executor version only;
- **structural:** locator resolved, action adapter ran, expected control state, no errors or leaks;
- **semantic:** adapter stateDigest or a stable visual checkpoint also proves simulation state.

Minimum proof in a fresh document:

1. resolve every locator and verify uniqueness and fingerprint;
2. capture baseline and an adapter stateDigest when available;
3. run final-state or virtual-timeline checkpoints;
4. compare expected control state and diagnostics; semantic proof also compares digest/checkpoint;
5. clean up: verify baseline digest in adapter mode, or verify a new pristine documentId in reload
   mode;
6. run a second time to prove repeatability at the declared proof level;
7. verify no timer, listener, or overlay leaks and no delayed SCRIPT_ERROR.

Run this against staged bytes through an authenticated internal harness or a local staging server.
The current state machine needs a refactor: validate advances a candidate to canary_passed, and
that status is publicly served today. Add non-public proof_pending/proof_passed states, or keep the
row in validating through proof and move canary loading to the internal harness. Only active may
make a newly staged candidate public. Do not weaken the publication gate for proof.

Phase 0 must measure cost and latency. If synchronous p95 is not acceptable, initial release
remains canary-only with post-stage proof and automatic rollback. Structural proof may approve
native actions under reload-document, but runtimeValidated remains false. Generic buttons and
adapter claims require semantic proof.

---

## 16. Build plan, verification, and rollout

### Phase 0 — blocking ADRs and spikes

- Record the selected semantics in an ADR: reload-document and entry-relative by default;
  adapter-restore and section-synchronous only with a proven capability.
- Build fixtures for vanilla controls, React-controlled inputs, DOM replacement, special and
  duplicate ids, radio groups, hidden Advanced panels, and unsupported canvas.
- Prove serve-time bootstrap behavior on old and new revisions, in local and cloud storage paths.
- Design and implement a non-public proof state; current canary_passed is unsuitable because it is
  publicly served.
- Prove the scheduler against a fake clock: pause, resume, rate, generic restart-on-seek, and
  adapter seek.
- Measure fresh-document proof, publication cost, and dormant-bootstrap overhead.
- Finalize schemas, limits, privacy, TTL, and license process.
- Exit criterion: approved ADR, passing golden fixtures, and no generic click in the support matrix.

### Phase 1 — visual picker behind a feature flag

- authoring bootstrap and SimAuthoringClient with capability and session identity;
- LocatorV1 with escaping, uniqueness, and fingerprint;
- Interact / Keep / Hide, Undo, Escape, keyboard operation, and list fallback;
- persistent tri-state and effective show/hide derivation;
- scan truncation and staleness warnings;
- telemetry without selectors or values;
- complete checkbox-list fallback when the capability is absent.

This phase is independently useful. It changes contracts and tests, although it needs no new
database column or dependency.

### Phase 2 — full recording vertical slice

- fresh pristine authoring session;
- semantic capture for range, number, checkbox, radio, and select;
- baseline, final state, normalization, and review UI;
- explicit Final state versus Replay timing choice;
- two-pass local replay with diagnostics;
- ActionRecordingV1, endpoint, database row, server compiler, and fixed executor;
- source fence, idempotency, and atomic publication;
- player/export clock sync; generic timelines are entry-relative and restart on seek;
- candidate staging and structural fresh-document proof before activation;
- player resetPolicy support: covered reload after exit and prewarm before re-entry;
- provenance and observability.

Do not release a recorder-only milestone that produces an unusable log. Enable the feature only
when Record → Review → Preview → Apply → Viewer/Export works end to end.

### Phase 3 — hardening and rollout

- proof-harness hardening, validation levels, and latency budgets;
- multi-worker concurrency, lost-response retry, and rollback;
- canary allowlists for simulations and projects;
- performance budgets and kill switch;
- Save Bridge and project-duplication integration;
- dashboards for failure codes, selector drift, and publication latency.

### Phase 4 — adapters and interoperability

- SimRecordingAdapterV1 for known simulations;
- separate decisions for canvas/WebGL, shadow roots, and same-origin frames;
- cross-origin frames remain unsupported pending a separate threat model;
- Chrome DevTools UserFlow import/export adapter;
- lazy rrweb experiment only if telemetry demonstrates missing context that semantic capture
  cannot provide.

### Phase 5 — LLM polish

The model receives a normalized plan and returns PlanPatchV1 only, such as trim, duration scale,
easing, or sampling density. It cannot change a locator, add an arbitrary action, or return
JavaScript. Validate the patch, recompile, and rerun replay proof. Measure actual input, cached
input, and output tokens. Keep the source-aware generation path as an explicit fallback only for
requests that cannot be represented in the IR.

### 16.1 Required acceptance matrix

| Area | Acceptance coverage |
|---|---|
| IR | Version, canonical order, same input → same bytes/hash, NaN and overflow rejection |
| Locator | Colon/space/digit id, quoted name, duplicate id, radio name, stale DOM, ambiguity |
| Capture | Trusted user events only, composedPath target, input/change dedupe, iframe remount |
| Normalize | First/final/turning points, per-control rate, equal-time order, final-state diff |
| Runtime | Native and React range/checkbox/radio/select, missing locator error, no duplicate events |
| Clock | autoScript=false, five-second pause, remaining delay, rate, restart-on-seek, adapter seek |
| Cleanup | Cancel future work, new document for reload policy, adapter digest restore, no leaks |
| Transport | Duplicate START/STOP, old document, wrong origin/session, sequence gap, overflow |
| API | Authorization, relationship checks, 413 limits, stale 409, idempotency conflict |
| Concurrency | Two workers, competing publication, lost response, same revision returned on retry |
| Privacy | Sensitive input absent, no raw data in logs, only allowlisted public values |
| Picker | Interact/Pick, hidden-control fallback, keyboard, non-color cues, truncated scan |
| Publication | Proof candidate is publicly 404; staged failure keeps prior active revision; atomic failure preserves section |
| E2E | Record → preview → apply → viewer; export clock produces identical checkpoints |
| Performance | Dormant overhead, active handler latency, 60fps DOM churn, publication bytes/latency |

### 16.2 Observability

Measure:

- authoring connection, start, stop, cancel, and terminal reason;
- duration, raw and normalized counts, bytes, coalescing ratio, and overflow;
- locator missing, ambiguity, and fingerprint mismatch grouped only by action kind;
- preview mismatch and restore failure;
- validation, compilation, proof, and publication latency separately;
- revision bytes read, reused, and written, CAS conflicts, retries, and idempotent responses;
- runtime action errors, seek rebuilds, and clock drift;
- viewer bootstrap bytes, parse cost, and frame-time regression;
- model input, cached input, and output tokens only on the LLM path.

Do not place project ids, selectors, labels, or values in metric labels. A short hash may appear in
secure logs only for correlation.

Proposed launch gates to validate in canary:

- 100% golden determinism and lifecycle/cleanup fixtures;
- zero secret or text leakage in artifact and logging tests;
- dormant bootstrap at or below 5KB gzip with no active observer before ARM;
- less than 1% viewer frame-time regression in the sampled cohort;
- capture-handler p95 below 2ms on fixtures;
- greater than 99% Apply success for controls classified as supported;
- selector misses below 0.5% in canary;
- rollback to the prior revision in under five minutes.

### 16.3 Rollout and rollback

1. Deploy the bootstrap capability while parent UI remains disabled.
2. Verify no viewer regression and correct capability responses from existing revisions.
3. Enable the picker for internal projects.
4. Enable the recording vertical slice for an allowlist of standard-control simulations.
5. Expand based on measured success, not a calendar date.
6. A parent-side kill switch prevents ARM while the dormant bootstrap remains harmless.
7. A serious runtime failure stops rollout and restores the section to its prior active revision.
8. Do not run a mass rebuild; serve-time injection removes the need for risky backfill.

### 16.4 Risk register

| Risk | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Locator points to a different control after replacement | High | Revision fence, uniqueness, fingerprint, canary | Dynamic change within one revision |
| Click mutates internal state or needs trusted activation | Critical | Block in V1; proven semantic adapter only | Narrower feature coverage |
| Replay drifts after seek or stall | Critical | Restart on seek by default; adapter seek and export clock | User-visible restart |
| Sensitive value becomes public | Critical | Type allowlist, text block, artifact tests | An enum value may still be business data |
| Two workers publish concurrently | High | DB idempotency, source fence, revision CAS | Retry latency |
| Malicious package forges authoring data | High | Channel identity, server validation, canary | Same realm is not isolation |
| Bootstrap regresses every viewer | High | Inert injection, budgets, kill switch | Small fixed byte cost |
| Partial scan hides an important control | High | Truncation warning, no auto-hide remainder | Author error |
| Browser proof is slow | Medium | Phase-0 spike, bounded pooling, staged canary | Apply latency |
| Dependency or license drift | Medium | Dependency-free V1; exact pins and notices later | SBOM maintenance |

---

## 17. Decisions before implementation

### Fixed by this review

- MVP uses a semantic recorder and does not use rrweb.
- ActionRecordingV1 is canonical; Puppeteer UserFlow is an adapter only.
- The client never creates or submits JavaScript.
- V1 supports absolute native-control operations with reload-document by default; it does not
  claim that restoring DOM state rewinds internal state.
- Final state and timeline are explicit author choices.
- Generic timed replay follows media during uninterrupted playback and supports pause, resume,
  rate, and export; seek restarts it. Section-synchronous seek requires a proven adapter.
- Generic click, canvas, custom widgets, shadow DOM, and frames require an adapter.
- Preview does not publish; one explicit Apply publishes.
- Raw capture is ephemeral, the normalized plan is private, and the published artifact contains
  allowlisted values only.
- The visual picker uses Interact / Keep / Hide plus a list fallback.
- Hide-the-rest is an editable suggestion, not an irreversible automatic decision.
- An LLM may return a typed patch only.

### Measurements required in Phase 0

1. Whether fresh-document proof fits the acceptable synchronous Apply p95.
2. The exact dormant and active bootstrap budgets on a low-end device.
3. Draft-recording TTL and deletion policy after section deletion.
4. The cost of reload-document, prewarm strategy, and re-entry latency.
5. The source-content hash definition that can support a safe future rebase.

### Final recommendation

Do not begin with the original Phases B–D. Start with a short Phase 0 and the hardened picker, then
build one real vertical slice against representative simulation fixtures:

~~~text
serve-time inert bootstrap
→ versioned MessageChannel
→ semantic typed recording
→ local deterministic preview
→ authenticated IR-only endpoint
→ server-side fixed executor plan
→ fresh-document proof
→ revision CAS and atomic provenance
→ media-clock-synchronized runtime
~~~

This preserves the original idea's benefits—visual authoring, major LLM savings, and
determinism—without turning raw session replay into public executable code, accepting silent
selector failures, or violating the viewer's existing pause, seek, and cleanup contracts.
