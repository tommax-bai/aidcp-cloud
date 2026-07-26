/**
 * 授权唯一写出口 + 影子写（change publish-approval-signal-to-database）。
 *
 * 红线：影子写 MUST 在持久写之后、MUST NOT 影响返回值或抛出、MUST NOT 成为第二事实源；
 * 持久写失败 MUST 诚实抛出，MUST NOT 退化成「只写了文件」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApprovalWriteOutlet,
  classifyApprovalRequestId,
} from '../../src/publish-agent/publish-approval-outlet.js';

const payload = { title: 'T', content: 'C', tags: ['x'], contentVersion: 3 };
const context = { decidedBy: 'ou_operator', decidedVia: 'feishu' as const, envKey: 'env-1' };

test('requestId 分类：publish-<n> 是发帖候选，其余归评论（两类共用一个写出口）', () => {
  assert.deepEqual(classifyApprovalRequestId('publish-42'), { subjectKind: 'publish', candidateRef: '42' });
  assert.deepEqual(classifyApprovalRequestId('comment-abc-171'), { subjectKind: 'comment', candidateRef: 'abc-171' });
});

test('影子写在持久写之后，且失败只记日志、不改返回值、不抛出', async () => {
  const order: string[] = [];
  const warns: string[] = [];
  const outlet = createApprovalWriteOutlet({
    store: {
      record: async () => {
        order.push('persist');
        return { written: true, revision: 1 };
      },
    },
    legacySignal: {
      enabled: true,
      write: async () => {
        order.push('shadow');
        throw new Error('EACCES');
      },
    },
    logger: { warn: (msg: string) => warns.push(String(msg)) },
  });

  const result = await outlet('publish-42', true, payload, context);
  assert.deepEqual(result, { written: true, revision: 1 });
  assert.deepEqual(order, ['persist', 'shadow'], '持久记录是唯一权威，必须先写');
  assert.equal(warns.length, 1, '影子写失败只记日志');
});

test('持久写失败 → 诚实抛出，绝不退化成只写文件（第二事实源）', async () => {
  let shadowWrites = 0;
  const outlet = createApprovalWriteOutlet({
    store: { record: async () => { throw new Error('pg_unavailable'); } },
    legacySignal: { enabled: true, write: async () => { shadowWrites += 1; } },
    logger: { warn: () => {} },
  });
  await assert.rejects(() => outlet('publish-42', true, payload, context), /pg_unavailable/);
  assert.equal(shadowWrites, 0, '持久写没成，绝不写影子文件');
});

test('后到的决定（alreadyDecided）不影子写：与旧 O_EXCL「不覆盖」逐条对应', async () => {
  let shadowWrites = 0;
  const outlet = createApprovalWriteOutlet({
    store: { record: async () => ({ written: false, alreadyDecided: false, revision: 1 }) },
    legacySignal: { enabled: true, write: async () => { shadowWrites += 1; } },
    logger: { warn: () => {} },
  });
  assert.deepEqual(await outlet('publish-42', true, payload, context), {
    written: false,
    alreadyDecided: false,
    revision: 1,
  });
  assert.equal(shadowWrites, 0);
});

test('决策上下文与内容版本原样落进持久记录（decidedBy 绝不常量占位）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const outlet = createApprovalWriteOutlet({
    store: {
      record: async (decision) => {
        seen.push(decision as unknown as Record<string, unknown>);
        return { written: true, revision: 1 };
      },
    },
  });
  await outlet('publish-42', true, payload, context);
  assert.equal(seen[0].decidedBy, 'ou_operator');
  assert.equal(seen[0].decidedVia, 'feishu');
  assert.equal(seen[0].envKey, 'env-1');
  assert.equal(seen[0].contentVersion, 3, 'contentVersion 是记录上的真列，供下发前版本闸做原子谓词');
});

test('envKey：调用方没给就在写出口一处解析（五个入口手边都没有环境键，否则全表恒 NULL）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const asked: Array<Record<string, unknown>> = [];
  const outlet = createApprovalWriteOutlet({
    store: {
      record: async (decision) => {
        seen.push(decision as unknown as Record<string, unknown>);
        return { written: true, revision: 1 };
      },
    },
    resolveEnvKey: async (subject) => {
      asked.push(subject as unknown as Record<string, unknown>);
      return subject.subjectKind === 'publish' ? 'env-9' : null;
    },
  });

  await outlet('publish-42', true, payload, { decidedBy: 'panel:u1', decidedVia: 'console' });
  assert.equal(seen[0].envKey, 'env-9');
  assert.deepEqual(asked[0], { requestId: 'publish-42', subjectKind: 'publish', candidateRef: '42' });

  // 调用方显式给了就用调用方的，解析器不再被问。
  await outlet('publish-43', true, payload, context);
  assert.equal(seen[1].envKey, 'env-1');
  assert.equal(asked.length, 1);
});

test('envKey 解析失败：留空 + 记日志，绝不阻断授权、也绝不猜一个环境写进审计记录', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const outlet = createApprovalWriteOutlet({
    store: {
      record: async (decision) => {
        seen.push(decision as unknown as Record<string, unknown>);
        return { written: true, revision: 1 };
      },
    },
    resolveEnvKey: async () => { throw new Error('pg_down'); },
    logger: { warn: (msg: string) => warns.push(String(msg)) },
  });
  assert.deepEqual(
    await outlet('publish-42', true, payload, { decidedBy: 'panel:u1', decidedVia: 'console' }),
    { written: true, revision: 1 },
  );
  assert.equal(seen[0].envKey, null);
  assert.match(warns.join('\n'), /envKey 解析失败/);
});
