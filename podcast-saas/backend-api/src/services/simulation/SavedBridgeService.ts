/**
 * Save a section's bridge setup under a name; judge and apply it elsewhere.
 *
 * The DECISION lives in bridgePresetDecision.ts (pure, mutation-proven). This file is the I/O
 * around it, and its shape follows one observation: the RECIPE path needs no new machinery at all
 * — the client calls the existing generate endpoint with the preset's prompt/toggles/selection.
 * Only two things genuinely require server work:
 *
 *   SAVING — the script body's only home is `package/bridge.js` inside the active revision, keyed
 *   by the section id it was generated for. Extracting the bare body (and its contract) is a
 *   server-side read of storage.
 *
 *   THE ARTIFACT APPLY — pasting a saved body onto a target section is a full package
 *   republication (uploadSectionBridge → new revision → CAS activate), and it is allowed ONLY
 *   when the judge said 'artifact'. The apply endpoint re-runs the judgement itself rather than
 *   trusting a client that claims it was told yes — the fit can change between the two requests
 *   (a replace can activate a new revision in between), and a stale yes pasted anyway is exactly
 *   the silently-dead section the whole design exists to prevent.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { saved_bridges, timeline_sections, simulations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { parseSectionEntries } from './SimulationService.js';
import { extractBridgeContract, verifyContract, buildSources, type BridgeContract, type CandidateBundle } from './SimBridgeContract.js';
import { readReplaceCompatibilitySource } from './replaceCompatibilitySource.js';
import { readStoredUiControls, type SimUiSelection } from './SimUiControls.js';
import { judgeBridgeLoad, describeLoadPath, type LoadPath } from './bridgePresetDecision.js';
import type { StorageService } from '../storage/StorageService.js';

export interface SavedBridgeRow {
  id: string;
  label: string;
  sim_prompt: string | null;
  simple_ui: boolean;
  auto_script: boolean;
  ui_controls: SimUiSelection | null;
  has_artifact: boolean;
  source_simulation_id: string | null;
  /** The source simulation's name, so a picker can say WHICH package a preset came from. */
  source_simulation_name: string | null;
  /**
   * True when the source simulation still exists and can be imported alongside the preset.
   *
   * The point of the whole feature is loading "plucking a boid with one button" onto another
   * video — and that only works if the boids package is there. When it is not, the preset alone
   * is a recipe with nothing to cook: the UI must be able to offer to bring the simulation too,
   * which since migration 080 costs no storage at all.
   */
  source_importable: boolean;
  created_at: Date;
  updated_at: Date;
}

