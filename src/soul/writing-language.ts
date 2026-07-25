/**
 * 写作语言取值与守卫的**再导出壳**（api 属主，§4.7 人设文档模型）。
 *
 * 取值 / 守卫 / 标签 / prompt 指令 / 文本-语言启发式三态校验**全部住在**
 * `src/kernel/writing-language.ts`，content / automation / api 三域一律直接依赖 kernel。
 *
 * 本文件只剩再导出，**有意不删**：`src/soul/index.ts` 的桶链经它取用（组合根就走那条链拿三态校验），
 * 整文件搬走会当场打断桶链。既有导入方一字不改、行为逐字不变。
 */
export {
  checkWritingLanguage,
  isWritingLanguage,
  writingLanguageInstruction,
  writingLanguageLabel,
  WRITING_LANGUAGE_VALUES,
  type WritingLanguageCheck,
} from '../kernel/writing-language.js';
