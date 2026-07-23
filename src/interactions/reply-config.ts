import {
  HARD_RISK_TAGS,
  RISK_TAGS,
  TEMPLATE_VARIABLES,
  type MinimalInbound,
  type ReplyConfigSnapshot,
  type ReplyIntent,
  type ReplyProfile,
  type ReplyRule,
  type ReplyTemplate,
  type RiskTag,
  type TemplateVariable,
  type ValidationIssue,
} from '../kernel/interaction-types.js';
// 无 Set 依赖的纯校验函数 validateFinalReplyText 析出到 kernel（change decouple-llm-lang-interaction-contracts），
// 供 automation 侧直接依赖 kernel；本文件内部渲染仍复用它，并对既有导入方等值再导出。
import { validateFinalReplyText } from '../kernel/interaction-reply-contract.js';
export { validateFinalReplyText } from '../kernel/interaction-reply-contract.js';

const VARIABLE_SET = new Set<string>(TEMPLATE_VARIABLES);
const HARD_RISK_SET = new Set<RiskTag>(HARD_RISK_TAGS);
const PLACEHOLDER = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const INTENTS = new Set([
  'gratitude','general_question','product_question','support_request','complaint','order','refund',
  'pricing','promotion','inventory','shipping','personal_data','medical','legal','abuse','minor_safety','other','unknown',
]);
const MESSAGE_TYPES = new Set(['text', 'image', 'unknown']);
const RISK_TAG_SET = new Set<string>(RISK_TAGS);
export const MAX_KNOWLEDGE_DOCUMENT_LENGTH = 20_000;
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
      !validTimezone(conditions.workHours.timezone) || !validTime(String(conditions.workHours.start)) ||
      !validTime(String(conditions.workHours.end)) || conditions.workHours.start === conditions.workHours.end)) return false;
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

export interface TemplateValues {
  user_name: string | null;
  video_title: string | null;
  account_name: string | null;
  support_channel: string | null;
}

export interface RuleMatchInput {
  inbound: MinimalInbound;
  intent: ReplyIntent;
  sourceExternalId: string | null;
  now?: number;
}

/**
 * Deterministic high-risk claim gate. This deliberately does not consume any
 * model-reported `meaningChanged` / `introducedClaims` / `riskLevel` field.
 * Matches force human review; they are not a semantic classifier and therefore
 * prefer a conservative false positive over an unsafe automatic promise.
 */
export function deterministicClaimTags(text: string): RiskTag[] {
  const patterns: ReadonlyArray<readonly [RiskTag, RegExp]> = [
    ['pricing', /(?:[¥￥$]\s*\d|(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+)\s*(?:元|块钱|rmb|cny|usd)|价格|售价|价钱|多少钱|price\b)/iu],
    ['promotion', /(?:(?:\d(?:\.\d)?|[一二三四五六七八九十])\s*折|折扣|优惠|促销|活动价|满减|立减|买一送一|赠品|优惠券|coupon|discount|promotion|\bsale\b)/iu],
    ['refund', /(?:退款|退货|无条件退|全额退|包退|refund|return\s+policy)/iu],
    ['order', /(?:订单|下单|付款|支付|发货|\border(?:\s+(?:id|number|status))?\b)/iu],
    ['after_sales', /(?:售后|保修|质保|维修|换货|after[ -]?sales|warranty)/iu],
    ['introduced_claim', /(?:补偿|赔偿|赔付|返现|补发|赠送|compensat(?:e|ion)|cashback)/iu],
  ];
  return [...new Set(patterns.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag))];
}

