/**
 * LessonContentService — assembles the meaningful, server-renderable TEXT for a
 * lesson so Google (and readers) understand the actual content, not just the
 * title/thumbnail. Prefers text ALREADY stored in the system; only the captions
 * VTT (audio-derived) is used as a fallback, and live audio transcription is left
 * to the background captions pipeline.
 *
 * Transcript source priority (highest first):
 *   1. scenes.transcript     — generated narration text
 *   2. scripts.body_json     — generated script dialogue
 *   3. captions VTT          — stored transcription of the audio (fallback)
 *   4. corpora.extracted_md  — source material
 */
import { db } from '../../db/index.js';
import { scenes, scripts, corpora, timeline_sections, simulations, video_files, projects } from '../../db/schema.js';
import { and, eq, asc, desc } from 'drizzle-orm';
import { vttToPlainText, fetchTranscript } from './transcript.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';

export type TranscriptSource = 'scenes' | 'script' | 'captions' | 'corpus' | null;

export interface InteractiveElement {
  label: string;
  description: string;
}

export interface LessonContent {
  transcript: string | null;
  transcriptSource: TranscriptSource;
  topics: string | null;
  interactiveElements: InteractiveElement[];
  /** True when the lesson has a real transcript OR substantive descriptive text. */
  hasMeaningfulText: boolean;
}

const MIN_TRANSCRIPT_CHARS = 120;

/** Best-effort plain text from a generated script body_json (shape-tolerant). */
export function scriptBodyToText(body: unknown): string {
  if (!body) return '';
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (!n) return;
    if (typeof n === 'string') { if (n.trim()) out.push(n.trim()); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (typeof n === 'object') {
      const o = n as Record<string, unknown>;
      // common fields holding spoken/narration text
      for (const k of ['text', 'line', 'content', 'utterance', 'dialogue']) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) out.push((o[k] as string).trim());
      }
      for (const k of ['turns', 'segments', 'lines', 'body', 'children']) if (o[k]) visit(o[k]);
    }
  };
  visit(body);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export async function resolveLessonContent(projectId: string): Promise<LessonContent> {
  let transcript: string | null = null;
  let transcriptSource: TranscriptSource = null;

  // 1. scenes narration
  const sceneRows = await db.query.scenes.findMany({
    where: eq(scenes.project_id, projectId), orderBy: [asc(scenes.idx)], columns: { transcript: true },
  });
  const sceneText = sceneRows.map((s) => s.transcript).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (sceneText.length >= MIN_TRANSCRIPT_CHARS) { transcript = sceneText; transcriptSource = 'scenes'; }

  // 2. generated script
  if (!transcript) {
    const script = await db.query.scripts.findFirst({
      where: eq(scripts.project_id, projectId), orderBy: [desc(scripts.version)], columns: { body_json: true },
    });
    const text = scriptBodyToText(script?.body_json);
    if (text.length >= MIN_TRANSCRIPT_CHARS) { transcript = text; transcriptSource = 'script'; }
  }

  // 3. captions VTT (audio-derived) — fallback. Read straight from the DB column
  //    (source of truth); fall back to the object-storage backup if present.
  if (!transcript) {
    const vid = await db.query.video_files.findFirst({
      where: and(eq(video_files.project_id, projectId), eq(video_files.is_broll, false), eq(video_files.captions_status, 'ready')),
      columns: { captions_vtt: true, captions_vtt_key: true }, orderBy: [asc(video_files.created_at)],
    });
    let text: string | null = null;
    if (vid?.captions_vtt) {
      text = vttToPlainText(vid.captions_vtt);
    } else if (vid?.captions_vtt_key) {
      const storage = getStorageAdapter();
      text = await fetchTranscript(storage.getPublicUrl(vid.captions_vtt_key));
    }
    if (text && text.length >= MIN_TRANSCRIPT_CHARS) { transcript = text; transcriptSource = 'captions'; }
  }

  // 4. source material
  if (!transcript) {
    const corpus = await db.query.corpora.findFirst({ where: eq(corpora.project_id, projectId), columns: { extracted_md: true } });
    const md = (corpus?.extracted_md ?? '').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (md.length >= MIN_TRANSCRIPT_CHARS) { transcript = md.slice(0, 5000); transcriptSource = 'corpus'; }
  }

  // Interactive elements — labelled simulation/interactive sections. Use author
  // notes or the simulation name; NEVER the internal sim_prompt (developer text).
  const simSections = await db.query.timeline_sections.findMany({
    where: eq(timeline_sections.project_id, projectId), orderBy: [asc(timeline_sections.start_sec)],
  });
  const simRows = await db.query.simulations.findMany({ where: eq(simulations.project_id, projectId), columns: { id: true, name: true } });
  const simNameById = new Map(simRows.map((s) => [s.id, s.name]));
  const interactiveElements: InteractiveElement[] = [];
  for (const s of simSections) {
    const isSim = !!s.simulation_id || s.type === 'simulation';
    if (!isSim) continue;
    const name = s.simulation_id ? simNameById.get(s.simulation_id) : null;
    const label = (s.label ?? name ?? 'Interactive simulation').trim();
    const description = (s.notes?.trim()) || (name ? `Interactive simulation: ${name}.` : 'Interactive simulation embedded in the video.');
    interactiveElements.push({ label, description });
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { topic: true } });
  const topics = project?.topic?.trim() || null;

  const hasMeaningfulText =
    !!transcript ||
    (topics?.length ?? 0) >= MIN_TRANSCRIPT_CHARS ||
    interactiveElements.length > 0;

  return { transcript, transcriptSource, topics, interactiveElements, hasMeaningfulText };
}

/**
 * SEO readiness for publication. A lesson is "thin" when it has neither a real
 * transcript source NOR a substantive author summary. Used to FLAG before publish.
 */
export function assessLessonReadiness(input: { transcript: string | null; summary: string | null }): { ok: boolean; reason?: string } {
  if (input.transcript && input.transcript.length >= MIN_TRANSCRIPT_CHARS) return { ok: true };
  if (input.summary && input.summary.trim().length >= 60) return { ok: true };
  return { ok: false, reason: 'no transcript source and no substantive summary' };
}