const toRow = (r: typeof saved_bridges.$inferSelect): SavedBridgeRow => ({
  id: r.id,
  label: r.label,
  sim_prompt: r.sim_prompt,
  simple_ui: r.simple_ui,
  auto_script: r.auto_script,
  // Validated on the way OUT as well as in: this table is an ingress for selectors, and rows
  // written by an older build must not bypass today's guard.
  ui_controls: readStoredUiControls(r.ui_controls) ?? null,
  has_artifact: typeof r.main_body === 'string' && r.main_body.length > 0,
  source_simulation_id: r.source_simulation_id,
  source_simulation_name: null,
  source_importable: false,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export class SavedBridgeService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Snapshot a section's bridge setup under `label`. Same owner + same label = UPDATE, so
   * re-saving a preset the user has been refining replaces it instead of breeding siblings.
   */
  async saveFromSection(input: {
    userId: string;
    projectId: string;
    sectionId: string;
    label: string;
  }): Promise<SavedBridgeRow> {
    const section = await db.query.timeline_sections.findFirst({
      where: and(eq(timeline_sections.id, input.sectionId), eq(timeline_sections.project_id, input.projectId)),
    });
    if (!section) throw Object.assign(new Error('Section not found'), { status: 404 });
    if (section.type !== 'simulation' || !section.simulation_id) {
      throw Object.assign(new Error('Only a simulation section has a bridge to save'), { status: 400 });
    }

    const sim = await db.query.simulations.findFirst({ where: eq(simulations.id, section.simulation_id) });

    const meta = (section.sim_meta ?? {}) as Record<string, unknown>;
    // The selection is read from sim_meta — the generate endpoint's record of what was actually
    // APPLIED — never from what a client happens to send. (Plain section-Save does not persist
    // the selection at all; a save-bridge that trusted the request body would capture drift.)
    const uiControls = readStoredUiControls(meta.uiControls) ?? null;

    // ── The artifact, when there is one ────────────────────────────────────────────────────────
    // The body lives in package/bridge.js keyed by THIS section's id. A section that never
    // generated (minimal-UI-only with no demo, or a brand-new setup) simply has no entry, and the
    // preset saves as recipe-only — a first-class kind, not a degraded one.
    let mainBody: string | null = null;
    let contract: BridgeContract | null = null;
    if (sim) {
      try {
        const src = await readReplaceCompatibilitySource(this.storage, sim);
        mainBody = parseSectionEntries(src.bridgeJs ?? '').get(section.id) ?? null;
        if (mainBody) contract = extractBridgeContract(mainBody);
      } catch (e) {
        // An unreadable active revision must not make SAVING impossible — the recipe half is
        // still worth keeping. The artifact is simply absent, and the row says so.
        logger.warn({ evt: 'bridge_preset_artifact_unreadable', simulationId: sim.id, err: (e as Error).name },
          '[BridgePreset] saving recipe only — bridge source unreadable');
      }
    }

    const values = {
      created_by: input.userId,
      label: input.label,
      sim_prompt: section.sim_prompt ?? null,
      simple_ui: section.simple_ui,
      auto_script: section.auto_script,
      ui_controls: uiControls,
      main_body: mainBody,
      contract: contract as object | null,
      source_simulation_id: sim?.id ?? null,
      source_bridge_hash: sim?.bridge_hash ?? null,
      source_hash: typeof meta.sourceHash === 'string' ? meta.sourceHash : null,
      conversation_history: (meta.conversationHistory as object | undefined) ?? null,
      updated_at: new Date(),
    };

    const [row] = await db
      .insert(saved_bridges)
      .values(values)
      .onConflictDoUpdate({
        target: [saved_bridges.created_by, saved_bridges.label],
        set: values,
      })
      .returning();
    logger.info({ evt: 'bridge_preset_saved', presetId: row.id, hasArtifact: !!mainBody }, '[BridgePreset] saved');
    return toRow(row);
  }

  /**
   * The user's presets, newest first — the picker's data.
   *
   * Each row is resolved against its source simulation in ONE left join rather than a query per
   * preset: the picker shows the whole list at once, and N+1 there is a visible stall on a list
   * somebody opens to make a quick choice.
   */
  async listForUser(userId: string): Promise<SavedBridgeRow[]> {
    const rows = await db
      .select({ preset: saved_bridges, simName: simulations.name })
      .from(saved_bridges)
      .leftJoin(simulations, eq(simulations.id, saved_bridges.source_simulation_id))
      .where(eq(saved_bridges.created_by, userId))
      .orderBy(desc(saved_bridges.created_at));

    return rows.map(({ preset, simName }) => ({
      ...toRow(preset),
      source_simulation_name: simName ?? null,
      // The simulation still exists (the FK is SET NULL, so a deleted one leaves a null id —
      // and the join then finds nothing either way).
      source_importable: !!preset.source_simulation_id && !!simName,
    }));
  }

  async deleteForUser(userId: string, presetId: string): Promise<boolean> {
    const res = await db
      .delete(saved_bridges)
      .where(and(eq(saved_bridges.id, presetId), eq(saved_bridges.created_by, userId)))
      .returning({ id: saved_bridges.id });
    return res.length > 0;
  }

  /**
   * The FULL row, for the apply path only — ownership-checked like every other read here.
   * (judgeFit returns the public shape; the apply needs main_body and the meta fields.)
   */
  async presetForApply(userId: string, presetId: string) {
    return db.query.saved_bridges.findFirst({
      where: and(eq(saved_bridges.id, presetId), eq(saved_bridges.created_by, userId)),
    });
  }

  /**
   * Which path would loading `presetId` onto `simulationId` take — and the sentence to show.
   *
   * Read-only. The Load button calls this to decide what to promise; the apply endpoint calls it
   * AGAIN before pasting, because the answer can change between the two requests.
   */
  async judgeFit(input: {
    userId: string;
    presetId: string;
    simulationId: string;
  }): Promise<{ verdict: LoadPath; description: string; preset: SavedBridgeRow } | null> {
    const preset = await db.query.saved_bridges.findFirst({
      where: and(eq(saved_bridges.id, input.presetId), eq(saved_bridges.created_by, input.userId)),
    });
    if (!preset) return null;

    const sim = await db.query.simulations.findFirst({ where: eq(simulations.id, input.simulationId) });
    if (!sim) return null;

    let verification: { missing: ReturnType<typeof verifyContract>['missing']; checked: number } | null = null;
    const storedContract = preset.contract as BridgeContract | null;
    if (preset.main_body && storedContract) {
      try {
        const bundle = await this.readTargetBundle(sim);
        verification = bundle ? verifyContract(storedContract, buildSources(bundle)) : null;
      } catch {
        // Unreadable target ⇒ verification stays null ⇒ the judge resolves to recipe. Refusing to
        // guess is the decision module's contract; this catch just routes the failure into it.
        verification = null;
      }
    }

    const verdict = judgeBridgeLoad(
      {
        mainBody: preset.main_body,
        contract: storedContract,
        sourceBridgeHash: preset.source_bridge_hash,
        sourceHash: preset.source_hash,
      },
      { bridgeHash: sim.bridge_hash, verification },
    );
    return { verdict, description: describeLoadPath(verdict), preset: toRow(preset) };
  }

  /**
   * The target simulation's current text files, as the contract oracle wants them.
   *
   * Reads via the SAME source-of-truth reader the replace flow uses (active revision manifest, or
   * the legacy prefix), so "what the preset is verified against" and "what is actually served"
   * cannot be two different trees.
   */
  private async readTargetBundle(sim: {
    storage_prefix: string; entry_file: string | null; active_revision_id?: string | null;
  }): Promise<CandidateBundle | null> {
    const src = await readReplaceCompatibilitySource(this.storage, sim);
    // A legacy package has no manifest to enumerate (files === null). "Cannot enumerate" is
    // "cannot verify", and the judge downstream already resolves that to the recipe path — the
    // conservative, honest degradation for pre-revision simulations.
    if (!src.entryRelPath || !src.files) return null;
    const TEXT_RE = /\.(js|mjs|cjs|html?|css|ts|tsx|jsx|json|svg)$/i;
    const files = new Map<string, Buffer>();
    await Promise.all(src.files
      .filter((f) => TEXT_RE.test(f.rel))
      .map(async (f) => {
        try {
          files.set(f.rel, await this.storage.readObject(f.key));
        } catch { /* one unreadable file must not veto the scan; its absence weakens it honestly */ }
      }));
    if (files.size === 0) return null;
    return { files, entryRelPath: src.entryRelPath };
  }
}


