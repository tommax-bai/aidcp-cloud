/**
 * 发布管线类型：纯类型契约闭包已提到 kernel（src/kernel/publish-pipeline-types.ts），供 api / content /
 * automation 三边 type-only 共导。本文件保留旧导入面 `from '../publish-agent/types.js'` 逐字不变
 * （re-export），content 层内部消费方无需改动；跨边界消费方直接从 kernel 导入以消去跨层依赖。
 */
export * from '../kernel/publish-pipeline-types.js';
