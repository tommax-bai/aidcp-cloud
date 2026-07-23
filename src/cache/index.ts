/**
 * 云端 automation 层缓存出口（**按层收口**）。
 *
 * 本桶只再导出 automation 归属的 store（外加 kernel 的连接配置，any→kernel 恒允许）。
 * content 归属（`concept-store` / `curated-content-store`）与 api 归属（`bot-chat-store` /
 * `notification-contact-store`）**不再经本桶再导出**：那会让 automation 桶反向依赖 content / api，
 * 且任何导入方经本桶就能跨层拿到别层 store（正是「经桶跨层」反模式）。这些 store 由各自需要方
 * 直接从具体文件按其真实归属方向导入（见 `../index.ts` 公共出口与 `../panel/types.ts`）。
 */
export * from './pg-anchor-cache.js';
export * from './liked-note-store.js';
export * from './valuable-comment-store.js';
export * from './interaction-feed-store.js';
export * from './group-route-store.js';
export * from '../kernel/pg-config.js';
