import {
  RISK_TAGS,
  TEMPLATE_VARIABLES,
  type ReplyConfigSnapshot,
  type ReplyProfile,
  type ReplyRule,
  type ReplyTemplate,
  type TemplateVariable,
} from '../kernel/interaction-types.js';
// change cloud-coupling-p3-8：本文件的纯函数段已迁入 kernel 的互动回复契约；
// 这里取回两样本地仍要用的东西——知识文档长度上限（isReplyProfile 用）与时刻格式守卫（isReplyRule 用）。
import { isHhMmTime, MAX_KNOWLEDGE_DOCUMENT_LENGTH } from '../kernel/interaction-reply-contract.js';

const VARIABLE_SET = new Set<string>(TEMPLATE_VARIABLES);
const INTENTS = new Set([
  'gratitude','general_question','product_question','support_request','complaint','order','refund',
  'pricing','promotion','inventory','shipping','personal_data','medical','legal','abuse','minor_safety','other','unknown',
]);
const MESSAGE_TYPES = new Set(['text', 'image', 'unknown']);
const RISK_TAG_SET = new Set<string>(RISK_TAGS);
const REPLY_PROFILE_KEYS = [
  'channel','selfName','userAddress','tone','maxLength','allowEmoji','allowLinks','blockedPhrases',
  'disallowedClaims','requiredDisclaimer','variableFallbacks',
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function stringArray(value: unknown, allowed?: Set<string>, max = 100): value is string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string')) return false;
  const items = value as string[];
  return new Set(items).size === items.length && items.every((item) => item === item.trim() && item.length > 0 &&
    item.length <= 256 && (!allowed || allowed.has(item)));
}

function channel(value: unknown): value is 'comment' | 'dm' { return value === 'comment' || value === 'dm'; }
function validId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 256;
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 128;
}
function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

export function isReplyPolicy(value: unknown): value is ReplyConfigSnapshot['policy'] {
  if (!object(value) || !onlyKeys(value, ['mode','generateDrafts','sendReplies','channels','rateLimits']) ||
      !['draft_only','review_before_send','auto_safe'].includes(String(value.mode)) ||
      typeof value.generateDrafts !== 'boolean' || typeof value.sendReplies !== 'boolean' ||
      !object(value.channels) || !onlyKeys(value.channels, ['comment','dm']) || !object(value.rateLimits)) return false;
  for (const key of ['comment','dm']) {
    const item = value.channels[key];
    if (!object(item) || !onlyKeys(item, ['enabled','aiPolishEnabled','allowAutoSend']) ||
        Object.values(item).some((field) => typeof field !== 'boolean')) return false;
  }
  const limitKeys = ['accountPerMinute','accountPerHour','accountPerDay','threadCooldownSeconds','newLoginCooldownSeconds','consecutiveFailureLimit'];
  const rateLimits = value.rateLimits as Record<string, unknown>;
  const maxima: Record<string, number> = { accountPerMinute: 60, accountPerHour: 1_000, accountPerDay: 10_000,
    threadCooldownSeconds: 604_800, newLoginCooldownSeconds: 604_800, consecutiveFailureLimit: 100 };
  return onlyKeys(rateLimits, limitKeys) && limitKeys.every((key) => Number.isInteger(rateLimits[key]) &&
    (rateLimits[key] as number) >= (key === 'consecutiveFailureLimit' ? 1 : 0) &&
    (rateLimits[key] as number) <= maxima[key]);
}

export function isReplyTemplate(value: unknown): value is ReplyTemplate {
  if (!object(value) || !onlyKeys(value, ['templateId','channel','name','content','enabled','archived','templateVersion','variables','updatedAt','updatedBy']) ||
      !validId(value.templateId) || !channel(value.channel) || !validName(value.name) ||
      typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4_000 ||
      typeof value.enabled !== 'boolean' || typeof value.archived !== 'boolean' ||
      !Number.isInteger(value.templateVersion) || (value.templateVersion as number) < 1 ||
      !stringArray(value.variables, VARIABLE_SET, 4)) return false;
  return typeof value.updatedAt === 'number' && Number.isInteger(value.updatedAt) && value.updatedAt >= 0 &&
    typeof value.updatedBy === 'string' && !!value.updatedBy;
}

