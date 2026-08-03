import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeTaskLeaseClient, EdgeTaskLeaseError } from '../../src/comm/edge-task-lease-client.js';
import type { EdgeTaskAcquirePayload, EdgeTaskReleasePayload, Envelope } from '../../src/comm/protocol.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('EdgeTaskLeaseClient', () => {
  it('业务回调严格晚于 acquired，完成后等待 released', async () => {
    const pushed: Envelope[] = [];
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: (envelope) => { pushed.push(envelope); return 1; } },
      idGen: () => 'task-1',
      acquireTimeoutMs: 1_000,
      releaseTimeoutMs: 1_000,
      logger: { log() {}, warn() {} },
    });
    let ran = false;
    const releases: boolean[] = [];
    const done = client.withLease(
      { edgeId: 'edge-1', kind: 'publish', priority: 'human', leaseMs: 60_000 },
      async (lease) => { ran = true; return lease.taskId; },
      { onReleaseSettled: ({ acknowledged }) => releases.push(acknowledged) },
    );
    assert.equal(ran, false);
    assert.equal(pushed[0]?.type, 'edge.task.acquire');
    assert.deepEqual(pushed[0]?.payload as EdgeTaskAcquirePayload, {
      taskId: 'task-1', kind: 'publish', priority: 'human', leaseMs: 60_000, acquireTimeoutMs: 1_000,
    });

    client.onAcquired({ taskId: 'task-1', kind: 'publish', cancelledBrowseCommands: 3 }, 'edge-1');
    await tick();
    assert.equal(ran, true);
    assert.equal(pushed[1]?.type, 'edge.task.release');
    assert.equal((pushed[1]?.payload as EdgeTaskReleasePayload).taskId, 'task-1');
    client.onReleased({ taskId: 'task-1', reason: 'released' }, 'edge-1');
    assert.equal(await done, 'task-1');
    assert.deepEqual(releases, [true]);
  });

  it('release 回执超时保留业务结果，但向工作流报告未确认', async () => {
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: () => 1 },
      idGen: () => 'release-timeout-task',
      releaseTimeoutMs: 5,
      logger: { log() {}, warn() {} },
    });
    const releases: boolean[] = [];
    const done = client.withLease(
      { edgeId: 'edge-1', kind: 'comment_prepare', priority: 'automatic' },
      async () => 'submitted_unknown',
      { onReleaseSettled: ({ acknowledged }) => releases.push(acknowledged) },
    );
    client.onAcquired({
      taskId: 'release-timeout-task',
      kind: 'comment_prepare',
      cancelledBrowseCommands: 0,
    }, 'edge-1');
    assert.equal(await done, 'submitted_unknown');
    assert.deepEqual(releases, [false]);
  });

  it('送达 0 时 acquire 诚实 edge_offline，业务回调不运行', async () => {
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: () => 0 },
      idGen: () => 'offline-task',
      logger: { log() {}, warn() {} },
    });
    let ran = false;
    await assert.rejects(
      client.withLease(
        { edgeId: 'edge-offline', kind: 'comment_prepare', priority: 'automatic' },
        async () => { ran = true; },
      ),
      (error: unknown) => error instanceof EdgeTaskLeaseError && error.code === 'edge_offline',
    );
    assert.equal(ran, false);
  });

  it('等待 acquired 时断线立即失败，不等完整超时', async () => {
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: () => 1 },
      idGen: () => 'disconnect-task',
      acquireTimeoutMs: 10_000,
      logger: { log() {}, warn() {} },
    });
    const acquiring = client.acquire({ edgeId: 'edge-1', kind: 'comment_commit', priority: 'human' });
    client.invalidateEdge('edge-1');
    await assert.rejects(
      acquiring,
      (error: unknown) => error instanceof EdgeTaskLeaseError && error.code === 'edge_disconnected',
    );
  });

  it('edge 明确报告 CDP 控制不可用时立即失败，不等待 acquire 超时或错误释放', async () => {
    const pushed: Envelope[] = [];
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: (envelope) => { pushed.push(envelope); return 1; } },
      idGen: () => 'unhealthy-task',
      acquireTimeoutMs: 10_000,
      logger: { log() {}, warn() {} },
    });
    let ran = false;
    const acquiring = client.withLease(
      { edgeId: 'edge-1', kind: 'publish', priority: 'human' },
      async () => { ran = true; },
    );
    client.onReleased({ taskId: 'unhealthy-task', reason: 'cdp_unhealthy' }, 'edge-1');
    await assert.rejects(
      acquiring,
      (error: unknown) => error instanceof EdgeTaskLeaseError && error.code === 'edge_unhealthy',
    );
    assert.equal(ran, false);
    assert.deepEqual(pushed.map((envelope) => envelope.type), ['edge.task.acquire']);
  });

  it('acquire 超时立即 release，迟到 acquired 时重复 release 清理无主租约', async () => {
    const pushed: Envelope[] = [];
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: (envelope) => { pushed.push(envelope); return 1; } },
      idGen: () => 'late-task',
      acquireTimeoutMs: 5,
      logger: { log() {}, warn() {} },
    });

    const acquiring = client.acquire({ edgeId: 'edge-1', kind: 'comment_prepare', priority: 'automatic' });
    await assert.rejects(
      acquiring,
      (error: unknown) => error instanceof EdgeTaskLeaseError && error.code === 'acquire_timeout',
    );
    assert.deepEqual(pushed.map((envelope) => envelope.type), ['edge.task.acquire', 'edge.task.release']);
    assert.deepEqual(pushed[1]?.payload as EdgeTaskReleasePayload, { taskId: 'late-task', outcome: 'failed' });

    client.onAcquired({ taskId: 'late-task', kind: 'comment_prepare', cancelledBrowseCommands: 0 }, 'edge-1');
    assert.deepEqual(pushed.map((envelope) => envelope.type), ['edge.task.acquire', 'edge.task.release', 'edge.task.release']);
    client.onReleased({ taskId: 'late-task', reason: 'released' }, 'edge-1');
  });
});

