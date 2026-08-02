/**
 * 排期名额回程的传输三件套（change split-cloud-automation-production-runtime 批 H）。
 *
 * 这条口存在的理由是一个**进程内账本**：排期器记着「这一格是我点的火」，只有对得上才归还。
 * 所以红线全在「问不到属主时往哪边倒」——倒向「没接管」，让逐次结果卡照发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  SCHEDULE_FEEDBACK_ROUTES,
  ScheduleFeedbackHttpClient,
  registerScheduleFeedbackRoutes,
} from '../../src/transport/api-aux-authority-http.js';

const TOKEN = 'schedule-feedback-token';

async function withServer(
  owner: Parameters<typeof registerScheduleFeedbackRoutes>[1],
  run: (client: ScheduleFeedbackHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerScheduleFeedbackRoutes(server, owner, TOKEN, 'dev');
  const port = await server.listen(0);
  try {
    await run(
      new ScheduleFeedbackHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        TOKEN,
        'dev',
      ),
    );
  } finally {
    await server.close();
  }
}

test('路由名只有一条，且与端口方法逐字对齐', () => {
  assert.deepEqual(Object.keys(SCHEDULE_FEEDBACK_ROUTES), ['reportScheduledTaskNotStarted']);
});

test('往返：属主的两种回答原样带回来', async () => {
  const seen: string[] = [];
  await withServer(
    {
      async reportScheduledTaskNotStarted(accountId, action, reason) {
        seen.push(`${accountId}|${action}|${reason}`);
        return action === 'comment';
      },
    },
    async (client) => {
      assert.equal(
        await client.reportScheduledTaskNotStarted('acc-1', 'comment', 'edge_offline'),
        true,
        '属主接管了本次重试 → 调用方据此抑制逐次结果卡',
      );
      assert.equal(
        await client.reportScheduledTaskNotStarted('acc-1', 'contact_comment', 'acquire_timeout'),
        false,
        '属主没接管 → 结果卡照发',
      );
      assert.deepEqual(seen, [
        'acc-1|comment|edge_offline',
        'acc-1|contact_comment|acquire_timeout',
      ]);
    },
  );
});

test('动作名不在两个合法值里 → 请求就被拒，绝不落到属主上', async () => {
  let reached = false;
  await withServer(
    {
      async reportScheduledTaskNotStarted() {
        reached = true;
        return true;
      },
    },
    async (client) => {
      await assert.rejects(() =>
        (client as unknown as {
          reportScheduledTaskNotStarted(a: string, b: string, c: string): Promise<boolean>;
        }).reportScheduledTaskNotStarted('acc-1', 'publish', 'x'),
      );
      assert.equal(reached, false);
    },
  );
});

test('原因是必填 —— 没有原因的一次上报，属主日志里就查不出是哪类没起来', async () => {
  let reached = false;
  await withServer(
    {
      async reportScheduledTaskNotStarted() {
        reached = true;
        return true;
      },
    },
    async (client) => {
      await assert.rejects(() =>
        (client as unknown as {
          reportScheduledTaskNotStarted(a: string, b: string, c: unknown): Promise<boolean>;
        }).reportScheduledTaskNotStarted('acc-1', 'comment', ''),
      );
      assert.equal(reached, false);
    },
  );
});

test('属主抛错时客户端 MUST 让错误穿出去，绝不吞成 false 冒充「没接管」', async () => {
  await withServer(
    {
      async reportScheduledTaskNotStarted() {
        throw new Error('scheduler_down');
      },
    },
    async (client) => {
      await assert.rejects(() =>
        client.reportScheduledTaskNotStarted('acc-1', 'comment', 'edge_offline'),
      );
    },
  );
});
