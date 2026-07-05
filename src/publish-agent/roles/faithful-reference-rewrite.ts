import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type {
  CreatedContent,
  FaithfulDraft,
  FaithfulRewritePlan,
  FidelityAuditReport,
  PipelineFields,
  ReferenceAnalysis,
  TriggerInput,
} from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import {
  buildFaithfulDraftPrompt,
  buildFaithfulRewritePlanPrompt,
  buildFidelityAuditPrompt,
  buildReferenceAnalysisPrompt,
} from '../prompts.js';
import { escapeControlCharsInJsonStrings } from '../json-repair.js';
import { executeWithRetry } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

const REFERENCE_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_REFERENCE_REWRITE_TIMEOUT_MS ?? 180_000);
const FIDELITY_PASS_SCORE = Number(process.env.AIDCP_PUBLISH_REFERENCE_FIDELITY_PASS_SCORE ?? 0.8);

export interface FaithfulReferenceRoleDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

type ReferenceNoteInput = NonNullable<TriggerInput['generateInput']['referenceNote']>;

interface PlannerInput {
  trigger: TriggerInput;
  analysis: ReferenceAnalysis;
}

interface DraftInput extends PlannerInput {
  plan: FaithfulRewritePlan;
}

interface AuditInput extends DraftInput {
  draft: FaithfulDraft;
}

abstract class FaithfulReferenceRole<TInput, TOutput> extends BasePublishRole<TInput, TOutput> {
  protected readonly llmClient: ChatLlmClient;

  constructor(deps: FaithfulReferenceRoleDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected hasReference(snapshot: Partial<PipelineFields>): boolean {
    return !!snapshot.trigger?.generateInput.referenceNote;
  }

  protected referenceNote(trigger: TriggerInput): ReferenceNoteInput {
    const note = trigger.generateInput.referenceNote;
    if (!note) throw new Error('Reference note is required for faithful rewrite');
    return note;
  }

  protected async chatJson(system: string, prompt: string): Promise<Record<string, unknown>> {
    const raw = await executeWithRetry(
      () =>
        this.llmClient.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          { timeoutMs: REFERENCE_TIMEOUT_MS },
        ),
      { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 },
    );
    return parseJsonObject(raw);
  }
}

export class ReferenceAnalyzerRole extends FaithfulReferenceRole<TriggerInput, ReferenceAnalysis> {
  readonly config: RoleConfig = {
    name: 'ReferenceAnalyzer',
    watchKeys: ['trigger'],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'referenceAnalysis' as const;

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return this.hasReference(snapshot);
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TriggerInput {
    return snapshot.trigger!;
  }

  protected async execute(input: TriggerInput): Promise<ReferenceAnalysis> {
    const note = this.referenceNote(input);
    const obj = await this.chatJson(
      '你是保真改写原稿分析员，只输出严格 JSON。',
      buildReferenceAnalysisPrompt(note, input.generateInput.soul),
    );
    return {
      sourceId: note.sourceId,
      title: stringValue(obj.title, note.title),
      thesis: stringValue(obj.thesis),
      structure: stringArray(obj.structure),
      keyFacts: stringArray(obj.keyFacts),
      keyClaims: stringArray(obj.keyClaims),
      entities: stringArray(obj.entities),
      timeline: stringArray(obj.timeline),
      mustPreserve: stringArray(obj.mustPreserve),
      forbiddenAdditions: stringArray(obj.forbiddenAdditions),
      perspective: stringValue(obj.perspective, 'unknown'),
      analyzedAt: this.clock(),
    };
  }
}

export class FaithfulRewritePlannerRole extends FaithfulReferenceRole<PlannerInput, FaithfulRewritePlan> {
  readonly config: RoleConfig = {
    name: 'FaithfulRewritePlanner',
    watchKeys: ['referenceAnalysis'],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'faithfulRewritePlan' as const;

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return this.hasReference(snapshot) && !!snapshot.referenceAnalysis;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): PlannerInput {
    return {
      trigger: snapshot.trigger!,
      analysis: snapshot.referenceAnalysis!,
    };
  }

