/**
 * 互动域失败跨进程搬运的保真闸。
 *
 * **它防的是本仓代价最高的那类错误：重复对外写入。**
 * `INTERACTION_SEND_AMBIGUOUS` 的语义是「命令已经发出去了，但我核不到结果」——
 * 409、不可重试。通用传输骨架只搬 code + message，`httpStatus` / `retryable` / `details`
 * 三格会在跨进程那一跳上静默丢掉；丢掉之后调用侧的兜底会把它折成 500 + 可重试，
 * 于是客户端去重投一条**可能已经上墙的评论 / 私信**。
 *
 * 三个方向都锁：
 *   ① 属主抛的互动失败 MUST 逐格原样到达调用方；
 *   ② 结果不明的**提交点** MUST 报「已发出但核不到」，MUST NOT 报成可重试；
 *   ③ 提交点名单 MUST 与传输层实际的分档**逐条**一致——名单是安全判据，
 *      新增一个提交点却漏改分档，后果正是 ②。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  InteractionError,
  asInteractionFailure,
} from '../../src/kernel/interaction-types.js';
import {
  INTERACTION_SUBMISSION_METHODS,
  type InteractionSendPort,
} from '../../src/kernel/interaction-automation-ports.js';
import {
  INTERACTION_SEND_ROUTES,
  InteractionSendHttpClient,
  registerInteractionSendRoutes,
} from '../../src/transport/interaction-automation-http.js';

/** 每个发送方法一组能过参数校验的最小实参。只用于把调用真发出去。 */
const SEND_ARGS: Readonly<Record<keyof InteractionSendPort, unknown[]>> = {
  queueApproved: [{ accountId: 'a', envKey: 'e', jobId: 'j', expectedVersion: 1, actor: 'client:u' }],
  dispatchQueued: [{ accountId: 'a', envKey: 'e', jobId: 'j', expectedVersion: 1 }],
  requestSync: [{ accountId: 'a', envKey: 'e', channel: 'dm', scopeExternalId: null, reason: 'user_requested' }],
  requestAuthReopen: [{ accountId: 'a', envKey: 'e', reason: 'user_requested' }],
  requestBrowserControl: [{ accountId: 'a', envKey: 'e', action: 'open' }],
};

function callSend(client: InteractionSendHttpClient, method: keyof InteractionSendPort): Promise<unknown> {
  const fn = client[method] as (...args: unknown[]) => Promise<unknown>;
  return fn.call(client, ...SEND_ARGS[method]);
}

/** 一个必然连不上的地址：端口先占后放，保证没人在听。 */
async function deadBaseUrl(): Promise<string> {
  const probe = new InternalHttpServer();
  const port = await probe.listen(0);
  await probe.close();
  return `http://127.0.0.1:${port}`;
}

test('AC-INTXP-01 属主抛的互动失败逐格原样到达调用方', async () => {
  const server = new InternalHttpServer();
  registerInteractionSendRoutes(server, {
    queueApproved: () => {
      throw new InteractionError(
        'INTERACTION_VERSION_CONFLICT', '版本对不上。', 409, false,
        { currentVersion: 7, reason: 'stale_client' },
      );
    },
  } as unknown as InteractionSendPort);
  const port = await server.listen(0);
  try {
    const client = new InteractionSendHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    const error = await callSend(client, 'queueApproved').then(
      () => null,
      (e: unknown) => e,
    );
    const failure = asInteractionFailure(error);
    assert.ok(failure, '跨进程后拿到的不是一个可识别的互动失败');
    assert.equal(failure.code, 'INTERACTION_VERSION_CONFLICT');
    assert.equal(failure.httpStatus, 409, 'httpStatus 丢了 ⇒ 客户端会看到一个错的状态码');
    assert.equal(failure.retryable, false, 'retryable 丢了 ⇒ 客户端会去重试一件不该重试的事');
    assert.deepEqual(failure.details, { currentVersion: 7, reason: 'stale_client' });
  } finally {
    await server.close();
  }
});

test('AC-INTXP-02 「已发出但核不到」跨进程后仍是 409 不可重试，MUST NOT 变成可重试', async () => {
  const server = new InternalHttpServer();
  registerInteractionSendRoutes(server, {
    dispatchQueued: () => {
      throw new InteractionError('INTERACTION_SEND_AMBIGUOUS', '回复命令下发结果不确定，已停止自动重试。', 409);
    },
  } as unknown as InteractionSendPort);
  const port = await server.listen(0);
  try {
    const client = new InteractionSendHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    const failure = asInteractionFailure(
      await callSend(client, 'dispatchQueued').then(() => null, (e: unknown) => e),
    );
    assert.ok(failure);
    assert.equal(failure.code, 'INTERACTION_SEND_AMBIGUOUS');
    assert.equal(failure.httpStatus, 409);
    assert.equal(
      failure.retryable, false,
      '这条一旦变成可重试，客户端就会重投一条可能已经上墙的命令 —— 本仓代价最高的错误',
    );
  } finally {
    await server.close();
  }
});

