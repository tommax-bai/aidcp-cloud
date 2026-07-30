import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationDispatchCommandReceiver,
  DelegatedTaskCommandReceiver,
  HandlerNotWiredError,
  OperatorCommandIdInvalidError,
  OperatorCommandResultUnknownError,
  type DelegatedTaskServiceSource,
} from '../../src/delegated-task/operator-command-receiver.js';
import { InMemoryOperatorCommandLedger } from '../../src/delegated-task/operator-command-ledger.js';
import { operatorCommandId } from '../../src/kernel/operator-command-port.js';
import {
  DelegatedTaskServiceError,
  type DelegatedTask,
  type DelegatedTaskConfirmationSummary,
} from '../../src/kernel/delegated-task-types.js';

const KEY = operatorCommandId({
  kind: 'delegated_task_text',
  scope: 'acc-1',
  requestKey: 'om_msg_1',
})!;
const OTHER_SCOPE_KEY = operatorCommandId({
  kind: 'delegated_task_text',
  scope: 'acc-2',
  requestKey: 'om_msg_1',
})!;

function sampleTask(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  const base: DelegatedTask = {
    id: 'task-1',
    executionTarget: 'dev',
    accountId: 'acc-1',
    accountName: 'Tom',
    platform: 'xiaohongshu',
    action: 'comment_batch',
    actionFamily: 'comment',
    targetSuccessCount: 3,
    maxAttempts: 6,
    deadlineAt: 1_700_000_000_000,
    notBefore: 0,
    executionWindow: { mode: 'immediate' },
    sourceConstraints: {},
    targetConstraints: {},
    approvalMode: 'review',
    priority: 'normal',
    source: 'feishu',
    sourceRef: null,
    originChatId: null,
    status: 'awaiting_confirmation',
    progress: { successCount: 0, attemptCount: 0, skippedCount: 0, failureCount: 0 },
    currentStep: null,
    terminalOutcome: null,
    pauseRequested: false,
    cancelRequested: false,
    nextEligibleAt: null,
    claimToken: null,
    claimExpiresAt: null,
    dedupeKey: 'dk-1',
    version: 1,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_699_000_000_000,
    confirmedAt: null,
    completedAt: null,
  };
  return { ...base, ...overrides };
}

function sampleConfirmation(): DelegatedTaskConfirmationSummary {
  return {
    taskId: 'task-1',
    version: 1,
    title: '请确认用户委托任务',
    accountName: 'Tom',
    platformLabel: '小红书',
    actionLabel: '批量评论',
    target: '3 个验证成功结果',
    attempts: '最多 6 次尝试',
    schedule: '确认后排队',
    approval: '公开写操作保留人审',
    priority: '普通',
    constraints: [],
    capability: 'supported',
  };
}

/**
 * 服务桩。`calls` 记录真实调用次数——**判「有没有重跑」只能看它**，看回执长得像不像会漏掉重跑。
 * 每次调用返回**不同**的 task id，好让「回放的是记下来的、不是现算的」变成可判定的：
 * 若实现改成重算，第二次会拿到 `task-2`。
 */
function stubService(overrides: Partial<DelegatedTaskServiceSource> = {}) {
  const calls = { createFromText: 0, confirm: 0 };
  const service: DelegatedTaskServiceSource = {
    createFromText: async () => {
      calls.createFromText += 1;
      return {
        kind: 'task' as const,
        task: sampleTask({ id: `task-${calls.createFromText}` }),
        confirmation: sampleConfirmation(),
        created: true,
        autoQueued: false,
      };
    },
    createDraft: async () => ({
      task: sampleTask(),
      confirmation: sampleConfirmation(),
      created: true,
      autoQueued: false,
    }),
    confirm: async (taskId, version) => {
      calls.confirm += 1;
      return sampleTask({ id: taskId, version });
    },
    pause: async (taskId) => sampleTask({ id: taskId }),
    resume: async (taskId) => sampleTask({ id: taskId }),
    cancel: async (taskId) => sampleTask({ id: taskId }),
    get: async (taskId) => sampleTask({ id: taskId }),
    list: async () => [sampleTask()],
    ...overrides,
  };
  return { service, calls };
}

/* ─────────────────────────────── 用例 8 / 11：幂等重放与跨实例 */

