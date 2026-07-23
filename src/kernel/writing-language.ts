/**
 * 写作语言契约（纯 kernel 段）。
 *
 * 这里放**跨边界共享、且不含模块级可变容器单例的纯函数/纯类型**：语言标签、写作语言 prompt 指令、
 * 保守的文本-语言启发式三态校验。供 content（发布角色 / 评论撰写 prompt）与 automation（评论撰写 /
 * 去 AI 味）两域直接依赖。
 *
 * `isWritingLanguage` 及其依赖的模块级 `WRITING_LANGUAGE_SET`（`new Set(...)`）**不进 kernel**：
 * 门禁 §4.7 kernel 准入把模块级 `const = new Set/Map` 列为「进程内活状态（可变单例）」而禁止，
 * 故守卫函数与该 Set + `WRITING_LANGUAGE_VALUES` 留在 `src/soul/writing-language.ts`（api）。
 *
 * kernel 准入：无 SQL / 无 HTTP / 无 fetch / 无模块级可变单例 / 不反向依赖业务层。
 */
import type { WritingLanguage } from './soul-types.js';

export type WritingLanguageCheck = 'match' | 'mismatch' | 'uncertain';

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
