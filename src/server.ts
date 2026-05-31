/**
 * aidcp-cloud 启动入口：装配 planner + Qwen + PG 缓存，起 WebSocket 服务端。
 *
 * 环境变量：
 * - AIDCP_PORT        监听端口（默认 8787）
 * - DASHSCOPE_API_KEY Qwen API Key
 * - PGHOST/PGPORT/... 可覆盖默认 PG 连接（默认 127.0.0.1:5432 aidcp/aidcp）
 *
 * 运行：npm start
 */

import { QwenClient } from './llm/index.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache } from './cache/index.js';
import { EdgeCloudServer, DefaultMessageHandler } from './comm/index.js';

async function main(): Promise<void> {
  const port = Number(process.env.AIDCP_PORT ?? 8787);

  const llm = new QwenClient();
  const planner = new SimplePlanner({ llm });
  const cache = new PgAnchorCache();

  // 建表（幂等）；PG 不可用时打印告警但不阻塞启动协议处理
  try {
    await cache.init();
    console.log('[aidcp-cloud] PG 锚点缓存已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PG 初始化失败（缓存相关消息将报错）:', (err as Error).message);
  }

  const handler = new DefaultMessageHandler({ planner, llm, cache });
  const server = new EdgeCloudServer({ port, handler });
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);
}

main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