test('用例 8｜同命令键连发两次 → applied 然后 duplicate，且回执逐字段相同（不是现算的）', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  const { service, calls } = stubService();
  const receiver = new DelegatedTaskCommandReceiver({ service, ledger });

  const first = await receiver.createFromText({ commandId: KEY, text: '让 Tom 完成 3 条评论' });
  const second = await receiver.createFromText({ commandId: KEY, text: '让 Tom 完成 3 条评论' });

  assert.equal(first.outcome, 'applied');
  assert.equal(second.outcome, 'duplicate');
  // 承重断言：**处理器只跑了一次**。回执像不像不足以证明没重跑。
  assert.equal(calls.createFromText, 1, '重放绝不能再触发一次副作用');
  assert.deepEqual(
    second.outcome === 'duplicate' ? second.result : null,
    first.outcome === 'applied' ? first.result : undefined,
    '重放必须回放首次载荷，逐字段相同',
  );
});

test('用例 11｜接收方实例重建（同一台账）后重放 → 仍判 duplicate（台账不只活在内存里）', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  const first = await new DelegatedTaskCommandReceiver({
    service: stubService().service,
    ledger,
  }).createFromText({ commandId: KEY, text: 'x' });

  // 新实例 = 新的进程内 inFlight 表；只有台账是共享的那一份。
  const fresh = stubService();
  const replay = await new DelegatedTaskCommandReceiver({
    service: fresh.service,
    ledger,
  }).createFromText({ commandId: KEY, text: 'x' });

  assert.equal(replay.outcome, 'duplicate');
  assert.equal(fresh.calls.createFromText, 0, '换了实例也不许重跑');
  assert.deepEqual(
    replay.outcome === 'duplicate' ? replay.result : null,
    first.outcome === 'applied' ? first.result : undefined,
  );
});

/* ─────────────────────────────── 用例 9：键空间串了 */

test('用例 9｜同 requestKey 不同 scope 是两把键；同键不同 scope 才回 collision', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  const { service, calls } = stubService();
  const receiver = new DelegatedTaskCommandReceiver({ service, ledger });

  await receiver.createFromText({ commandId: KEY, text: 'x' });
  const otherScope = await receiver.createFromText({ commandId: OTHER_SCOPE_KEY, text: 'x' });
  // scope 在键里，所以换 scope 就是换了一把键 ⇒ 是一次**新**意图，照跑。
  assert.equal(otherScope.outcome, 'applied');
  assert.equal(calls.createFromText, 2);

  // 真的同键不同 scope（只可能由手动发帖 / 评论那种「入参另带账号」的命令产生）：
  // 直接往台账里塞一行别的 scope，验证接收方当场判 collision 而不是照着跑。
  const poisoned = new InMemoryOperatorCommandLedger();
  poisoned.forceInFlight(KEY, 'someone-else');
  const collided = await new DelegatedTaskCommandReceiver({
    service: stubService().service,
    ledger: poisoned,
  }).createFromText({ commandId: KEY, text: 'x' });
  assert.equal(collided.outcome, 'collision');
});

/* ─────────────────────────────── 用例 10：崩在 in_flight 那一格 */

test('用例 10｜台账停在 in_flight 且无同进程调用 → 抛「结果未知」，既不回 duplicate 也不重跑', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  ledger.forceInFlight(KEY, 'acc-1');
  const { service, calls } = stubService();
  const receiver = new DelegatedTaskCommandReceiver({ service, ledger });

  await assert.rejects(
    () => receiver.createFromText({ commandId: KEY, text: 'x' }),
    (err: unknown) => {
      assert.ok(err instanceof OperatorCommandResultUnknownError);
      // code 必须落在传输层码表里那个未知码上，好让客户端的补集判据把它认成传输失败、
      // 而不是某个业务原因。
      assert.equal(err.code, 'api_authority_result_unknown');
      return true;
    },
  );
  assert.equal(calls.createFromText, 0, '不许重跑——副作用可能已经发生');
});

test('同进程内那一次还在跑时重投 → 等到真结局并回 duplicate（不是「结果未知」）', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const receiver = new DelegatedTaskCommandReceiver({
    ledger,
    service: {
      ...stubService().service,
      createFromText: async () => {
        calls += 1;
        await gate;
        return {
          kind: 'task' as const,
          task: sampleTask({ id: 'task-slow' }),
          confirmation: sampleConfirmation(),
          created: true,
          autoQueued: false,
        };
      },
    },
  });

  const first = receiver.createFromText({ commandId: KEY, text: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  const replay = receiver.createFromText({ commandId: KEY, text: 'x' });
  release();

  const [a, b] = await Promise.all([first, replay]);
  assert.equal(a.outcome, 'applied');
  assert.equal(b.outcome, 'duplicate');
  assert.equal(calls, 1);
  assert.deepEqual(
    b.outcome === 'duplicate' ? b.result : null,
    a.outcome === 'applied' ? a.result : undefined,
  );
});

test('非业务抛出物把台账留在 in_flight ⇒ 下一次重放是「结果未知」，不是重跑', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  let calls = 0;
  const receiver = new DelegatedTaskCommandReceiver({
    ledger,
    service: {
      ...stubService().service,
      createFromText: async () => {
        calls += 1;
        throw new Error('pg connection died mid-insert');
      },
    },
  });

  await assert.rejects(() => receiver.createFromText({ commandId: KEY, text: 'x' }), /pg connection died/);
  await assert.rejects(
    () => receiver.createFromText({ commandId: KEY, text: 'x' }),
    (err: unknown) => err instanceof OperatorCommandResultUnknownError,
  );
  assert.equal(calls, 1, '第二次不许重跑：副作用可能已经发生');
});

