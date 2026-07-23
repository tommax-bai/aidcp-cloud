/**
 * 写作语言取值与守卫（api 属主，§4.7 人设文档模型）。
 *
 * 纯函数/纯类型部分（语言标签、写作语言 prompt 指令、文本-语言启发式三态校验）已析出到
 * `src/kernel/writing-language.ts`（change decouple-llm-lang-interaction-contracts），content /
 * automation 直接依赖 kernel、不再跨边界直连本 api 文件。本文件保留 `isWritingLanguage` 守卫与其依赖的
 * 模块级 `WRITING_LANGUAGE_SET`（`new Set(...)` 被门禁 §4.7 判为「进程内活状态」故不入 kernel），并对
 * kernel 段等值再导出，既有导入方无感、行为逐字不变。
 */
import type { WritingLanguage } from '../kernel/soul-types.js';

export const WRITING_LANGUAGE_VALUES = ['zh-CN', 'en', 'vi'] as const satisfies readonly WritingLanguage[];
const WRITING_LANGUAGE_SET = new Set<string>(WRITING_LANGUAGE_VALUES);

export function isWritingLanguage(value: unknown): value is WritingLanguage {
  return typeof value === 'string' && WRITING_LANGUAGE_SET.has(value);
}

export {
  checkWritingLanguage,
  writingLanguageInstruction,
  writingLanguageLabel,
  type WritingLanguageCheck,
} from '../kernel/writing-language.js';
