export * from './types/errors.js';
export * from './types/host.js';
export * from './types/corpus.js';
export * from './types/project.js';
export * from './types/course.js';
export * from './types/course-view.js';
export * from './types/library-view.js';
export * from './types/podcast.js';
export * from './types/podcastStudio.js';
// What a timeline_sections row IS — one classifier, one canonical order, one rule set, shared by
// the player build and the write endpoints so the two cannot drift apart again.
export * from './timeline/sectionShape.js';
// WHERE a section sits on the global timeline — ONE resolver for the editor, the viewer, the
// export planner and the prewarm/marker maths, so "what second is this at?" cannot be answered
// four ways again (D-01).
export * from './timeline/placement.js';

// What a viewer is told when an avatar call is refused (D-14).
export * from './avatar/denial.js';
// WHAT A CHANGE TO A VIDEO DOES to the rows placed against it (D-01b): a duration correction
// rewrites nothing, a media replace raises an impact review instead of clamping the authored
// window, and a delete lists its dependents and refuses to choose for the author.
export * from './timeline/hostChange.js';
// WHICH overlay is on top when two cover the same instant — the one rule the viewer and the export
// both call, after each having invented a different one (broll-player-002).
export * from './timeline/overlayStack.js';

// The audio edition's status vocabulary. Exported from the index because BOTH sides need it and
// the bug it exists to prevent was precisely the two sides each keeping their own list.
export * from './audio/editionStatus.js';

// Whether a project is portrait — ONE derived truth for the editor preview, the HLS ladder, the
// export grid, the crop skip and the poster identity, so none of them can disagree (night run
// 2026-09-03 §3).
export * from './video/orientation.js';

// The listener page's wire contract (car mode, night run 2026-09-03 §4): the public audio view,
// the typed answer and the spoken answer — one definition for the server's replies and the
// client's parsers, where before each side kept its own copy.
export * from './audio/listener.js';