/* ─────────────────────────────── 业务拒绝：status 必须是处理器给的 */

test('业务拒绝 → rejected，且 status 是服务给的 409 / 422 而不是 400', async () => {
  for (const [code, status] of [['account_paused', 409], ['unsupported_action', 422]] as const) {
    const ledger = new InMemoryOperatorCommandLedger();
    const receiver = new DelegatedTaskCommandReceiver({
      ledger,
      service: {
        ...stubService().service,
        createFromText: async () => {
          throw new DelegatedTaskServiceError(code, '不行', status);
        },
      },
    });
    const receipt = await receiver.createFromText({ commandId: KEY, text: 'x' });
    assert.equal(receipt.outcome, 'rejected');
    if (receipt.outcome !== 'rejected') return;
    assert.equal(receipt.rejection.code, code);
    assert.equal(receipt.rejection.status, status, 'status 必须原样来自处理器');

    // 重放拿回**记下来的**那条拒绝，而不是再问一次处理器。
    const replay = await receiver.createFromText({ commandId: KEY, text: 'x' });
    assert.equal(replay.outcome, 'rejected');
    assert.deepEqual(replay.outcome === 'rejected' ? replay.rejection : null, receipt.rejection);
  }
});

/* ─────────────────────────────── 形状翻译与键合法性 */

test('控制类文本被翻译成契约的两段（action + taskId），不透传解析结果全体', async () => {
  const receiver = new DelegatedTaskCommandReceiver({
    ledger: new InMemoryOperatorCommandLedger(),
    service: {
      ...stubService().service,
      createFromText: async () => ({
        kind: 'control' as const,
        request: { action: 'pause' as const, taskId: 'abc' },
      }),
    },
  });
  const receipt = await receiver.createFromText({ commandId: KEY, text: '暂停任务 abc' });
  assert.equal(receipt.outcome, 'applied');
  if (receipt.outcome !== 'applied') return;
  assert.deepEqual(receipt.result, { kind: 'control', action: 'pause', taskId: 'abc' });
});

test('命令键算不出来 / kind 不符 → 判参数错误，绝不拿它去记账', async () => {
  const receiver = new DelegatedTaskCommandReceiver({
    ledger: new InMemoryOperatorCommandLedger(),
    service: stubService().service,
  });
  for (const bad of ['', 'not-a-key', 'delegated_task_text:acc-1', 'manual_publish:acc-1:om_1']) {
    await assert.rejects(
      () => receiver.createFromText({ commandId: bad, text: 'x' }),
      (err: unknown) => err instanceof OperatorCommandIdInvalidError,
      `bad key must be refused: ${bad}`,
    );
  }
});

/* ─────────────────────────────── 用例 13：没接线 ≠ 异常 */

test('用例 13｜处理器未注入 → not_delivered + 具名原因，且**不是**异常', async () => {
  const receiver = new DelegatedTaskCommandReceiver({
    service: undefined,
    ledger: new InMemoryOperatorCommandLedger(),
  });
  const receipt = await receiver.createFromText({ commandId: KEY, text: 'x' });
  assert.deepEqual(receipt, {
    outcome: 'not_delivered',
    commandId: KEY,
    reason: 'handler_not_wired',
  });
});

test('7 方法面没有带内通道，所以未注入只能抛——但抛出物 MUST 区别于业务拒绝', async () => {
  const receiver = new DelegatedTaskCommandReceiver({
    service: undefined,
    ledger: new InMemoryOperatorCommandLedger(),
  });
  await assert.rejects(
    () => receiver.get('task-1'),
    (err: unknown) => {
      assert.ok(err instanceof HandlerNotWiredError);
      // 若它冒充业务拒绝，「这台机器上没这个处理器」会被渲染成「你的请求被拒绝了」，
      // 运营会去改参数重试——而重试对它无效。
      assert.notEqual(err.name, 'DelegatedTaskServiceError');
      return true;
    },
  );
});

