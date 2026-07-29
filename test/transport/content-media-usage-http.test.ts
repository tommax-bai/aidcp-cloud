/**
 * automation → content 另外两条属主端口（FB 发帖素材写、模型用量记账写）的跨进程往返。
 *
 * 这个文件只钉六件事，每一件都对应一个「不测就只有真跑起来才发现」的失败：
 *   ① 路由两端一致——三件套同文件的**全部理由**。`satisfies` 保证路由表是全的，
 *      保证不了注册函数把表里每条都挂上去，所以四条逐条走一遍。
 *      变异实测过两种漏挂形态：「整条注册删掉」typecheck 会顺带报 `noUnusedLocals`（入参解析器成孤儿，
 *      共用解析器时这个信号就没有了）；「注册时手写一遍路径、不用共享常量」typecheck **完全绿**，
 *      只有这条用例红——后者才是这份测试真正在守的失败。
 *   ② `false` / `0` 是**真实的领域答案**，与失败刚性分开：属主说「没改到行」照样是成功返回。
 *   ③ 属主失败经这一跳后仍是**可识别的具名失败**，且属主自己那族具名原因原样留在 detail 里。
 *   ④ `unsupported_method` 两条现实路径都还原得出来——属主没实现、以及对面没注册这条路由。
 *   ⑤ target 漂移当场被拒，且属主**一次都没被调用**：DEV/OL 长期共库，放过去就是在另一台机器上真跑了。
 *   ⑥ 用量那两条硬边界（桶对齐、成功次数不得多于总次数）在属主被碰到之前就拦下来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeploymentTarget } from '../../src/deployment-target.js';
import { isContentPortError } from '../../src/kernel/content-port-error.js';
import type { FacebookPublishMediaPort } from '../../src/kernel/facebook-publish-media-port.js';
import {
  llmUsageBucketStart,
  type LlmUsageIncrement,
  type LlmUsageRecordingPort,
} from '../../src/kernel/llm-usage-recording-port.js';
import { FacebookPublishMediaError } from '../../src/publish-agent/facebook-publish-media-store.js';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES,
  FacebookPublishMediaAuthorityHttpClient,
  LLM_USAGE_RECORDING_AUTHORITY_ROUTES,
  LlmUsageRecordingAuthorityHttpClient,
  registerFacebookPublishMediaAuthorityRoutes,
  registerLlmUsageRecordingAuthorityRoutes,
} from '../../src/transport/content-media-usage-http.js';

const TOKEN = 'content-internal-token';

interface Harness {
  media: FacebookPublishMediaPort;
  usage: LlmUsageRecordingPort;
}

async function withChannel(
  opts: {
    media?: FacebookPublishMediaPort;
    usage?: LlmUsageRecordingPort;
    serverTarget?: DeploymentTarget;
    clientTarget?: DeploymentTarget;
  },
  run: (clients: Harness) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  const serverTarget = opts.serverTarget ?? 'dev';
  if (opts.media) {
    registerFacebookPublishMediaAuthorityRoutes(server, opts.media, TOKEN, serverTarget);
  }
  if (opts.usage) {
    registerLlmUsageRecordingAuthorityRoutes(server, opts.usage, TOKEN, serverTarget);
  }
  const port = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
  const clientTarget = opts.clientTarget ?? 'dev';
  try {
    await run({
      media: new FacebookPublishMediaAuthorityHttpClient(http, TOKEN, clientTarget),
      usage: new LlmUsageRecordingAuthorityHttpClient(http, TOKEN, clientTarget),
    });
  } finally {
    await server.close();
  }
}

const BUCKET = llmUsageBucketStart(1_760_000_000_000);

function increment(overrides: Partial<LlmUsageIncrement> = {}): LlmUsageIncrement {
  return {
    bucketStartMs: BUCKET,
    accountId: 'acct-1',
    role: 'untagged',
    provider: 'unknown',
    model: 'some-model',
    promptTokens: 12,
    completionTokens: 34,
    totalTokens: 46,
    calls: 2,
    okCalls: 1,
    ...overrides,
  };
}

test('四条路由：服务端注册的路径就是客户端请求的路径，入参原样送达', async () => {
  const seen: unknown[] = [];
  await withChannel(
    {
      media: {
        releaseReservation: async (setId, reservationId) => {
          seen.push({ m: 'releaseReservation', setId, reservationId });
          // 属主答「没改到行」：这组素材已经不是保留态，或它属于另一次保留。
          // 这是**真实的领域答案**，MUST 原样回到调用方，MUST NOT 被当成失败。
          return false;
        },
        markUsed: async (setId, publishLogId) => {
          seen.push({ m: 'markUsed', setId, publishLogId });
          return true;
        },
        quarantine: async (setId, reason) => {
          seen.push({ m: 'quarantine', setId, reason });
          return true;
        },
      },
      usage: {
        recordUsage: async (increments) => {
          seen.push({ m: 'recordUsage', increments: [...increments] });
          return increments.length;
        },
      },
    },
    async ({ media, usage }) => {
      assert.equal(await media.releaseReservation(7, 'res-1'), false, '没改到行 MUST 是 false，不是抛');
      assert.equal(await media.markUsed(7, 991), true);
      assert.equal(await media.quarantine(7, 'submitted_unconfirmed'), true);
      assert.equal(await usage.recordUsage([increment()]), 1);
      // 空批合法：调用方的合并窗口里什么都没发生，MUST NOT 因此报错。
      assert.equal(await usage.recordUsage([]), 0);

      assert.deepEqual(seen, [
        { m: 'releaseReservation', setId: 7, reservationId: 'res-1' },
        { m: 'markUsed', setId: 7, publishLogId: 991 },
        { m: 'quarantine', setId: 7, reason: 'submitted_unconfirmed' },
        { m: 'recordUsage', increments: [increment()] },
        { m: 'recordUsage', increments: [] },
      ]);
    },
  );
  assert.equal(
    Object.keys(FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES).length +
      Object.keys(LLM_USAGE_RECORDING_AUTHORITY_ROUTES).length,
    4,
    '端口新增方法时这里要一起补一趟往返，别让新路由没人走过就上线',
  );
});

test('属主失败：客户端侧仍是具名失败，属主那族具名原因原样留在 detail 里', async () => {
  await withChannel(
    {
      media: {
        // 属主真实抛出物。它自带 name / reason / code，但 automation 方向的失败信号只有
        // ContentPortError 一个 name（刻意不在这条边上立第二个），所以判定落 remote_error、
        // 具名原因进 detail 供定位。要按 status_locked 分支就得改端口，不是去 parse 文案。
        releaseReservation: async () => {
          throw new FacebookPublishMediaError('status_locked');
        },
        markUsed: async () => {
          throw new Error('pool exhausted');
        },
        quarantine: async () => true,
      },
    },
    async ({ media }) => {
      await assert.rejects(
        () => media.releaseReservation(7),
        (error: unknown) => {
          assert.ok(isContentPortError(error), '跨这一跳后仍 MUST 被结构化守卫认出来');
          assert.equal(error.reason, 'remote_error');
          assert.match(
            String(error.detail),
            /facebook_publish_media_status_locked/,
            '属主具名原因不得在这一跳丢失',
          );
          return true;
        },
      );
      // 没有 code 的普通抛出物同样 MUST 抛，MUST NOT 落成 false。
      await assert.rejects(() => media.markUsed(7, 991));
    },
  );
});

test('unsupported_method 两条路径都还原得出来', async () => {
  // ① 属主没实现这个方法（用量那条今天就是这个状态：属主的批量落库还锁在私有定时器里）。
  await withChannel(
    { usage: {} as unknown as LlmUsageRecordingPort },
    async ({ usage }) => {
      await assert.rejects(
        () => usage.recordUsage([increment()]),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'unsupported_method', '属主缺方法 MUST 具名答，MUST NOT 静默当成记上了');
          return true;
        },
      );
    },
  );

  // ② 对面跑的是旧版本、根本没注册这条路由：只挂了 FB 素材那组。
  await withChannel(
    {
      media: {
        releaseReservation: async () => true,
        markUsed: async () => true,
        quarantine: async () => true,
      },
    },
    async ({ usage }) => {
      await assert.rejects(
        () => usage.recordUsage([increment()]),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'unsupported_method');
          return true;
        },
      );
    },
  );
});

test('target 漂移：当场被拒，且属主一次都没被调用', async () => {
  let calls = 0;
  await withChannel(
    {
      serverTarget: 'ol',
      clientTarget: 'dev',
      media: {
        releaseReservation: async () => {
          calls += 1;
          return true;
        },
        markUsed: async () => {
          calls += 1;
          return true;
        },
        quarantine: async () => {
          calls += 1;
          return true;
        },
      },
      usage: {
        recordUsage: async () => {
          calls += 1;
          return 1;
        },
      },
    },
    async ({ media, usage }) => {
      for (const call of [
        () => media.markUsed(7, 991),
        () => usage.recordUsage([increment()]),
      ]) {
        await assert.rejects(call, (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'remote_error');
          assert.match(String(error.detail), /target_mismatch/, '原始 code MUST 留在 detail 里');
          return true;
        });
      }
      assert.equal(calls, 0, 'target 不符时 MUST NOT 在另一台机器上真跑');
    },
  );
});

test('用量入参硬边界：桶未对齐 / 成功次数多于总次数，在属主被碰到之前就拦下', async () => {
  let calls = 0;
  await withChannel(
    {
      usage: {
        recordUsage: async (increments) => {
          calls += 1;
          return increments.length;
        },
      },
    },
    async ({ usage }) => {
      // 未对齐的桶起点不会报错、只会悄悄多出一行错位的账，所以必须在这一跳拦。
      await assert.rejects(() => usage.recordUsage([increment({ bucketStartMs: BUCKET + 1 })]));
      // 成功次数多于总次数是纯粹的算错，放过去成功率会永久大于 100%。
      await assert.rejects(() => usage.recordUsage([increment({ calls: 1, okCalls: 2 })]));
      assert.equal(calls, 0, '入参不合契约时属主 MUST NOT 被调用');
      // 合法输入照常送达，证明上面两条拒绝不是把整条路由拦死了。
      assert.equal(await usage.recordUsage([increment()]), 1);
      assert.equal(calls, 1);
    },
  );
});

test('形状不符 MUST 抛，MUST NOT 兜底成 false / 0', async () => {
  await withChannel(
    {
      media: {
        // 契约漂移的典型形态：回执从布尔漂成了别的东西。取假会把它说成
        // 「这组素材已经不是保留态了」，而那条素材其实还卡在保留态上等着被放回来。
        releaseReservation: async () => 'ok' as unknown as boolean,
        markUsed: async () => true,
        quarantine: async () => true,
      },
      usage: {
        recordUsage: async () => null as unknown as number,
      },
    },
    async ({ media, usage }) => {
      for (const call of [
        () => media.releaseReservation(7),
        () => usage.recordUsage([increment()]),
      ]) {
        await assert.rejects(call, (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'malformed_response');
          return true;
        });
      }
    },
  );
});
