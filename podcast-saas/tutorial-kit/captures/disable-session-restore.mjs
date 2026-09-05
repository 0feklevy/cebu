// Stop the capture profile from restoring the previous shot's tabs.
//
// Why this exists: a restored tab paints into the same browser-window surface that Playwright's
// screencast records, so takes came back with an earlier shot's editor ghosted under the page being
// driven (double "Ask!" buttons, "No videos yet" over the film). Closing the tabs in the driver was
// not enough — restore happens before we can sweep. Chrome's own preference settles it.
//
//   node disable-session-restore.mjs
//
// Writes captures/chrome-profile/Default/Preferences with:
//   session.restore_on_startup = 5   (5 = open the New Tab page, i.e. restore nothing)
//   session.startup_urls       = []
//   profile.exit_type          = "Normal" / exited_cleanly = true  (no "restore pages?" bubble)
// A .bak copy is written next to it the first time.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFS = join(HERE, 'chrome-profile', 'Default', 'Preferences');
if (!existsSync(PREFS)) { console.error(`no Preferences at ${PREFS} — launch the profile once first`); process.exit(1); }
if (!existsSync(`${PREFS}.bak`)) copyFileSync(PREFS, `${PREFS}.bak`);

const prefs = JSON.parse(readFileSync(PREFS, 'utf8'));
prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5, startup_urls: [] };
prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
writeFileSync(PREFS, JSON.stringify(prefs));
console.log('session.restore_on_startup =', prefs.session.restore_on_startup, '· startup_urls =', JSON.stringify(prefs.session.startup_urls));
console.log('profile.exit_type =', prefs.profile.exit_type);
console.log('backup:', `${PREFS}.bak`);
