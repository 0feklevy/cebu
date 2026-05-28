import { db } from '../../db/index.js';
import { projects, corpora, scripts, hosts } from '../../db/schema.js';
import { eq, and, ne } from 'drizzle-orm';
import { LLMService } from '../llm/LLMService.js';
import { ContentModerationService } from '../llm/ContentModerationService.js';
import { StructuralAnalysisService } from './StructuralAnalysisService.js';
import { ScriptDraftService } from './ScriptDraftService.js';
import { ScriptRewriteService } from './ScriptRewriteService.js';
import { ScriptValidator } from './ScriptValidator.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import type { SSEEmitter } from '../../lib/sse.js';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

export class ScriptPipeline {
  private readonly llm: LLMService;
  private readonly moderation: ContentModerationService;
  private readonly structural: StructuralAnalysisService;
  private readonly draft: ScriptDraftService;
  private readonly rewrite: ScriptRewriteService;
  private readonly validator: ScriptValidator;

  constructor() {
    const apiKeyService = new ApiKeyService();
    const usageTracking = new UsageTrackingService();
    this.llm = new LLMService(apiKeyService, usageTracking);
    this.moderation = new ContentModerationService(this.llm);
    this.structural = new StructuralAnalysisService(this.llm);
    this.draft = new ScriptDraftService(this.llm);
    this.rewrite = new ScriptRewriteService(this.llm);
    this.validator = new ScriptValidator();
  }

  async run(
    projectId: string,
    sse: SSEEmitter,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) throw new AppError(LLMErrorType.LLM_ERROR, 'Project not found', 404);

    // Delete any non-approved script rows so re-runs always start at v1
    await db.delete(scripts).where(
      and(eq(scripts.project_id, projectId), ne(scripts.status, 'approved')),
    );

    const allCorpora = await db.query.corpora.findMany({
      where: and(eq(corpora.project_id, projectId), eq(corpora.ingestion_status, 'ready')),
    });

    const corpusText = allCorpora.map((c) => c.extracted_md ?? '').join('\n\n---\n\n');

    const hostA = project.host_a_id
      ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_a_id) })
      : null;
    const hostB = project.host_b_id
      ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_b_id) })
      : null;

    // Update project status
    await db.update(projects).set({ status: 'scripting' }).where(eq(projects.id, projectId));

    // ── Content Moderation ────────────────────────────────────────────────
    sse.emit({ type: 'status', stage: 'content_moderation', message: 'Safety check…', progress: 5 });
    await this.moderation.check(
      `${project.topic ?? ''}\n\n${corpusText.slice(0, 8000)}`,
      project.created_by!,
      projectId,
    );

    // ── Pass 0: Structural Analysis ────────────────────────────────────────
    sse.emit({
      type: 'status',
      stage: 'structural_analysis',
      message: 'Building topic map…',
      progress: 15,
    });
    const structuralResult = await this.structural.analyze(
      project,
      hostA ?? null,
      hostB ?? null,
      corpusText,
      abortSignal,
    );
    sse.emit({ type: 'structural_ready', structural_json: structuralResult.data });

    // ── Create scripts row at version 1 ───────────────────────────────────
    const nextVersion = await this.getNextVersion(projectId);
    const [scriptRow] = await db
      .insert(scripts)
      .values({
        project_id: projectId,
        version: nextVersion,
        structural_json: structuralResult.data as unknown as Record<string, unknown>,
        pass0_model: structuralResult.model,
        pass0_input_tokens: structuralResult.inputTokens,
        pass0_output_tokens: structuralResult.outputTokens,
        pass0_cost_cents: structuralResult.costCents,
        status: 'drafting',
      })
      .returning();

    // ── Pass 1: Draft Generation ───────────────────────────────────────────
    sse.emit({
      type: 'status',
      stage: 'script_draft',
      message: 'Writing first draft…',
      progress: 35,
    });
    const draftResult = await this.draft.draft(
      project,
      hostA ?? null,
      hostB ?? null,
      structuralResult.data,
      corpusText,
      abortSignal,
      (chunk) => sse.emit({ type: 'script_draft_token', chunk }),
    );

    await db.update(scripts).set({
      draft_body_json: draftResult.data as unknown as Record<string, unknown>,
      pass1_model: draftResult.model,
      pass1_input_tokens: draftResult.inputTokens,
      pass1_output_tokens: draftResult.outputTokens,
      pass1_cost_cents: draftResult.costCents,
      status: 'rewriting',
    }).where(eq(scripts.id, scriptRow.id));

    sse.emit({ type: 'script_draft_ready', script_version: nextVersion });

    // ── Pass 2: Dramatic Rewriter (best-effort — fall back to draft on parse failure) ──
    sse.emit({
      type: 'status',
      stage: 'script_rewrite',
      message: 'Adding conversational color…',
      progress: 70,
    });

    let rewriteResult: typeof draftResult | null = null;
    try {
      rewriteResult = await this.rewrite.rewrite(
        project,
        hostA ?? null,
        hostB ?? null,
        draftResult.data,
        abortSignal,
      );
    } catch (err: unknown) {
      const isParseError =
        err instanceof AppError && err.error_type === LLMErrorType.PARSING_ERROR;
      if (!isParseError) throw err;
      logger.warn({ projectId }, 'Rewrite pass failed with parse error, using draft as final');
    }

    const finalScript = rewriteResult ?? draftResult;

    await db.update(scripts).set({
      body_json: finalScript.data as unknown as Record<string, unknown>,
      pass2_model: rewriteResult?.model ?? null,
      pass2_input_tokens: rewriteResult?.inputTokens ?? 0,
      pass2_output_tokens: rewriteResult?.outputTokens ?? 0,
      pass2_cost_cents: rewriteResult?.costCents ?? 0,
      status: 'validating',
    }).where(eq(scripts.id, scriptRow.id));

    sse.emit({ type: 'script_rewrite_ready', script_version: nextVersion });

    // ── Pass 3: Deterministic Validator ──────────────────────────────────
    sse.emit({
      type: 'status',
      stage: 'script_validate',
      message: 'Validating script schema…',
      progress: 90,
    });
    const validation = this.validator.validate(finalScript.data);

    if (!validation.valid || !validation.script) {
      await db.update(scripts).set({
        status: 'failed',
        validation_errors: validation.errors as Record<string, unknown>,
      }).where(eq(scripts.id, scriptRow.id));

      await db.update(projects).set({ status: 'failed' }).where(eq(projects.id, projectId));

      sse.emit({
        type: 'error',
        error_type: LLMErrorType.PARSING_ERROR,
        message: 'Script schema validation failed',
      });
      return;
    }

    await db.update(scripts).set({ status: 'ready' }).where(eq(scripts.id, scriptRow.id));
    await db.update(projects).set({ status: 'script_ready' }).where(eq(projects.id, projectId));

    sse.emit({
      type: 'script_ready',
      script_version: nextVersion,
      script: validation.script,
    });
    sse.emit({ type: 'done', project_id: projectId });

    logger.info({ projectId, version: nextVersion }, 'Script pipeline complete');
  }

  private async getNextVersion(projectId: string): Promise<number> {
    const existing = await db.query.scripts.findMany({
      where: eq(scripts.project_id, projectId),
    });
    return (existing.length > 0 ? Math.max(...existing.map((s) => s.version)) : 0) + 1;
  }
}
