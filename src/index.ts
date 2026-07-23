/**
 * aidcp-cloud 云端公共出口。
 *
 * 四块能力：
 * - llm     ：Qwen 文本模型 HTTP 客户端（规划/选元素）。
 * - planner ：任务规划（高层目标 → 有序原子步骤）。
 * - cache   ：PostgreSQL 锚点主缓存（含反污染晋升）。
 * - comm    ：边-云 WebSocket 服务端 + 协议定义 + 默认消息处理器。
 */
export * from './llm/index.js';
export * from './planner/index.js';
export * from './cache/index.js';
// content / api 归属的 cache store 不再经 automation 桶 cache/index 再导出（见该文件说明）；
// 本公共出口（composition）按其真实归属直连各文件，composition→任意层恒允许，公共出口面逐字不变。
export * from './cache/concept-store.js';
export * from './cache/curated-content-store.js';
export * from './cache/notification-contact-store.js';
export * from './cache/bot-chat-store.js';
export * from './comm/index.js';