// ── change honest-lease-failure-receipts ──
// 受理超时的默认值曾被注入点（server.ts）的一个硬编码回落值 `?? 45_000` 永远盖住：change
// browser-slot-scheduling 把类默认从 45s 抬到 200s，却漏改了那行 → 修复一行都没生效，typecheck 毫无反应。
// 现在注入点不再写回落值，生效值只认这里的类默认。这条断言守住「默认容得下边缘 180s 的浏览器唤醒死线」。
describe('EdgeTaskLeaseClient 受理超时默认值（honest-lease-failure-receipts）', () => {
  const EDGE_WAKE_DEADLINE_MS = 180_000; // aidcp-edge 为停泊账号原地重开浏览器的死线

  it('未显式配置时，随 acquire 下发的受理超时必须容得下一次浏览器唤醒', async () => {
    const pushed: Envelope[] = [];
    const client = new EdgeTaskLeaseClient({
      pusher: { pushToEdges: (envelope) => { pushed.push(envelope); return 1; } },
      idGen: () => 'task-wake',
      logger: { log() {}, warn() {} },
      // 刻意不传 acquireTimeoutMs —— 模拟未设 env 的部署环境。
    });

    const done = client.withLease(
      { edgeId: 'edge-1', kind: 'comment_prepare', priority: 'automatic' },
      async (lease) => lease.taskId,
    );
    const acquire = pushed[0]?.payload as EdgeTaskAcquirePayload;
    assert.ok(
      (acquire.acquireTimeoutMs ?? 0) > EDGE_WAKE_DEADLINE_MS,
      `未配置时的受理超时（${acquire.acquireTimeoutMs}ms）必须 > 边缘唤醒死线 ${EDGE_WAKE_DEADLINE_MS}ms，`
        + '否则停泊账号在浏览器正常唤醒的途中就会被云端提前判死',
    );

    client.onAcquired({ taskId: 'task-wake', kind: 'comment_prepare', cancelledBrowseCommands: 0 }, 'edge-1');
    await tick();
    client.onReleased({ taskId: 'task-wake', reason: 'released' }, 'edge-1');
    assert.equal(await done, 'task-wake');
  });
});
