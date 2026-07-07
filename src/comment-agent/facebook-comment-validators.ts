/**
 * Facebook 无人值守评论的确定性硬校验器（facebook-scheduled-comment 3.2）。
 *
 * 与 xhs 评论的 sanitize-then-post 不同：Facebook 自动评论没有逐条人审，安全模型是
 * **只拒不修**——任一硬规则不过即整条 attempt 终局失败（reason=compose_skipped 家族），
 * MUST NOT 自动修复后照发、MUST NOT 用模板/占位替代（llm-output-honesty delta）。
 *
 * 纯函数、无副作用、无外部依赖：可脱离浏览器/网络完整单测（对齐仓内「桩可测」纪律）。
 * 校验器只回「能不能发 + 为什么不能」，绝不改写文本、绝不决定发布（发布仍由上游经服务器确认闭环）。
 */

import { FB_COMMENT_PROFILE } from '../platform/registry.js';

/** 拒绝原因（稳定字符串，供审计/告警/测试断言）。 */
export type FacebookCommentRejectReason =
  | 'empty' // 去空白后为空
  | 'low_signal' // 只有标点/表情/空白，无实义字符
  | 'too_short' // 实义字符过少
  | 'too_long' // 超平台软上限
  | 'contains_url' // 含链接或裸域名
  | 'contains_contact' // 含电话/邮箱/微信等联系方式
  | 'contains_mention' // 含 @ 提及（会触发提及弹窗 + 骚扰风险）
  | 'spam_phrase' // 命中垃圾/营销短语
  | 'weak_relevance'; // 与目标语境零相关（仅在提供目标关键词时判定）

export interface FacebookCommentValidationContext {
  /** 长度软上限；缺省取 FB 平台 profile。 */
  maxLength?: number;
  /** 实义字符下限（含 CJK/字母/数字），默认 2。 */
  minSignalChars?: number;
  /**
   * 目标语境关键词（帖子标题/正文抽取的词）。提供且非空时启用相关性闸：
   * 评论与全部关键词零 token 重叠 → weak_relevance。不提供则跳过（确定性上无法判定相关性）。
   */
  targetKeywords?: string[];
}

export type FacebookCommentValidation =
  | { ok: true; text: string }
  | { ok: false; reason: FacebookCommentRejectReason };

// 链接 / 裸域名：http(s)://、www.、或 name.tld（常见 TLD）。
const URL_RE = /(https?:\/\/|www\.)\S+/i;
const BARE_DOMAIN_RE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(com|net|org|io|cn|me|co|xyz|link|shop|store|info|top|vip|app|site|online|biz|to|ly|gg|tv|be|us|uk|ai|fb)\b(\/\S*)?/i;

// 联系方式：邮箱、连续 7+ 位数字（电话）、即时通讯 id 关键词。
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:\d[\s-]?){7,}/;
const IM_CONTACT_RE =
  /(微信|weixin|wechat|加\s*v|\bvx\b|\bwx\b|\bqq\b|telegram|whats\s?app|\bline\s*id\b|\bkakao\b|私信我|加我(好友)?|dm\s*me|私聊|扫码)/i;

// @ 提及：@ 后跟字母/数字/下划线/CJK。
const MENTION_RE = /@[\w一-鿿]/;

// 实义字符（CJK / 字母 / 数字）——用于 empty/low_signal/too_short 判定与相关性 token 化。
const SIGNAL_CHAR_RE = /[\p{L}\p{N}]/u;
const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

// 垃圾/营销短语黑名单（英文 + 中文），子串匹配、大小写不敏感。
const SPAM_PHRASES: readonly string[] = [
  'click here',
  'buy now',
  'check out my',
  'dm me',
  'follow me',
  'follow back',
  'link in bio',
  'promo code',
  'limited offer',
  'free gift',
  'make money',
  'work from home',
  'subscribe to',
  'click the link',
  'f4f',
  'l4l',
  '点击链接',
  '扫码',
  '加微信',
  '免费领',
  '限时',
  '代购',
  '私聊我',
  '关注我',
  '一件代发',
];

/** 实义字符数（去标点/表情/空白后的 CJK/字母/数字个数）。 */
function signalCharCount(text: string): number {
  let n = 0;
  for (const ch of text) if (SIGNAL_CHAR_RE.test(ch)) n += 1;
  return n;
}

/**
 * 校验一条 Facebook 无人值守评论。按确定性顺序检查，返回**第一条**不过的原因；
 * 全过则返回 { ok:true, text }（text 为 trim 后的原文，绝不改写内容）。
 */
export function validateFacebookComment(
  raw: string | null | undefined,
  ctx: FacebookCommentValidationContext = {},
): FacebookCommentValidation {
  const maxLength = ctx.maxLength ?? FB_COMMENT_PROFILE.maxCommentLength;
  const minSignal = ctx.minSignalChars ?? 2;
  const text = (raw ?? '').trim();

  if (text.length === 0) return { ok: false, reason: 'empty' };

  const signal = signalCharCount(text);
  if (signal === 0) return { ok: false, reason: 'low_signal' };
  if (signal < minSignal) return { ok: false, reason: 'too_short' };
  if (text.length > maxLength) return { ok: false, reason: 'too_long' };

  if (URL_RE.test(text) || BARE_DOMAIN_RE.test(text)) return { ok: false, reason: 'contains_url' };
  if (EMAIL_RE.test(text) || PHONE_RE.test(text) || IM_CONTACT_RE.test(text))
    return { ok: false, reason: 'contains_contact' };
  if (MENTION_RE.test(text)) return { ok: false, reason: 'contains_mention' };

  const lower = text.toLowerCase();
  if (SPAM_PHRASES.some((p) => lower.includes(p))) return { ok: false, reason: 'spam_phrase' };

  // 相关性闸（仅在提供目标关键词时）：评论 token 与任一关键词有交集即通过；零交集 → weak_relevance。
  const keywords = (ctx.targetKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  if (keywords.length > 0) {
    // 子串匹配（对 CJK 无分词、对英文亦可）：评论含任一关键词（或其拆词）即算相关。
    // 保守取向——只在**零**重叠时判 weak_relevance，宁可少拒不可误拒。
    const overlaps = keywords.some((kw) => {
      if (lower.includes(kw)) return true;
      const kwTokens = kw.match(TOKEN_RE) ?? [];
      return kwTokens.some((t) => lower.includes(t));
    });
    if (!overlaps) return { ok: false, reason: 'weak_relevance' };
  }

  return { ok: true, text };
}
