/**
 * The walkthroughs — what the "?" says, in the order that matters (night run 2026-09-03 §5).
 *
 * Ordered by what a creator needs first: getting media in, making a moment interactive, laying
 * it out, sharing it, exporting it, then the settings, the avatar, and the keys. Every step names
 * a `TourAnchor`, so a step pointing at nothing is a compile error rather than a silent skip.
 * Copy is kept short and concrete; a tour that reads like documentation is closed on step two.
 */
import { tourSelector, type TourAnchor } from './anchors';
import type { TourStep } from '@/components/GuidedTour';

export interface Step {
  anchor: TourAnchor;
  title: string;
  body: string;
}

/** The shape `GuidedTour` renders. */
export function toTourSteps(steps: readonly Step[]): TourStep[] {
  return steps.map((s) => ({ selector: tourSelector(s.anchor), title: s.title, content: s.body }));
}

// ── The editor — the primary "?" ─────────────────────────────────────────────────────────────

export const EDITOR_STEPS: readonly Step[] = [
  {
    anchor: 'library',
    title: 'Your Library',
    body: 'Add videos, images and audio here — or drag files straight onto the panel. A video can be replaced later without losing what you built on it; the same file is never stored twice.',
  },
  {
    anchor: 'simulations',
    title: 'Interactive simulations',
    body: 'Upload one, generate one with AI, or press Import to browse every simulation from your other projects — with previews, search and multi-select. Then drop it onto the timeline.',
  },
  {
    anchor: 'timeline',
    title: 'The timeline',
    body: 'Lay out sections where a simulation, b-roll, image or audio plays over the video. Double-click the ruler to drop a flag with a note; the Music / SFX track holds generated or uploaded audio.',
  },
  {
    anchor: 'branching',
    title: 'Follow user decisions',
    body: 'Branch the video on viewer choices: a question at a point you pick sends each viewer down their own path, and the paths rejoin where you say. Draw the graph here and see which way viewers actually went.',
  },
  {
    anchor: 'preview',
    title: 'Preview',
    body: 'Watch it exactly as viewers will, in the frame your video has — a vertical video stays vertical everywhere, including the export. Space plays and pauses, ← → skip five seconds, ? lists every key.',
  },
  {
    anchor: 'share',
    title: 'Share: three addresses',
    body: 'One project, three public pages: the video, its Library of materials, and the podcast — a hands-free audio version listeners interrupt out loud to ask a question and hear the answer spoken back. Press “Create podcast” once the video is public. Group public videos into a playlist.',
  },
  {
    anchor: 'export',
    title: 'Export the video',
    body: 'Render the whole thing — simulations included — to one MP4 at 1920×1080, or 1080×1920 for a vertical project. Progress is shown here; the file downloads when it is done.',
  },
];

// ── The home page ─────────────────────────────────────────────────────────────────────────────

export const HOME_STEPS: readonly Step[] = [
  {
    anchor: 'home-projects',
    title: 'Your projects',
    body: 'Every project you own or were invited to. Open one to edit it, duplicate one to start from what you already built, or search by title.',
  },
  {
    anchor: 'home-playlists',
    title: 'Playlists',
    body: 'Group public videos into a playlist: one address that plays them in order. Viewers who finish one video are offered the next — and “Publish as course” in the playlist editor turns the same videos into a course of lessons at /c/….',
  },
];

// ── Project settings ──────────────────────────────────────────────────────────────────────────

export const SETTINGS_STEPS: readonly Step[] = [
  {
    anchor: 'settings-details',
    title: 'Title & description',
    body: 'Edit them, or press “Generate with AI” to write both from the video’s captions.',
  },
  {
    anchor: 'settings-access',
    title: 'Who can watch',
    body: 'Private, unlisted or public — and an unlock price if you want it paid. Sharing and the podcast need public.',
  },
  {
    anchor: 'settings-dubbing',
    title: 'Dubbing',
    body: 'Add languages: each dub gets its own voice, its own captions and its own address, and viewers switch in the player.',
  },
  {
    anchor: 'settings-thumbnail',
    title: 'Thumbnail',
    body: 'Generate one with AI, upload one, or grab a frame from the timeline. A vertical project gets a vertical thumbnail.',
  },
  {
    anchor: 'settings-crop',
    title: 'Smart Crop',
    body: 'For a landscape video: follow the speaker when it is watched vertically. A vertical video needs no crop and this card stays hidden.',
  },
  {
    anchor: 'settings-avatar',
    title: 'Ask the avatar & speaker circles',
    body: 'The persona viewers can talk to, and the audio-reactive circles shown during b-roll.',
  },
  {
    anchor: 'settings-collab',
    title: 'Collaborators',
    body: 'Invite people by email to co-edit — they can do everything except delete the project.',
  },
];

