/**
 * 互动回复契约（纯 kernel 段）。
 *
 * 这里放**跨边界共享、且满足 §4.7 kernel 准入（无 SQL / 无模块级可变容器单例 / 无连库）的纯物**：
 * - 最终回复文本的无状态校验 `validateFinalReplyText`（只读 profile 字段 + 内联正则，无模块 Set/Map）；
 * - 有效回复配置的只读端口 `ReplyConfigReader` 与两个无状态读取函数 `readPublishedConfig` / `readJobConfig`
 *   （只对注入的 reader 端口取数、不连库）。
 *
 * 属主边界（change decouple-llm-lang-interaction-contracts）：
 * - `validateFinalReplyText` 原在 `src/interactions/reply-config.ts`（api，§4.6.1）。该文件其余校验/渲染
 *   函数依赖模块级 `const … = new Set(…)`（VARIABLE_SET / HARD_RISK_SET / INTENTS / …），被门禁 §4.7 判为
 *   「进程内活状态（可变单例）」而**不能入 kernel**，故只析出这一支无 Set 依赖的纯函数；其余留 reply-config.ts。
 * - reader 端口与两读取函数原在 `reply-config-resolver.ts`（api）；连库的 `ReplyConfigResolver` 类留原文件。
 * 两 api 原文件保持属主并对本文件等值再导出。
 */
import {
  HARD_RISK_TAGS,
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
} from './interaction-types.js';

export function validateFinalReplyText(profile: ReplyProfile, text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!text.trim()) issues.push({ path: 'finalText', code: 'empty', message: '回复内容不能为空。' });
  if (text.length > profile.maxLength) issues.push({ path: 'finalText', code: 'too_long', message: '回复内容超过账号长度限制。' });
  if (!profile.allowLinks && /https?:\/\/|www\./i.test(text)) {
    issues.push({ path: 'finalText', code: 'link_forbidden', message: '账号 profile 禁止链接。' });
  }
  if (!profile.allowEmoji && /\p{Extended_Pictographic}/u.test(text)) {
    issues.push({ path: 'finalText', code: 'emoji_forbidden', message: '账号 profile 禁止表情符号。' });
  }
  if (profile.blockedPhrases.some((phrase) => phrase && text.includes(phrase))) {
    issues.push({ path: 'finalText', code: 'blocked_phrase', message: '回复命中账号禁用短语。' });
  }
  if (profile.disallowedClaims.some((claim) => claim && text.includes(claim))) {
    issues.push({ path: 'finalText', code: 'disallowed_claim', message: '回复命中账号禁止声明。' });
  }
  if (profile.requiredDisclaimer?.trim() && !text.includes(profile.requiredDisclaimer.trim())) {
    issues.push({ path: 'finalText', code: 'required_disclaimer_missing', message: '回复缺少账号必需免责声明。' });
  }
  return issues;
}

/**
 * 有效回复配置的只读端口（原 `reply-config-resolver.ts`）。纯接口，不含实现；
 * `ReplyConfigResolver`（连库）在原文件里实现之。
 */
export interface ReplyConfigReader {
  getPublished?(accountId: string): Promise<ReplyConfigSnapshot | null>;
  getSnapshotForJob?(
    accountId: string,
    scopeId: string | null | undefined,
    version: number,
  ): Promise<ReplyConfigSnapshot | null>;
  getSnapshot?(accountId: string, selector: 'draft' | 'published' | number): Promise<ReplyConfigSnapshot | null>;
}

export async function readPublishedConfig(reader: ReplyConfigReader, accountId: string): Promise<ReplyConfigSnapshot | null> {
  if (reader.getPublished) return reader.getPublished(accountId);
  return reader.getSnapshot?.(accountId, 'published') ?? null;
}

export async function readJobConfig(
  reader: ReplyConfigReader,
  accountId: string,
  scopeId: string | null | undefined,
  version: number,
): Promise<ReplyConfigSnapshot | null> {
  if (reader.getSnapshotForJob) return reader.getSnapshotForJob(accountId, scopeId, version);
  return scopeId ? null : reader.getSnapshot?.(accountId, version) ?? null;
}

/* ---------------------------------------------------------------- 追加：P3-8 从 src/interactions/reply-config.ts 迁入的 5 个纯函数 */

/** 模板变量名的只读字符串视图（取代原 reply-config.ts 的模块级 VARIABLE_SET）。 */
const VARIABLE_NAMES: readonly string[] = TEMPLATE_VARIABLES;

export const MAX_KNOWLEDGE_DOCUMENT_LENGTH = 20_000;

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
  return [...content.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]);
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

/** HH:mm 时刻校验（原 reply-config.ts 私有 validTime；api 侧 isReplyRule 仍复用之，故导出）。 */
export function isHhMmTime(value: string): boolean {
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
      if (!VARIABLE_NAMES.includes(variable)) {
        issues.push({ path: `templates.${template.templateId}.content`, code: 'unknown_variable', message: `不允许的模板变量：${variable}` });
      }
    }
    const declared = [...new Set(template.variables)].sort();
    const actual = [...new Set(discovered.filter((v): v is TemplateVariable => VARIABLE_NAMES.includes(v)))].sort();
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
    if (hours && (!isHhMmTime(hours.start) || !isHhMmTime(hours.end) || hours.start === hours.end)) {
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
  let text = template.content.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, raw: string) => {
    if (!VARIABLE_NAMES.includes(raw)) throw new Error(`unknown_template_variable:${raw}`);
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
  const configured: readonly RiskTag[] = rule?.actions.forceHumanTags ?? [];
  return classifierTags.some((tag) => HARD_RISK_TAGS.includes(tag) && configured.includes(tag));
}
