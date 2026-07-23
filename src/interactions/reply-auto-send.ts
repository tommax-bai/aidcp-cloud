import { deterministicClaimTags, forcedHumanRisk, validateFinalReplyText } from './reply-config.js';
import type { ReplyProfile, ReplyRule, RiskTag } from '../kernel/interaction-types.js';

const AUDIT_ONLY_TAGS = new Set<RiskTag>(['meaning_changed', 'introduced_claim']);
const QUESTION_CUE = /(?:[?？]|吗(?:[，。！？!?]|$)|么(?:[，。！？!?]|$)|呢(?:[，。！？!?]|$)|什么|怎么|如何|几岁|多大|几年级|多少|是否|能不能|可不可以|有没有|哪(?:个|些|里|种)|什么时候|多久|适合)/u;

export interface AutomaticReplyEvidence {
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  riskReasons: RiskTag[];
  meaningChanged: boolean;
  introducedClaims: string[];
  renderedText: string | null;
  finalText: string | null;
}

export function looksLikeKnowledgeQuestion(text: string | null | undefined): boolean {
  return Boolean(text?.trim() && QUESTION_CUE.test(text));
}

/**
 * Deterministic content gate shared by automatic generation admission and the
 * pre-dispatch recheck. Runtime/auth/rate-limit gates remain in the orchestrator.
 */
export function automaticReplyContentEligible(input: {
  rule: ReplyRule | null;
  profile: ReplyProfile | null;
  aiPolishEnabled: boolean;
  inboundText: string | null | undefined;
  evidence: AutomaticReplyEvidence;
}): boolean {
  const { rule, profile, evidence } = input;
  if (!rule?.actions.allowAutoSend || !profile || evidence.riskLevel !== 'low' ||
      !evidence.renderedText?.trim() || !evidence.finalText?.trim()) return false;
  if (validateFinalReplyText(profile, evidence.finalText).length ||
      deterministicClaimTags(evidence.finalText).length ||
      forcedHumanRisk(rule, evidence.riskReasons)) return false;
  if (evidence.riskReasons.some((tag) => !AUDIT_ONLY_TAGS.has(tag))) return false;

  const aiPolishInvoked = rule.actions.polish && input.aiPolishEnabled;
  if (!aiPolishInvoked) {
    return evidence.finalText === evidence.renderedText && !evidence.meaningChanged &&
      evidence.introducedClaims.length === 0 && evidence.riskReasons.length === 0;
  }

  const hasMeaningTag = evidence.riskReasons.includes('meaning_changed');
  const hasClaimTag = evidence.riskReasons.includes('introduced_claim');
  if (hasMeaningTag !== evidence.meaningChanged ||
      hasClaimTag !== (evidence.introducedClaims.length > 0)) return false;

  if (!evidence.meaningChanged && evidence.introducedClaims.length === 0) {
    return evidence.riskReasons.length === 0;
  }

  return evidence.introducedClaims.length > 0 && evidence.finalText !== evidence.renderedText &&
    Boolean(profile.knowledgeDocument?.trim()) && looksLikeKnowledgeQuestion(input.inboundText);
}
