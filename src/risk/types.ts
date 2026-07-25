/**
 * 风控词表的 automation 侧再导出壳 —— 定义已整体提升到 `src/kernel/risk-contract.ts`（P2-6）。
 * risk/ 内部 17 个消费者与 test/ 一行不改；跨层消费方 MUST 直接 import kernel，MUST NOT 经本壳。
 */
export * from '../kernel/risk-contract.js';
