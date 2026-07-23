import { createHash, randomUUID } from 'node:crypto';
import {
  deterministicClaimTags,
  matchReplyRule,
  renderReplyTemplate,
  validateFinalReplyText,
  validateReplyConfig,
} from './reply-config.js';
import { readJobConfig, readPublishedConfig, type ReplyConfigReader } from '../kernel/interaction-reply-contract.js';
import { automaticReplyContentEligible } from './reply-auto-send.js';
import type { InteractionStore } from './interaction-store.js';
import {
  HARD_RISK_TAGS,
  InteractionError,
  type AiFallback,
  type ReplyAiPort,
  type InteractionErrorCode,
  type MinimalInbound,
  type ReplyConfigSnapshot,
  type ReplyJobView,
  type ReplyIntent,
  type ReplyProfile,
  type ReplyRule,
  type ReplyTemplate,
  type RiskTag,
  type ScopedJobContext,
} from '../kernel/interaction-types.js';

const CONTENT_HIGH_RISK = new Set<string>(HARD_RISK_TAGS.filter((tag) =>
  tag !== 'unknown' && tag !== 'meaning_changed' && tag !== 'introduced_claim'));
const PROCESS_ONLY_RISK = new Set<string>(['unknown', 'meaning_changed', 'introduced_claim']);
const ORDINARY_KNOWLEDGE_INTENTS = new Set<ReplyIntent>([
  'general_question', 'product_question', 'support_request',
]);
const ORDINARY_KNOWLEDGE_CUE = /适合.{0,6}(?:几岁|多大|几年级)|(?:几岁|多大|几年级).{0,6}(?:孩子|学生|适合)/;

export interface ReplyPreviewResult {
  matchedRuleId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  renderedText: string | null;
  polishedText: string | null;
  finalText: string | null;
  riskLevel: ReplyJobView['riskLevel'];
  riskReasons: RiskTag[];
  requiresApproval: boolean;
  meaningChanged: boolean;
  introducedClaims: string[];
  reviewReasons: string[];
  fallbacks: { classifier: AiFallback; polisher: AiFallback; reviewer: AiFallback };
}

function inboundOf(context: ScopedJobContext): MinimalInbound {
  return {
    channel: context.thread.channel,
    messageType: context.message.messageType,
    text: context.message.contentText,
    userName: context.thread.participant?.displayName ?? null,
    videoTitle: context.thread.sourceTitle,
    recentMessages: [],
  };
}

function uniqueTags(...sets: RiskTag[][]): RiskTag[] {
  return [...new Set(sets.flat())];
}

const INTENT_RISK_TAG: Partial<Record<ReplyIntent, RiskTag>> = {
  order: 'order', refund: 'refund', pricing: 'pricing', promotion: 'promotion', inventory: 'inventory',
  shipping: 'shipping', personal_data: 'personal_data', complaint: 'complaint', medical: 'medical',
  legal: 'legal', abuse: 'abuse', minor_safety: 'minor_safety',
};

function templateFor(snapshot: ReplyConfigSnapshot, rule: ReplyRule): ReplyTemplate | null {
  return snapshot.templates.find((template) => template.templateId === rule.actions.templateId &&
    template.channel === rule.channel && template.enabled && !template.archived) ?? null;
}

function profileFor(snapshot: ReplyConfigSnapshot, channel: 'comment' | 'dm'): ReplyProfile | null {
  return snapshot.profiles.find((profile) => profile.channel === channel) ?? null;
}

const SUPPORT_CHANNEL_VARIABLE = /{{\s*support_channel\s*}}/;

function renderedSupportChannelLines(template: ReplyTemplate, renderedText: string): string[] {
  const renderedLines = renderedText.split('\n');
  return template.content.trim().split('\n').flatMap((line, index) =>
    SUPPORT_CHANNEL_VARIABLE.test(line) && renderedLines[index] !== undefined ? [renderedLines[index]] : []);
}

function preservesProtectedLines(candidateText: string, protectedLines: string[]): boolean {
  const remainingCandidateLines = candidateText.split('\n');
  return protectedLines.every((line) => {
    const index = remainingCandidateLines.indexOf(line);
    if (index < 0) return false;
    remainingCandidateLines.splice(index, 1);
    return true;
  });
}

