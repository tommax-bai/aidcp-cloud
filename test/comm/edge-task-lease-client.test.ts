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
    const done = client.withLease(
      { edgeId: 'edge-1', kind: 'publish', priority: 'human', leaseMs: 60_000 },
      async (lease) => { ran = true; return lease.taskId; },
    );
    assert.equal(ran, false);
    assert.equal(pushed[0]?.type, 'edge.task.acquire');
    assert.deepEqual(pushed[0]?.payload as EdgeTaskAcquirePayload, {
      taskId: 'task-1', kind: 'publish', priority: 'human', leaseMs: 60_000,
    });

    client.onAcquired({ taskId: 'task-1', kind: 'publish', cancelledBrowseCommands: 3 }, 'edge-1');
    await tick();
    assert.equal(ran, true);
    assert.equal(pushed[1]?.type, 'edge.task.release');
    assert.equal((pushed[1]?.payload as EdgeTaskReleasePayload).taskId, 'task-1');
    client.onReleased({ taskId: 'task-1', reason: 'released' }, 'edge-1');
    assert.equal(await done, 'task-1');
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
});
