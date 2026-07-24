import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  PUBLISH_GENERATION_ROUTES,
  PublishGenerationHttpClient,
  registerPublishGenerationRoutes,
} from '../../src/transport/publish-generation-http.js';
import type {
  PublishGenerationPort,
  SchedulerTriggerResult,
} from '../../src/kernel/publish-generation-types.js';
import type { TriggerInput } from '../../src/kernel/publish-pipeline-types.js';

/** 样本终态：结构上满足 SchedulerTriggerResult（含 approvalCard 联合的一个合法枝）。 */
const SAMPLE: SchedulerTriggerResult = {
  status: 'pending_approval',
  runId: 'run-xyz',
  recordId: 42,
  approvalCard: { sent: true, targetChatId: 'oc_1', targetSource: 'default_chat' },
};

/** 仅测传输往返，不构造全字段业务夹具（口径由 typecheck 在真实调用处保证）。 */
function sampleInput(): TriggerInput {
  return { accountId: 'acc-1' } as unknown as TriggerInput;
}

/** fake 端口：trigger 在 delayMs 后 resolve 一个样本终态；记录被调用的入参。 */
function fakePort(delayMs: number): { port: PublishGenerationPort; calls: TriggerInput[] } {
  const calls: TriggerInput[] = [];
  const port: PublishGenerationPort = {
    trigger(input) {
      calls.push(input);
      return new Promise<SchedulerTriggerResult>((resolve) => {
        setTimeout(() => resolve(SAMPLE), delayMs);
      });
    },
  };
  return { port, calls };
}

async function withServer(
  local: PublishGenerationPort,
  run: (http: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishGenerationRoutes(server, local);
  const listenPort = await server.listen(0);
  // 单次调用超时须 > pollSegmentMs：给足 180s 天花板。
  const http = new InternalHttpClient(`http://127.0.0.1:${listenPort}`, { timeoutMs: 180_000 });
  try {
    await run(http);
  } finally {
    await server.close();
  }
}

test('PublishGenerationHttpClient 满足 kernel 端口形状', async () => {
  await withServer(fakePort(5).port, async (http) => {
    const client: PublishGenerationPort = new PublishGenerationHttpClient(http);
    assert.equal(typeof client.trigger, 'function');
  });
});

test('快 trigger：kick → 一轮 poll 即 done 拿到结果', async () => {
  const { port, calls } = fakePort(10);
  await withServer(port, async (http) => {
    const client = new PublishGenerationHttpClient(http, { pollSegmentMs: 5000 });
    const out = await client.trigger(sampleInput());
    assert.deepEqual(out, SAMPLE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accountId, 'acc-1');
  });
});

test('慢 trigger（raw 两轮）：第一轮小 budget → done:false，续轮拿到结果', async () => {
  await withServer(fakePort(120).port, async (http) => {
    const { correlationId } = await http.call<{ correlationId: string }>(
      PUBLISH_GENERATION_ROUTES.kick,
      { input: sampleInput() },
    );
    assert.equal(typeof correlationId, 'string');
    // 第一轮预算 20ms，远小于 trigger 的 120ms → 未 settled。
    const first = await http.call<{ done: boolean }>(PUBLISH_GENERATION_ROUTES.poll, {
      correlationId,
      budgetMs: 20,
    });
    assert.equal(first.done, false);
    // 续轮给足预算 → 拿到终态。
    const second = await http.call<{ done: boolean; result?: SchedulerTriggerResult }>(
      PUBLISH_GENERATION_ROUTES.poll,
      { correlationId, budgetMs: 5000 },
    );
    assert.equal(second.done, true);
    assert.deepEqual(second.result, SAMPLE);
  });
});

test('慢 trigger（client 多轮）：小 pollSegmentMs 下循环 poll 直到 done', async () => {
  await withServer(fakePort(120).port, async (http) => {
    const client = new PublishGenerationHttpClient(http, { pollSegmentMs: 20 });
    const out = await client.trigger(sampleInput());
    assert.deepEqual(out, SAMPLE);
  });
});

test('取走结果后再 poll 同 correlationId → unknown_correlation', async () => {
  await withServer(fakePort(5).port, async (http) => {
    const { correlationId } = await http.call<{ correlationId: string }>(
      PUBLISH_GENERATION_ROUTES.kick,
      { input: sampleInput() },
    );
    const done = await http.call<{ done: boolean }>(PUBLISH_GENERATION_ROUTES.poll, {
      correlationId,
      budgetMs: 5000,
    });
    assert.equal(done.done, true);
    await assert.rejects(
      () => http.call(PUBLISH_GENERATION_ROUTES.poll, { correlationId, budgetMs: 100 }),
      (err: unknown) => (err as { code?: string }).code === 'unknown_correlation',
    );
  });
});