test('7 方法直接转调、不进台账（台账那层只管有真副作用的自由文本那条）', async () => {
  const ledger = new InMemoryOperatorCommandLedger();
  const { service, calls } = stubService();
  const receiver = new DelegatedTaskCommandReceiver({ service, ledger });
  await receiver.confirm('task-9', 3);
  await receiver.confirm('task-9', 3);
  assert.equal(calls.confirm, 2, 'confirm 由自身版本号乐观锁守，不再套一层按键判重');
});

/* ─────────────────────────────── 用例 12 / 15：调度启停刻意无持久台账 */

test('用例 12｜调度启停重启后重放 → 重新执行，不判 duplicate', async () => {
  let flips = 0;
  const handles = {
    setDispatch: async (accountId: string) => {
      flips += 1;
      return { accountId, dispatch: 'started' as const, changed: flips === 1, edgesOnline: 2 };
    },
    isActive: () => true,
  };
  const key = operatorCommandId({ kind: 'automation_dispatch', scope: 'acc-1', requestKey: 'req-1' })!;

  const before = new AutomationDispatchCommandReceiver(handles);
  const applied = await before.setDispatch({ commandId: key, accountId: 'acc-1', action: 'start' });
  const sameProcess = await before.setDispatch({ commandId: key, accountId: 'acc-1', action: 'start' });
  assert.equal(applied.outcome, 'applied');
  assert.equal(sameProcess.outcome, 'duplicate', '同进程内重投回放首次观测');
  assert.equal(flips, 1);

  // 「重启」= 新实例。进程内布尔的状态本来就重来了，所以**必须重新执行**——
  // 若这里判成 duplicate，一次真实启动会被吃掉并回放一条陈旧的 changed，那是编造。
  const afterRestart = new AutomationDispatchCommandReceiver(handles);
  const replayed = await afterRestart.setDispatch({ commandId: key, accountId: 'acc-1', action: 'start' });
  assert.equal(replayed.outcome, 'applied', '重启后 MUST 重新执行');
  assert.equal(flips, 2);
});

test('调度启停：同键不同账号 → collision（比入参那个账号，不比键里反解的）', async () => {
  const receiver = new AutomationDispatchCommandReceiver({
    setDispatch: async (accountId: string) => ({
      accountId, dispatch: 'started' as const, changed: true, edgesOnline: 1,
    }),
    isActive: () => true,
  });
  const key = operatorCommandId({ kind: 'automation_dispatch', scope: 'acc-1', requestKey: 'req-1' })!;
  await receiver.setDispatch({ commandId: key, accountId: 'acc-1', action: 'start' });
  const collided = await receiver.setDispatch({ commandId: key, accountId: 'acc-9', action: 'start' });
  assert.equal(collided.outcome, 'collision');
});

test('用例 15｜状态灯读不到 → 三态里的 unavailable，MUST NOT 压成 active:false', async () => {
  const receiver = new AutomationDispatchCommandReceiver(undefined);
  assert.deepEqual(await receiver.readDispatchActivity(), {
    state: 'unavailable',
    reason: 'handler_not_wired',
  });
  const setResult = await receiver.setDispatch({
    commandId: operatorCommandId({ kind: 'automation_dispatch', scope: 'a', requestKey: 'r' })!,
    accountId: 'a',
    action: 'stop',
  });
  assert.equal(setResult.outcome, 'not_delivered');
});

test('业务错误缺整数 status → MUST NOT 补默认 400 冒充拒绝，降级成「结果未知」', async () => {
  // 现实触发路径是**跨进程**：那时业务错误是 JSON 反序列化出来的裸对象，结构上满足守卫
  // （有 name + code），但 status 可能压根没过线。同进程的 DelegatedTaskServiceError
  // 构造默认值恰好就是 400，所以「补默认」看着人畜无害——这条用例就是为了让它显形。
  const ledger = new InMemoryOperatorCommandLedger();
  const receiver = new DelegatedTaskCommandReceiver({
    ledger,
    service: {
      ...stubService().service,
      createFromText: async () => {
        throw { name: 'DelegatedTaskServiceError', code: 'account_paused', message: '账号已暂停' };
      },
    },
  });

  // 不是 rejected：把「不知道该报几」补成 400 会让 409 / 422 一并压平，
  // 而降级成「结果未知」是安全方向（调用方如实报未知，不编一个 HTTP 语义）。
  await assert.rejects(
    () => receiver.createFromText({ commandId: KEY, text: 'x' }),
    (err: unknown) => (err as { code?: string }).code === 'account_paused',
  );
  // 且那一行留在 in_flight ⇒ 重放是「结果未知」，不是一条编出来的 400 拒绝。
  await assert.rejects(
    () => receiver.createFromText({ commandId: KEY, text: 'x' }),
    (err: unknown) => err instanceof OperatorCommandResultUnknownError,
  );
});