export class ReplyWorkflow {
  private readonly requestId: () => string;
  private readonly accountNameFor: (accountId: string) => string | null | undefined | Promise<string | null | undefined>;
  private readonly contactInfoFor: (accountId: string) => string | null | undefined | Promise<string | null | undefined>;
  private readonly canAutoQueue: (
    context: ScopedJobContext,
    snapshot: ReplyConfigSnapshot,
    preview: ReplyPreviewResult,
  ) => Promise<boolean>;

  constructor(
    private readonly store: InteractionStore,
    private readonly configs: ReplyConfigReader,
    private readonly ai: ReplyAiPort,
    options: {
      requestId?: () => string;
      canAutoQueue?: (
        context: ScopedJobContext,
        snapshot: ReplyConfigSnapshot,
        preview: ReplyPreviewResult,
      ) => Promise<boolean>;
      accountNameFor?: (accountId: string) => string | null | undefined | Promise<string | null | undefined>;
      contactInfoFor?: (accountId: string) => string | null | undefined | Promise<string | null | undefined>;
    } = {},
  ) {
    this.requestId = options.requestId ?? randomUUID;
    this.accountNameFor = options.accountNameFor ?? (() => null);
    this.contactInfoFor = options.contactInfoFor ?? (() => null);
    this.canAutoQueue = options.canAutoQueue ?? (async () => false);
  }

  async generate(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']> {
    const initial = await this.store.getJobContext(input.accountId, input.envKey, input.jobId);
    if (!initial) throw new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    const classifying = await this.store.transitionJob({
      ...input,
      from: ['new', 'approval_required', 'failed'],
      to: 'classifying',
    });
    const context = await this.store.getJobContext(input.accountId, input.envKey, input.jobId);
    if (!context) throw new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    const snapshot = await readPublishedConfig(this.configs, input.accountId);
    if (!snapshot || !snapshot.policy.generateDrafts || !snapshot.policy.channels[context.thread.channel].enabled) {
      return this.failGeneration(input, classifying.version, 'INTERACTION_CONFIG_MISSING', 'published_config_unavailable');
    }
    if (validateReplyConfig(snapshot).length) {
      return this.failGeneration(input, classifying.version, 'INTERACTION_CONFIG_MISSING', 'published_config_invalid');
    }
    if (context.message.messageType !== 'text' || !context.message.contentText?.trim()) {
      return this.failGeneration(input, classifying.version, 'INTERACTION_UNSUPPORTED_MESSAGE_TYPE', 'unsupported_message_type');
    }
    let preview: ReplyPreviewResult;
    try {
      preview = await this.buildPreview(snapshot, inboundOf(context), context.thread.sourceExternalId);
    } catch (error) {
      const code = error instanceof InteractionError ? error.code : 'INTERACTION_CONFIG_MISSING';
      return this.failGeneration(input, classifying.version, code, 'draft_generation_failed');
    }
    if (!preview.finalText || !preview.matchedRuleId || !preview.templateId || preview.templateVersion === null) {
      return this.failGeneration(input, classifying.version, 'INTERACTION_CONFIG_MISSING', 'no_matching_reply_rule');
    }
    const policy = snapshot.policy;
    const autoCandidate = input.actor === 'system' && policy.mode === 'auto_safe' && policy.sendReplies &&
      policy.channels[context.thread.channel].allowAutoSend && !preview.requiresApproval;
    const autoSafe = autoCandidate && await this.canAutoQueue(context, snapshot, preview).catch(() => false);
    const nextState = policy.mode === 'draft_only' ? 'draft_ready' : autoSafe ? 'queued' : 'approval_required';
    const updated = await this.store.transitionJob({
      accountId: input.accountId,
      envKey: input.envKey,
      jobId: input.jobId,
      expectedVersion: classifying.version,
      from: ['classifying'],
      to: nextState,
      actor: input.actor,
      patch: {
        matchedRuleId: preview.matchedRuleId,
        configVersion: snapshot.configVersion,
        configScopeId: snapshot.configScopeId ?? null,
        templateId: preview.templateId,
        templateVersion: preview.templateVersion,
        renderedText: preview.renderedText,
        polishedText: preview.polishedText,
        finalText: preview.finalText,
        meaningChanged: preview.meaningChanged,
        introducedClaims: preview.introducedClaims,
        riskLevel: preview.riskLevel,
        riskReasons: preview.riskReasons,
        lastErrorCode: null,
      },
    });
    await this.store.recordAudit({
      accountId: input.accountId, envKey: input.envKey, actor: input.actor,
      action: 'draft_generated', configVersion: snapshot.configVersion,
      entityType: 'reply_job', entityId: input.jobId, summary: 'draft generated',
      labels: { state: updated.state, riskLevel: updated.riskLevel, riskTags: updated.riskReasons,
        classifierFallback: preview.fallbacks.classifier, polisherFallback: preview.fallbacks.polisher,
        reviewerFallback: preview.fallbacks.reviewer },
    });
    return updated;
  }