test('AC-INTXP-03 提交点在属主不可达时报「已发出但核不到」，读类报「可重试的暂时不可用」', async () => {
  const base = await deadBaseUrl();
  const client = new InteractionSendHttpClient(new InternalHttpClient(base, { timeoutMs: 1_000 }));

  const submission = asInteractionFailure(
    await callSend(client, 'requestAuthReopen').then(() => null, (e: unknown) => e),
  );
  assert.ok(submission);
  assert.equal(submission.code, 'INTERACTION_SEND_AMBIGUOUS');
  assert.equal(submission.retryable, false);

  const read = asInteractionFailure(
    await callSend(client, 'queueApproved').then(() => null, (e: unknown) => e),
  );
  assert.ok(read);
  assert.equal(read.code, 'INTERACTION_UPSTREAM_UNAVAILABLE');
  assert.equal(read.retryable, true, '入队可凭幂等台账重来，说成不可重试等于白丢一条可恢复路径');
});

test('AC-INTXP-04 对面明确「没这条路由」是一次干净的未发生，MUST NOT 说成「可能已发出」', async () => {
  // 起一个什么都没注册的属主 —— 这正是「派生进程手写 main 漏注册一族」的真实形态。
  const server = new InternalHttpServer();
  const port = await server.listen(0);
  try {
    const client = new InteractionSendHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    const failure = asInteractionFailure(
      await callSend(client, 'requestBrowserControl').then(() => null, (e: unknown) => e),
    );
    assert.ok(failure);
    assert.equal(
      failure.code, 'INTERACTION_UPSTREAM_UNAVAILABLE',
      '404 说明属主的处理函数一次都没跑过 ⇒ 命令没离开本进程，这是确定的未发生',
    );
    assert.equal(failure.retryable, false, '重试解决不了「对面没注册这条路由」');
    assert.match(
      String(failure.details?.reason), /route_not_found/,
      '原因必须能与「对面不可达」区分开——两者的处置完全不同',
    );
  } finally {
    await server.close();
  }
});

test('AC-INTXP-05 提交点名单里的每一个方法，传输层都真的按提交点分档', async () => {
  const base = await deadBaseUrl();
  const client = new InteractionSendHttpClient(new InternalHttpClient(base, { timeoutMs: 1_000 }));
  const submissions = new Set<string>(INTERACTION_SUBMISSION_METHODS);
  const misclassified: string[] = [];
  for (const method of Object.keys(INTERACTION_SEND_ROUTES) as Array<keyof InteractionSendPort>) {
    const failure = asInteractionFailure(
      await callSend(client, method).then(() => null, (e: unknown) => e),
    );
    const treatedAsSubmission = failure?.code === 'INTERACTION_SEND_AMBIGUOUS';
    if (treatedAsSubmission !== submissions.has(method)) misclassified.push(method);
  }
  assert.deepEqual(
    misclassified, [],
    '这些方法的「是不是提交点」与名单对不上；名单是安全判据，对不上就会重投已上墙的命令：\n'
      + misclassified.map((m) => `  · ${m}`).join('\n'),
  );
});

test('AC-INTXP-06 跨不了进程的推送前钩子被具名拒绝，MUST NOT 悄悄不跑', async () => {
  const base = await deadBaseUrl();
  const client = new InteractionSendHttpClient(new InternalHttpClient(base, { timeoutMs: 1_000 }));
  let ran = false;
  const failure = asInteractionFailure(
    await client
      .requestSync(
        SEND_ARGS.requestSync[0] as Parameters<InteractionSendPort['requestSync']>[0],
        { beforeDispatch: async () => { ran = true; } },
      )
      .then(() => null, (e: unknown) => e),
  );
  assert.ok(failure, '传了跨不了进程的钩子却没有任何人说话');
  assert.match(String(failure.details?.reason), /before_dispatch/);
  assert.equal(ran, false);
});

test('AC-INTXP-07 结构判别认得出「另一个领域来的」互动失败，也不误收别的东西', () => {
  const fromAnotherRealm = {
    name: 'InteractionError',
    code: 'INTERACTION_SEND_AMBIGUOUS',
    message: '已发出但核不到。',
    httpStatus: 409,
    retryable: false,
  };
  const restored = asInteractionFailure(fromAnotherRealm);
  assert.ok(restored, 'instanceof 在这里恒 false，结构判别是唯一还能认出它的办法');
  assert.equal(restored.httpStatus, 409);
  assert.equal(restored.retryable, false);

  assert.equal(asInteractionFailure(new Error('boom')), null);
  assert.equal(asInteractionFailure({ name: 'InteractionError', code: 'X' }), null, '缺具名字段就不该认');
  assert.equal(asInteractionFailure(null), null);
});