  protected async execute(input: PlannerInput): Promise<FaithfulRewritePlan> {
    const note = this.referenceNote(input.trigger);
    const obj = await this.chatJson(
      '你是保真改写规划员，只输出严格 JSON。',
      buildFaithfulRewritePlanPrompt(input.analysis, note, input.trigger.generateInput.soul),
    );
    return {
      titleDirection: stringValue(obj.titleDirection),
      paragraphs: parseParagraphs(obj.paragraphs),
      styleNotes: stringArray(obj.styleNotes),
      forbiddenAdditions: stringArray(obj.forbiddenAdditions),
      plannedAt: this.clock(),
    };
  }
}

export class FaithfulDraftWriterRole extends FaithfulReferenceRole<DraftInput, FaithfulDraft> {
  readonly config: RoleConfig = {
    name: 'FaithfulDraftWriter',
    watchKeys: ['faithfulRewritePlan'],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'faithfulDraft' as const;

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return this.hasReference(snapshot) && !!snapshot.referenceAnalysis && !!snapshot.faithfulRewritePlan;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): DraftInput {
    return {
      trigger: snapshot.trigger!,
      analysis: snapshot.referenceAnalysis!,
      plan: snapshot.faithfulRewritePlan!,
    };
  }

  protected async execute(input: DraftInput): Promise<FaithfulDraft> {
    const note = this.referenceNote(input.trigger);
    const obj = await this.chatJson(
      '你是保真改写正文写手，只输出严格 JSON。',
      buildFaithfulDraftPrompt(input.analysis, input.plan, note, input.trigger.generateInput.soul),
    );
    return {
      title: stringValue(obj.title, note.title).slice(0, 20),
      content: stringValue(obj.content),
      tone: validateTone(obj.tone),
      style: recordValue(obj.style),
      draftedAt: this.clock(),
    };
  }
}

export class FidelityAuditorRole extends FaithfulReferenceRole<AuditInput, CreatedContent> {
  readonly config: RoleConfig = {
    name: 'FidelityAuditor',
    watchKeys: ['faithfulDraft'],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'createdContent' as const;

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return (
      this.hasReference(snapshot) &&
      !!snapshot.referenceAnalysis &&
      !!snapshot.faithfulRewritePlan &&
      !!snapshot.faithfulDraft
    );
  }

  protected extractInput(snapshot: Partial<PipelineFields>): AuditInput {
    return {
      trigger: snapshot.trigger!,
      analysis: snapshot.referenceAnalysis!,
      plan: snapshot.faithfulRewritePlan!,
      draft: snapshot.faithfulDraft!,
    };
  }

  protected async execute(input: AuditInput, context: PipelineContext<PipelineFields>): Promise<CreatedContent> {
    const note = this.referenceNote(input.trigger);
    const obj = await this.chatJson(
      '你是保真改写忠实度审核员，只输出严格 JSON。',
      buildFidelityAuditPrompt(input.analysis, input.plan, input.draft, note),
    );
    const report: FidelityAuditReport = {
      pass: Boolean(obj.pass),
      score: clampNumber(Number(obj.score ?? 0), 0, 1),
      reason: stringValue(obj.reason),
      issues: stringArray(obj.issues),
      unsupportedClaims: stringArray(obj.unsupportedClaims),
      missingKeyPoints: stringArray(obj.missingKeyPoints),
      auditedAt: this.clock(),
    };
    context.write('fidelityAuditReport', report);

    if (!report.pass || report.score < FIDELITY_PASS_SCORE || report.unsupportedClaims.length > 0) {
      throw new Error(
        [
          `Faithful rewrite audit failed (score=${report.score})`,
          report.reason,
          report.unsupportedClaims.length ? `unsupported=${report.unsupportedClaims.join('; ')}` : '',
          report.missingKeyPoints.length ? `missing=${report.missingKeyPoints.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      );
    }

    return {
      title: input.draft.title.slice(0, 20),
      content: input.draft.content,
      tags: [],
      tone: input.draft.tone,
      style: { ...input.draft.style, rewriteMode: 'faithful' },
      createdAt: this.clock(),
    };
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in faithful rewrite output');
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return JSON.parse(escapeControlCharsInJsonStrings(match[0])) as Record<string, unknown>;
  }
}

function stringValue(value: unknown, fallback = ''): string {
  const v = typeof value === 'string' ? value : fallback;
  return v.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x).trim()).filter(Boolean);
}

function recordValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
}

function parseParagraphs(value: unknown): FaithfulRewritePlan['paragraphs'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const obj = item as Record<string, unknown>;
      return {
        source: stringValue(obj.source),
        rewriteGoal: stringValue(obj.rewriteGoal),
        mustKeep: stringArray(obj.mustKeep),
      };
    })
    .filter((item): item is FaithfulRewritePlan['paragraphs'][number] => !!item);
}

function validateTone(tone: unknown): CreatedContent['tone'] {
  const valid: CreatedContent['tone'][] = ['professional', 'casual', 'technical', 'narrative'];
  return typeof tone === 'string' && valid.includes(tone as CreatedContent['tone'])
    ? (tone as CreatedContent['tone'])
    : 'casual';
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
