/**
 * 发布管线角色执行日志的跨进程往返 + **降级方向**。
 *
 * 这条口是三条里的第三种失败语义，三者刻意各不相同、别抄错：
 *   - 候审卡投递判定：fail-open（判不出来照发卡）；
 *   - 发布台账写：必须原样抛（以为落库了其实没落 = 静默假成功）；
 *   - 本条（可观测性）：吵闹地放过 —— 既定语义就是 best-effort、不阻塞发布，
 *     但每次失败留一行 warn，绝不静默吞（「日志断了」与「没有日志可写」含义天差地别）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  PIPELINE_LOG_ROUTES,
  PipelineLogHttpClient,
  registerPipelineLogRoutes,
} from '@automation/transport/pipeline-log-http.js';
import type { PipelineLogEntry, PipelineLogSink } from '@kernel/kernel/pipeline-log-contract.js';

function entry(): PipelineLogEntry {
  return {
    runId: 'run-1',
    roleName: 'publish:TitleCreator',
    triggeredAt: 1_784_044_800_000,
    completedAt: 1_784_044_801_000,
    success: true,
    errorMessage: null,
    durationMs: 1000,
  };
}

test('往返：整条日志原样送达属主侧', async () => {
  const seen: PipelineLogEntry[] = [];
  const server = new InternalHttpServer();
  const local: PipelineLogSink = { append: async (e) => void seen.push(e) };
  registerPipelineLogRoutes(server, local);
  const port = await server.listen(0);
  try {
    const client = new PipelineLogHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    await client.append(entry());
    assert.deepEqual(seen, [entry()]);
  } finally {
    await server.close();
  }
});

test('对端不可达 → 吵闹放过：不抛（发布不能因一条日志中断），但 MUST 留下 warn', async () => {
  const warnings: string[] = [];
  const client = new PipelineLogHttpClient(new InternalHttpClient('http://127.0.0.1:1'), {
    warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
  });
  await client.append(entry()); // MUST NOT reject
  assert.equal(warnings.length, 1, '静默吞掉会让「日志断了」看起来像「没有日志可写」');
  assert.match(warnings[0], /run-1/);
  assert.match(warnings[0], /publish:TitleCreator/);
});

test('路由名两侧共用同一常量', () => {
  assert.equal(PIPELINE_LOG_ROUTES.append, 'pipeline-log/append');
});
