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
import type {
  ReplyConfigSnapshot,
  ReplyProfile,
  ValidationIssue,
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
