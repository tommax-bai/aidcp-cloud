/**
 * Facebook 评论撰写 prompt：整文件为纯 prompt 构建（仅依赖 kernel 的写作语言指令与人设类型），
 * 已 git mv 到 kernel（src/kernel/facebook-comment-composer-prompt.ts，change decouple-behavior-class-ports）。
 * 本文件保留旧导入面 `from '../comment-agent/facebook-comment-composer-prompt.js'` 逐字不变（re-export），
 * automation 层内部消费方无感；跨边界消费方直接从 kernel 导入以消去跨层依赖。
 */
export * from '../kernel/facebook-comment-composer-prompt.js';
