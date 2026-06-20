import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeApprovalSignal, type ApprovalSignalFs } from '../src/feishu/ws-receiver.js';

const payload = { title: '', content: '', tags: [] };

test('writeApprovalSignal: 首个写者成功（written）+ 用 O_EXCL(wx)', async () => {
  const writes: { content: string; opts: unknown }[] = [];
  const fsImpl = {
    writeFile: async (_p: unknown, content: unknown, opts: unknown) => {
      writes.push({ content: String(content), opts });
    },
  } as unknown as ApprovalSignalFs;
  const r = await writeApprovalSignal(fsImpl, 'req-1', true, payload);
  assert.equal(r.written, true);
  assert.deepEqual(writes[0].opts, { flag: 'wx' }); // first-writer-wins
  assert.match(writes[0].content, /"approved":true/);
});

test('writeApprovalSignal: first-writer-wins——已存在则不覆盖，读回既有 alreadyDecided', async () => {
  const fsImpl = {
    writeFile: async () => {
      const e = new Error('exists') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    },
    readFile: async () => JSON.stringify({ requestId: 'req-1', approved: false, ts: 1, payload }),
  } as unknown as ApprovalSignalFs;
  const r = await writeApprovalSignal(fsImpl, 'req-1', true, payload);
  assert.equal(r.written, false);
  assert.equal(r.alreadyDecided, false); // 既有决定 approved=false，二次 approve 不覆盖
});

test('writeApprovalSignal: 已存在但读不回，仍返回 not-written（保守）', async () => {
  const fsImpl = {
    writeFile: async () => {
      const e = new Error('exists') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    },
    readFile: async () => {
      throw new Error('read fail');
    },
  } as unknown as ApprovalSignalFs;
  const r = await writeApprovalSignal(fsImpl, 'req-1', true, payload);
  assert.equal(r.written, false);
});

test('writeApprovalSignal: 非 EEXIST 错误向上抛（不静默吞）', async () => {
  const fsImpl = {
    writeFile: async () => {
      const e = new Error('disk full') as NodeJS.ErrnoException;
      e.code = 'ENOSPC';
      throw e;
    },
  } as unknown as ApprovalSignalFs;
  await assert.rejects(() => writeApprovalSignal(fsImpl, 'r', true, payload));
});