function variablesIn(content: string): string[] {
  return [...content.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function sameConditions(left: ReplyRule, right: ReplyRule): boolean {
  const normalize = (rule: ReplyRule): string => JSON.stringify({
    channel: rule.channel,
    keywordsAny: [...rule.conditions.keywordsAny].map((v) => v.trim().toLocaleLowerCase()).sort(),
    intentsAny: [...rule.conditions.intentsAny].sort(),
    sourceExternalIds: [...rule.conditions.sourceExternalIds].sort(),
    messageTypes: [...rule.conditions.messageTypes].sort(),
    workHours: rule.conditions.workHours ? {
      timezone: rule.conditions.workHours.timezone,
      start: rule.conditions.workHours.start,
      end: rule.conditions.workHours.end,
    } : null,
  });
  return normalize(left) === normalize(right);
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function validateReplyConfig(snapshot: ReplyConfigSnapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (snapshot.templates.length > 100) {
    issues.push({ path: 'templates', code: 'too_many_items', message: '模板数量不能超过 100。' });
  }
  if (snapshot.rules.length > 100) {
    issues.push({ path: 'rules', code: 'too_many_items', message: '规则数量不能超过 100。' });
  }
  const templateById = new Map(snapshot.templates.map((template) => [template.templateId, template]));
  const profiles = new Map(snapshot.profiles.map((profile) => [profile.channel, profile]));

  for (const channel of ['comment', 'dm'] as const) {
    if (!profiles.has(channel)) issues.push({ path: `profiles.${channel}`, code: 'required', message: '缺少账号回复 profile。' });
  }
  for (const profile of snapshot.profiles) {
    if (profile.maxLength < 1 || profile.maxLength > 4_000) {
      issues.push({ path: `profiles.${profile.channel}.maxLength`, code: 'range', message: '长度必须为 1-4000。' });
    }
    if (profile.knowledgeDocument !== undefined && profile.knowledgeDocument !== null &&
        profile.knowledgeDocument.trim().length > MAX_KNOWLEDGE_DOCUMENT_LENGTH) {
      issues.push({
        path: `profiles.${profile.channel}.knowledgeDocument`,
        code: 'too_long',
        message: `AI 回答说明文档不能超过 ${MAX_KNOWLEDGE_DOCUMENT_LENGTH} 个字符。`,
      });
    }
    for (const variable of TEMPLATE_VARIABLES) {
      if (typeof profile.variableFallbacks[variable] !== 'string') {
        issues.push({ path: `profiles.${profile.channel}.variableFallbacks.${variable}`, code: 'required', message: '变量回退必须显式配置。' });
      }
    }
  }

  for (const template of snapshot.templates) {
    if (!template.content.trim()) issues.push({ path: `templates.${template.templateId}.content`, code: 'required', message: '模板不能为空。' });
    const discovered = variablesIn(template.content);
    for (const variable of discovered) {
      if (!VARIABLE_SET.has(variable)) {
        issues.push({ path: `templates.${template.templateId}.content`, code: 'unknown_variable', message: `不允许的模板变量：${variable}` });
      }
    }
    const declared = [...new Set(template.variables)].sort();
    const actual = [...new Set(discovered.filter((v): v is TemplateVariable => VARIABLE_SET.has(v)))].sort();
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      issues.push({ path: `templates.${template.templateId}.variables`, code: 'variable_mismatch', message: '变量声明与模板正文不一致。' });
    }
  }

  const enabledRules = snapshot.rules.filter((rule) => rule.enabled);
  for (const rule of enabledRules) {
    const template = templateById.get(rule.actions.templateId);
    if (!template || !template.enabled || template.archived) {
      issues.push({ path: `rules.${rule.ruleId}.actions.templateId`, code: 'template_unavailable', message: '规则引用的模板不存在、未启用或已归档。' });
    } else if (template.channel !== rule.channel) {
      issues.push({ path: `rules.${rule.ruleId}.actions.templateId`, code: 'channel_mismatch', message: '规则与模板渠道不一致。' });
    }
    const hours = rule.conditions.workHours;
    if (hours && (!validTime(hours.start) || !validTime(hours.end) || hours.start === hours.end)) {
      issues.push({ path: `rules.${rule.ruleId}.conditions.workHours`, code: 'invalid_time', message: '工作时间必须为 HH:mm。' });
    }
  }
  for (let index = 0; index < enabledRules.length; index += 1) {
    for (let other = index + 1; other < enabledRules.length; other += 1) {
      const left = enabledRules[index];
      const right = enabledRules[other];
      if (left.priority === right.priority && sameConditions(left, right) && left.actions.templateId !== right.actions.templateId) {
        issues.push({ path: `rules.${right.ruleId}`, code: 'ambiguous_rule', message: `与规则 ${left.ruleId} 同优先级且条件相同。` });
      }
    }
  }
  if (snapshot.policy.mode === 'auto_safe' && snapshot.policy.sendReplies) {
    for (const channel of ['comment', 'dm'] as const) {
      const limits = snapshot.policy.rateLimits;
      if (snapshot.policy.channels[channel].allowAutoSend &&
          (limits.accountPerMinute <= 0 || limits.accountPerHour <= 0 || limits.accountPerDay <= 0)) {
        issues.push({ path: `policy.channels.${channel}.allowAutoSend`, code: 'rate_limit_required', message: '自动发送必须配置正数限额。' });
      }
    }
  }
  return issues;
}

function withinWorkHours(rule: ReplyRule, now: number): boolean {
  const hours = rule.conditions.workHours;
  if (!hours) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: hours.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    const current = `${hour}:${minute}`;
    return hours.start <= hours.end
      ? current >= hours.start && current < hours.end
      : current >= hours.start || current < hours.end;
  } catch {
    return false;
  }
}

export function matchReplyRule(snapshot: ReplyConfigSnapshot, input: RuleMatchInput): ReplyRule | null {
  const text = input.inbound.text?.toLocaleLowerCase() ?? '';
  const candidates = snapshot.rules
    .filter((rule) => rule.enabled && rule.channel === input.inbound.channel)
    .sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
  for (const rule of candidates) {
    const conditions = rule.conditions;
    if (conditions.keywordsAny.length && !conditions.keywordsAny.some((keyword) => text.includes(keyword.trim().toLocaleLowerCase()))) continue;
    if (conditions.intentsAny.length && !conditions.intentsAny.includes(input.intent)) continue;
    if (conditions.sourceExternalIds.length && (!input.sourceExternalId || !conditions.sourceExternalIds.includes(input.sourceExternalId))) continue;
    if (conditions.messageTypes.length && !conditions.messageTypes.includes(input.inbound.messageType)) continue;
    if (!withinWorkHours(rule, input.now ?? Date.now())) continue;
    return rule;
  }
  return null;
}

function safeValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function renderReplyTemplate(template: ReplyTemplate, profile: ReplyProfile, values: TemplateValues): string {
  if (template.archived || !template.enabled || template.channel !== profile.channel) throw new Error('template_unavailable');
  let text = template.content.replace(PLACEHOLDER, (_match, raw: string) => {
    if (!VARIABLE_SET.has(raw)) throw new Error(`unknown_template_variable:${raw}`);
    const variable = raw as TemplateVariable;
    const selected = values[variable] ?? profile.variableFallbacks[variable];
    if (!selected?.trim()) throw new Error(`missing_template_variable:${variable}`);
    return safeValue(selected);
  }).trim();
  const disclaimer = profile.requiredDisclaimer?.trim();
  if (disclaimer && !text.includes(disclaimer)) text = `${text}\n${disclaimer}`;
  if (!text || /{{\s*[a-zA-Z0-9_]+\s*}}/.test(text)) throw new Error('template_render_incomplete');
  const issue = validateFinalReplyText(profile, text)[0];
  if (issue) throw new Error(`template_${issue.code}`);
  return text;
}

export function forcedHumanRisk(rule: ReplyRule | null, classifierTags: RiskTag[]): boolean {
  const configured = new Set(rule?.actions.forceHumanTags ?? []);
  return classifierTags.some((tag) => HARD_RISK_SET.has(tag) && configured.has(tag));
}