// ── The section editor, by section kind ──────────────────────────────────────────────────────

export const SECTION_STEPS_BROLL: readonly Step[] = [
  { anchor: 'sec-broll-info', title: 'B-roll clip', body: 'Review the generated clip and set its audio level before saving.' },
];

export const SECTION_STEPS_SIM_PICK: readonly Step[] = [
  { anchor: 'sec-sim-select', title: 'Choose a simulation', body: 'Pick the ready simulation this section controls.' },
];

export const SECTION_STEPS_SIM_ATTACHED: readonly Step[] = [
  { anchor: 'sec-sim-prompt', title: 'Describe the moment', body: 'Tell the AI what the simulation should show here. Simple UI and Auto Script below decide how much the viewer drives.' },
  { anchor: 'sec-sim-generate', title: 'Generate and preview', body: 'Generate the bridge with AI and play it in the preview before saving.' },
  { anchor: 'sec-sim-controls', title: 'Minimal UI — pick the controls', body: 'Under Advanced · UI controls, scan the simulation and choose which of its controls viewers see. All, none, or “keep only those”; Undo takes it back.' },
  { anchor: 'sec-sim-presets', title: 'Save and reuse a bridge', body: 'Save a working setup under a name and load it on the same simulation in another video — it can bring the simulation with it. Instant when it fits; regenerated from your settings when it does not.' },
];

export const SECTION_STEPS_IMAGE: readonly Step[] = [
  { anchor: 'sec-camera', title: 'Image section', body: 'A still image over the video — pick a zoom or pan to animate it.' },
];

export const SECTION_STEPS_CLIP: readonly Step[] = [
  { anchor: 'sec-video', title: 'Video clip section', body: 'Pick a clip from your Library and trim its in and out points.' },
];

export const SECTION_STEPS_GENERATED: readonly Step[] = [
  { anchor: 'sec-video-prompt', title: 'Describe the shot', body: 'Write the shot for the AI video model. A vertical project gets a vertical clip.' },
  { anchor: 'sec-video-generate', title: 'Generate video', body: 'Queue the clip and follow its status here.' },
  { anchor: 'sec-video-options', title: 'Generation options', body: 'Choose the model, and whether to enhance the prompt first.' },
];

// ── The avatar persona ────────────────────────────────────────────────────────────────────────

export const PERSONA_STEPS: readonly Step[] = [
  { anchor: 'persona-basics', title: 'Give it a personality', body: 'The greeting, the system prompt that shapes how it talks, and the facts it should always know. Blank means the character’s default.' },
  { anchor: 'persona-knowledge', title: 'Knowledge documents', body: 'Drop in PDFs, docs or notes. The avatar searches them live and answers from them — the way to ground it in this video.' },
  { anchor: 'persona-advanced', title: 'Advanced', body: 'Base personality, language, the LLM, the avatar model, session limits and tools. The defaults are fine for most.' },
  { anchor: 'persona-avatar', title: 'The face', body: 'Which avatar appears, saved per video.' },
  { anchor: 'persona-voice', title: 'The voice', body: 'Filter by gender, provider or language and press play to hear a sample.' },
];

// ── The extended library ──────────────────────────────────────────────────────────────────────

export const LIBRARY_STEPS: readonly Step[] = [
  { anchor: 'lib-generate', title: 'Generate visuals', body: 'Describe an image or an interactive simulation and it is added to the avatar’s library.' },
  { anchor: 'lib-panel', title: 'Add your own', body: 'Drag files anywhere here — images, HTML/ZIP simulations, charts, equations, JSON specs.' },
  { anchor: 'lib-gallery', title: 'Manage', body: 'Hover an item to edit its caption, move it between Basic and Extended, re-edit a simulation, or delete it.' },
];

// ── The viewer's keys ─────────────────────────────────────────────────────────────────────────

export interface Shortcut { keys: string; does: string }

export const VIEWER_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Space', does: 'Play / pause' },
  { keys: '←  →', does: 'Back / forward 5 seconds' },
  { keys: '?', does: 'Show these keys' },
  { keys: 'Esc', does: 'Close this' },
];