export function isReplyRule(value: unknown): value is ReplyRule {
  if (!object(value) || !onlyKeys(value, ['ruleId','channel','name','priority','enabled','conditions','actions','updatedAt','updatedBy']) ||
      !validId(value.ruleId) || !channel(value.channel) || !validName(value.name) || !Number.isInteger(value.priority) ||
      (value.priority as number) < 0 || (value.priority as number) > 1_000_000 || typeof value.enabled !== 'boolean' ||
      !object(value.conditions) || !object(value.actions)) return false;
  const conditions = value.conditions;
  if (!onlyKeys(conditions, ['keywordsAny','intentsAny','sourceExternalIds','messageTypes','workHours']) ||
      !stringArray(conditions.keywordsAny) || !stringArray(conditions.intentsAny, INTENTS) ||
      !stringArray(conditions.sourceExternalIds) || !stringArray(conditions.messageTypes, MESSAGE_TYPES) ||
      conditions.messageTypes.length < 1) return false;
  if (conditions.workHours !== null && (!object(conditions.workHours) ||
      !onlyKeys(conditions.workHours, ['timezone','start','end']) ||
      !validTimezone(conditions.workHours.timezone) || !isHhMmTime(String(conditions.workHours.start)) ||
      !isHhMmTime(String(conditions.workHours.end)) || conditions.workHours.start === conditions.workHours.end)) return false;
  const actions = value.actions;
  if (!onlyKeys(actions, ['templateId','polish','allowAutoSend','forceHumanTags']) ||
      !validId(actions.templateId) || typeof actions.polish !== 'boolean' ||
      typeof actions.allowAutoSend !== 'boolean' || !stringArray(actions.forceHumanTags, RISK_TAG_SET, 32)) return false;
  return typeof value.updatedAt === 'number' && Number.isInteger(value.updatedAt) && value.updatedAt >= 0 &&
    typeof value.updatedBy === 'string' && !!value.updatedBy;
}

export function isReplyProfile(value: unknown): value is ReplyProfile {
  if (!object(value) || !(onlyKeys(value, REPLY_PROFILE_KEYS) ||
      onlyKeys(value, [...REPLY_PROFILE_KEYS, 'knowledgeDocument'])) ||
      !channel(value.channel) || !validName(value.selfName) || !validName(value.userAddress) ||
      !stringArray(value.tone, new Set(['professional','friendly','concise']), 4) ||
      value.tone.length < 1 ||
      !Number.isInteger(value.maxLength) || (value.maxLength as number) < 1 || (value.maxLength as number) > 4_000 ||
      typeof value.allowEmoji !== 'boolean' || typeof value.allowLinks !== 'boolean' ||
      !stringArray(value.blockedPhrases) || !stringArray(value.disallowedClaims) ||
      !(value.requiredDisclaimer === null || (typeof value.requiredDisclaimer === 'string' &&
        value.requiredDisclaimer === value.requiredDisclaimer.trim() && value.requiredDisclaimer.length > 0 &&
        value.requiredDisclaimer.length <= 4_096)) ||
      !(value.knowledgeDocument === undefined || value.knowledgeDocument === null ||
        (typeof value.knowledgeDocument === 'string' &&
          value.knowledgeDocument.length <= MAX_KNOWLEDGE_DOCUMENT_LENGTH)) ||
      !object(value.variableFallbacks) ||
      !onlyKeys(value.variableFallbacks, TEMPLATE_VARIABLES)) return false;
  const fallbacks = value.variableFallbacks as Record<string, unknown>;
  const maxima: Record<TemplateVariable, number> = {
    user_name: 256, video_title: 256, account_name: 256, support_channel: 512,
  };
  return TEMPLATE_VARIABLES.every((key) => typeof fallbacks[key] === 'string' &&
    (fallbacks[key] as string) === (fallbacks[key] as string).trim() &&
    (fallbacks[key] as string).length > 0 && (fallbacks[key] as string).length <= maxima[key]);
}

/** Normalizes legacy profiles and whitespace-only admin input without mutating the caller. */
export function normalizeReplyProfile(profile: ReplyProfile): ReplyProfile {
  return {
    ...structuredClone(profile),
    knowledgeDocument: profile.knowledgeDocument?.trim() || null,
  };
}