  private async failGeneration(
    input: { accountId: string; envKey: string; jobId: string; actor: string },
    expectedVersion: number,
    code: InteractionErrorCode,
    reason: string,
  ): Promise<ScopedJobContext['job']> {
    const job = await this.store.transitionJob({
      accountId: input.accountId, envKey: input.envKey, jobId: input.jobId, expectedVersion,
      from: ['classifying'], to: 'failed', actor: input.actor,
      patch: {
        matchedRuleId: null, configVersion: null, templateId: null, templateVersion: null,
        renderedText: null, polishedText: null, finalText: null, meaningChanged: false,
        introducedClaims: [], riskLevel: 'unknown', riskReasons: ['unknown'], lastErrorCode: code,
      },
    });
    await this.store.recordAudit({
      accountId: input.accountId, envKey: input.envKey, actor: input.actor, action: 'draft_failed',
      entityType: 'reply_job', entityId: input.jobId, summary: reason, labels: { code },
    });
    return job;
  }

  async buildPreview(
    snapshot: ReplyConfigSnapshot,
    inbound: MinimalInbound,
    sourceExternalId: string | null,
  ): Promise<ReplyPreviewResult> {
    const profile = profileFor(snapshot, inbound.channel);
    if (!profile) throw new InteractionError('INTERACTION_CONFIG_MISSING', '缺少渠道 profile。', 422);
    const classifier = await this.ai.classify({
      role: 'reply_intent_classifier', requestId: this.requestId(), accountId: snapshot.accountId, inbound,
    });
    const rule = matchReplyRule(snapshot, { inbound, intent: classifier.value.intent, sourceExternalId });
    const template = rule ? templateFor(snapshot, rule) : null;
    if (!rule || !template) {
      return {
        matchedRuleId: null, templateId: null, templateVersion: null, renderedText: null,
        polishedText: null, finalText: null, riskLevel: 'unknown', riskReasons: ['unknown'], requiresApproval: true,
        meaningChanged: false, introducedClaims: [], reviewReasons: ['no_matching_rule'],
        fallbacks: { classifier: classifier.fallback, polisher: 'none', reviewer: 'none' },
      };
    }
    let rendered: string;
    try {
      const usesSupportChannel = template.content.split('\n').some((line) => SUPPORT_CHANNEL_VARIABLE.test(line));
      const [accountName, contactInfo] = await Promise.all([
        this.accountNameFor(snapshot.accountId),
        usesSupportChannel ? this.contactInfoFor(snapshot.accountId) : null,
      ]);
      rendered = renderReplyTemplate(template, profile, {
        user_name: inbound.userName,
        video_title: inbound.videoTitle,
        account_name: accountName?.trim() || profile.selfName,
        support_channel: typeof contactInfo === 'string' && contactInfo.trim() ? contactInfo : null,
      });
    } catch (error) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED',
        `模板渲染失败：${error instanceof Error ? error.message : 'unknown'}`, 422);
    }
    const polish = rule.actions.polish && snapshot.policy.channels[inbound.channel].aiPolishEnabled
      ? await this.ai.polish({
        role: 'reply_polisher', requestId: this.requestId(), accountId: snapshot.accountId, inbound,
        intent: classifier.value.intent,
        renderedText: rendered,
        profile: {
          tone: profile.tone, maxLength: profile.maxLength, allowEmoji: profile.allowEmoji,
          allowLinks: profile.allowLinks, blockedPhrases: profile.blockedPhrases,
          requiredDisclaimer: profile.requiredDisclaimer,
          knowledgeDocument: profile.knowledgeDocument ?? null,
        },
      })
      : { value: { role: 'reply_polisher' as const, polishedText: rendered, meaningChanged: false,
        introducedClaims: [], riskTags: [] as RiskTag[] }, fallback: 'none' as const };
    const aiPolishInvoked = rule.actions.polish && snapshot.policy.channels[inbound.channel].aiPolishEnabled;
    const polishedCandidate = polish.value.polishedText;
    const candidateIssues = validateFinalReplyText(profile, polishedCandidate);
    const protectedLines = renderedSupportChannelLines(template, rendered);
    const candidateRejected = candidateIssues.length > 0 || !preservesProtectedLines(polishedCandidate, protectedLines);
    const candidate = candidateRejected
      ? rendered
      : polishedCandidate;
    const polisherFallback: AiFallback = polish.fallback !== 'none'
      ? polish.fallback
      : candidateRejected ? 'candidate_rejected' : 'none';
    const deterministicTags: RiskTag[] = [];
    const intentRiskTag = INTENT_RISK_TAG[classifier.value.intent];
    if (intentRiskTag) deterministicTags.push(intentRiskTag);
    if (polish.value.meaningChanged) deterministicTags.push('meaning_changed');
    if (polish.value.introducedClaims.length) deterministicTags.push('introduced_claim');
    if (profile.disallowedClaims.some((claim) => polish.value.introducedClaims.includes(claim))) deterministicTags.push('introduced_claim');
    if (candidateIssues.some((issue) => issue.code === 'link_forbidden' || issue.code === 'disallowed_claim')) {
      deterministicTags.push('introduced_claim');
    }
    if (candidateIssues.some((issue) => issue.code !== 'link_forbidden' && issue.code !== 'disallowed_claim')) {
      deterministicTags.push('unknown');
    }
    deterministicTags.push(...deterministicClaimTags(candidate));
    const reviewer = await this.ai.review({
      role: 'reply_risk_reviewer', requestId: this.requestId(), accountId: snapshot.accountId, inbound,
      renderedText: rendered, candidateText: candidate, meaningChanged: polish.value.meaningChanged,
      introducedClaims: polish.value.introducedClaims,
      policy: { mode: snapshot.policy.mode, hardRiskTags: [...HARD_RISK_TAGS] },
    });
    const fallbackRisk = classifier.fallback !== 'none' || polisherFallback !== 'none' || reviewer.fallback !== 'none'
      ? ['unknown'] as RiskTag[] : [];
    const collectedTags = uniqueTags(classifier.value.riskTags, polish.value.riskTags, reviewer.value.riskTags,
      deterministicTags, fallbackRisk);
    const ordinaryKnowledgeClassification =
      (classifier.fallback === 'none' && ORDINARY_KNOWLEDGE_INTENTS.has(classifier.value.intent)) ||
      ORDINARY_KNOWLEDGE_CUE.test(inbound.text ?? '');
    const groundedOrdinaryKnowledge = Boolean(profile.knowledgeDocument?.trim()) &&
      ordinaryKnowledgeClassification && polisherFallback === 'none' && reviewer.fallback === 'none' &&
      !candidateRejected && polish.value.introducedClaims.length > 0 &&
      collectedTags.every((tag) => PROCESS_ONLY_RISK.has(tag));
    const allTags = groundedOrdinaryKnowledge
      ? collectedTags.filter((tag) => tag !== 'unknown')
      : collectedTags;
    const effectiveFallbackRisk = groundedOrdinaryKnowledge ? [] : fallbackRisk;
    const reviewerRiskLevel = groundedOrdinaryKnowledge ? 'low' : reviewer.value.riskLevel;
    const hasHardRisk = allTags.some((tag) => CONTENT_HIGH_RISK.has(tag));
    const riskLevel = hasHardRisk ? 'high' : effectiveFallbackRisk.length || allTags.includes('unknown')
      ? 'unknown' : reviewerRiskLevel;
    const aiStepsSucceeded = classifier.fallback === 'none' && reviewer.fallback === 'none' &&
      (!aiPolishInvoked || polisherFallback === 'none');
    const knowledgeIntentVerified = polish.value.introducedClaims.length === 0 ||
      (classifier.fallback === 'none' && ORDINARY_KNOWLEDGE_INTENTS.has(classifier.value.intent));
    const requiresApproval = !aiStepsSucceeded || !knowledgeIntentVerified || !reviewer.value.allowAutoSend ||
      !automaticReplyContentEligible({
        rule,
        profile,
        aiPolishEnabled: snapshot.policy.channels[inbound.channel].aiPolishEnabled,
        inboundText: inbound.text,
        evidence: {
          riskLevel,
          riskReasons: allTags,
          meaningChanged: polish.value.meaningChanged,
          introducedClaims: polish.value.introducedClaims,
          renderedText: rendered,
          finalText: candidate,
        },
      });
    return {
      matchedRuleId: rule.ruleId,
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      renderedText: rendered,
      polishedText: candidate,
      finalText: candidate,
      riskLevel,
      riskReasons: allTags,
      requiresApproval,
      meaningChanged: polish.value.meaningChanged,
      introducedClaims: polish.value.introducedClaims,
      reviewReasons: reviewer.value.reasons,
      fallbacks: { classifier: classifier.fallback, polisher: polisherFallback, reviewer: reviewer.fallback },
    };
  }

  async approve(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']> {
    const context = await this.store.getJobContext(input.accountId, input.envKey, input.jobId);
    if (!context) throw new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    if (!context.job.finalText?.trim() || context.message.messageType !== 'text' || context.message.lifecycle !== 'active') {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '回复内容或原消息状态不允许审批。', 422);
    }
    const snapshot = context.job.configVersion === null ? null : await readJobConfig(this.configs,
      input.accountId, context.job.configScopeId, context.job.configVersion,
    );
    const profile = snapshot ? profileFor(snapshot, context.thread.channel) : null;
    if (!profile || validateFinalReplyText(profile, context.job.finalText).length) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '回复内容未通过账号 profile 确定性门禁。', 422);
    }
    const job = await this.store.transitionJob({ ...input, from: ['approval_required'], to: 'approved' });
    await this.store.recordAudit({ accountId: input.accountId, envKey: input.envKey, actor: input.actor,
      action: 'reply_approved', entityType: 'reply_job', entityId: input.jobId,
      summary: 'reply approved', labels: { state: job.state, riskLevel: job.riskLevel } });
    return job;
  }

  async edit(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string; text: string;
  }): Promise<ScopedJobContext['job']> {
    const text = input.text.trim();
    if (!text) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '回复内容不能为空。', 422);
    const context = await this.store.getJobContext(input.accountId, input.envKey, input.jobId);
    if (!context) throw new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    const snapshot = context.job.configVersion === null ? null : await readJobConfig(this.configs,
      input.accountId, context.job.configScopeId, context.job.configVersion,
    );
    const profile = snapshot ? profileFor(snapshot, context.thread.channel) : null;
    if (!snapshot || !profile || text.length > profile.maxLength) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '编辑内容超长或引用配置已失效。', 422);
    }
    const deterministicIssues = validateFinalReplyText(profile, text);
    if (deterministicIssues.length) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '编辑内容未通过账号回复规则。', 422, false, {
        issues: deterministicIssues,
      });
    }
    const reviewer = await this.ai.review({
      role: 'reply_risk_reviewer', requestId: this.requestId(), accountId: input.accountId,
      inbound: inboundOf(context), renderedText: context.job.renderedText ?? '', candidateText: text,
      meaningChanged: text !== context.job.renderedText, introducedClaims: [],
      policy: { mode: snapshot.policy.mode, hardRiskTags: [...HARD_RISK_TAGS] },
    });
    const tags = uniqueTags(reviewer.value.riskTags, reviewer.fallback === 'none' ? [] : ['unknown']);
    const job = await this.store.transitionJob({
      ...input, from: ['approval_required'], to: 'approval_required',
      patch: { polishedText: text, finalText: text, meaningChanged: text !== context.job.renderedText,
        riskLevel: reviewer.fallback === 'none' ? reviewer.value.riskLevel : 'unknown', riskReasons: tags,
        introducedClaims: [], lastErrorCode: null },
    });
    await this.store.recordAudit({ accountId: input.accountId, envKey: input.envKey, actor: input.actor,
      action: 'reply_edited', entityType: 'reply_job', entityId: input.jobId,
      summary: 'reply edited and review reset', labels: {
        riskLevel: job.riskLevel,
        reviewerFallback: reviewer.fallback,
        beforeSha256: createHash('sha256').update(context.job.finalText ?? '', 'utf8').digest('hex'),
        afterSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      } });
    return job;
  }
}
