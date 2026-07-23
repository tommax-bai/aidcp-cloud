import type { WritingLanguage } from '../kernel/soul-types.js';

export const WRITING_LANGUAGE_VALUES = ['zh-CN', 'en', 'vi'] as const satisfies readonly WritingLanguage[];
const WRITING_LANGUAGE_SET = new Set<string>(WRITING_LANGUAGE_VALUES);

export type WritingLanguageCheck = 'match' | 'mismatch' | 'uncertain';

export function isWritingLanguage(value: unknown): value is WritingLanguage {
  return typeof value === 'string' && WRITING_LANGUAGE_SET.has(value);
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
