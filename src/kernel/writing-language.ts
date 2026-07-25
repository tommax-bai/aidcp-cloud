/**
 * 写作语言契约（纯 kernel 段）。
 *
 * 这里放**跨边界共享、且不含模块级可变容器单例的纯函数/纯类型**：语言标签、写作语言 prompt 指令、
 * 保守的文本-语言启发式三态校验。供 content（发布角色 / 评论撰写 prompt）与 automation（评论撰写 /
 * 去 AI 味）两域直接依赖。
 *
 * `isWritingLanguage` 与 `WRITING_LANGUAGE_VALUES` **已于 change cloud-coupling-phase0 迁入本文件**。
 * 此前它们留在 `src/soul/writing-language.ts`（api），理由是守卫依赖一个模块级 `new Set(...)`，
 * 而门禁把模块级 `const = new Set/Map` 判为「进程内活状态（可变单例）」直接拒入 —— 但**挡住的是那个 Set，
 * 不是守卫本身**：取值只有三个，用只读数组的 `includes` 一样判，且再没有任何可变单例。
 * 原 api 文件退化为纯再导出（不能整文件搬走：桶链上还有别的消费方经它取用）。
 *
 * kernel 准入：无 SQL / 无 HTTP / 无 fetch / 无模块级可变单例 / 不反向依赖业务层。
 */
import type { WritingLanguage } from './soul-types.js';

export type WritingLanguageCheck = 'match' | 'mismatch' | 'uncertain';

/** 写作语言的全部合法取值（与 `WritingLanguage` 联合逐字对齐，由 satisfies 保证不漂）。 */
export const WRITING_LANGUAGE_VALUES = ['zh-CN', 'en', 'vi'] as const satisfies readonly WritingLanguage[];

/**
 * 写作语言守卫。用只读数组的 `includes` 而不是模块级 Set：三个取值，查找差异不可观测，
 * 但换来「kernel 里没有任何进程内活状态」这条准入硬要求。
 */
export function isWritingLanguage(value: unknown): value is WritingLanguage {
  return typeof value === 'string' && (WRITING_LANGUAGE_VALUES as readonly string[]).includes(value);
}

export function writingLanguageLabel(language: WritingLanguage): string {
  switch (language) {
    case 'zh-CN': return '简体中文';
    case 'en': return '英文';
    case 'vi': return '越南语';
  }
}

/**
 * Public-text prompt contract. Source material may use any language, but the account
 * always writes in its configured language and must not translate at dispatch time.
 */
export function writingLanguageInstruction(language: WritingLanguage): string {
  const label = writingLanguageLabel(language);
  return `最终公开正文必须只使用${label}自然表达；可以理解其它语言的来源内容，但不得跟随来源切换输出语言，也不得先用其它语言成稿后再翻译。`;
}

const HAN_RE = /\p{Script=Han}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;
const VIETNAMESE_MARK_RE = /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gu;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/**
 * Conservative, dependency-free pre-review guard. It only returns match when the
 * target script has positive evidence; short Latin-only Vietnamese intentionally
 * remains uncertain instead of being mislabeled English.
 */
export function checkWritingLanguage(text: string, language: WritingLanguage): WritingLanguageCheck {
  const normalized = text.normalize('NFC').trim();
  if (!normalized) return 'mismatch';
  const han = countMatches(normalized, HAN_RE);
  const latin = countMatches(normalized, LATIN_RE);
  const vietnameseMarks = countMatches(normalized, VIETNAMESE_MARK_RE);

  if (language === 'zh-CN') {
    if (han >= 2) return 'match';
    if (han === 0 && latin >= 5) return 'mismatch';
    return 'uncertain';
  }
  if (language === 'vi') {
    if (han > 0) return 'mismatch';
    if (vietnameseMarks > 0) return 'match';
    return 'uncertain';
  }
  if (han > 0 || vietnameseMarks > 0) return 'mismatch';
  return latin >= 5 ? 'match' : 'uncertain';
}
