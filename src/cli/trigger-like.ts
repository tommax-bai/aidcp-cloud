/**
 * trigger-like：触发一次点赞任务（联调脚本）。
 *
 * 作为"控制端"连接已运行的云端 WS，发送 plan.request（goal=点赞，
 * context.dispatch='edge'）。云端据此规划点赞步骤，并主动下发给已上线的
 * 边缘节点执行；CLI 收到 plan.response 后打印规划与下发情况即退出。
 *
 * 用法：
 *   npm run trigger:like                # 广播给所有已上线边缘
 *   AIDCP_TARGET_EDGE=edge-local npm run trigger:like   # 定向某个 edgeId
 *
 * 环境变量：
 *   AIDCP_CLOUD_URL    云端 WS 地址（默认 ws://127.0.0.1:8787）
 *   AIDCP_TARGET_EDGE  目标 edgeId（不设则广播）
 *   AIDCP_LIKE_GOAL    覆盖点赞目标文案
 *
 * 前提：云端已 `npm start`，且至少一个边缘已 `npm start` 上线。
 */

import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  type PlanResponsePayload,
} from '../comm/protocol.js';

const url = process.env.AIDCP_CLOUD_URL ?? 'ws://127.0.0.1:8787';
const targetEdge = process.env.AIDCP_TARGET_EDGE;
const goal = process.env.AIDCP_LIKE_GOAL ?? '给当前这条笔记点赞';

function main(): void {
  console.log(`[trigger-like] 连接云端 ${url} ...`);
  const ws = new WebSocket(url);
  const reqId = 'trigger-like-1';
  const timeout = setTimeout(() => {
    console.error('[trigger-like] 超时未收到 plan.response');
    ws.close();
    process.exitCode = 1;
  }, 15_000);

  ws.on('open', () => {
    const context: Record<string, string> = { dispatch: 'edge' };
    if (targetEdge) context.edgeId = targetEdge;
    const env = makeEnvelope('plan.request', reqId, Date.now(), { goal, context });
    ws.send(JSON.stringify(env));
    console.log(`[trigger-like] 已发送点赞意图：${goal}${targetEdge ? ` → ${targetEdge}` : '（广播）'}`);
  });

  ws.on('message', (data) => {
    const env = parseEnvelope(typeof data === 'string' ? data : data.toString());
    if (!env || env.id !== reqId) return;
    clearTimeout(timeout);
    if (env.type === 'plan.response') {
      const p = env.payload as PlanResponsePayload;
      console.log(`[trigger-like] 云端规划：${p.steps.length} 步（${p.reason}）`);
      for (const s of p.steps) {
        console.log(`  - ${s.actionId} ${s.op}${s.value ? ` value=${s.value}` : ''}：${s.goal}`);
      }
    } else if (env.type === 'error') {
      const p = env.payload as { code: string; message: string };
      console.error(`[trigger-like] 云端错误：${p.code} ${p.message}`);
      process.exitCode = 1;
    }
    ws.close();
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    console.error('[trigger-like] 连接错误：', (err as Error).message);
    process.exitCode = 1;
  });
}

main();
