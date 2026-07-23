// automation 属主的互动出口桶：**只再导出 automation 归属（外加 kernel 契约，any→kernel 恒允许）**。
// api 归属的配置/查询面（interaction-*-api / reply-config*）**不再经本桶再导出**——那会让本 automation
// 桶反向依赖 api、且任何导入方经本桶就能跨层拿到 api 属主文件（「经桶跨层」反模式）。这些 api 文件由需要方
// 直接从各自具体文件导入：唯一进程内消费者是组合根 src/server.ts（composition，MAY 导入任何层）。
// 参照已落地的 src/cache/index.ts 按层收口桶拆法。
export * from '../kernel/interaction-types.js';
export * from './contract.js';
export * from './interaction-store.js';
export * from './schema-capability.js';
export * from './reply-workflow.js';
export * from './send-orchestrator.js';
export * from './offboarding-service.js';
export * from './interaction-inbox-service.js';
export * from './metrics.js';
