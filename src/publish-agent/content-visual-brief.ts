/**
 * 正文视觉 brief 归一/兜底/格式化：整文件为纯函数与纯数据（仅依赖 kernel 视觉参考类型，
 * 零 SQL / 零 LLM / 零进程内活状态），已 git mv 到 kernel（src/kernel/content-visual-brief.ts，
 * change decouple-behavior-class-ports）。本文件保留旧导入面
 * `from '../publish-agent/content-visual-brief.js'` 逐字不变（re-export），content 层内部消费方无感；
 * 跨边界消费方直接从 kernel 导入以消去跨层依赖。
 */
export * from '../kernel/content-visual-brief.js';
