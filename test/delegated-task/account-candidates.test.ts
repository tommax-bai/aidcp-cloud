import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  listDelegatedAccountCandidates,
  type DelegatedAccountDirectoryReader,
} from '../../src/delegated-task/account-candidates.js';
import type { AccountDirectoryRow } from '../../src/kernel/account-projection-types.js';

function reader(rows: readonly AccountDirectoryRow[]): DelegatedAccountDirectoryReader {
  return { listAccountDirectory: async () => rows };
}

test('账号目录逐行翻成候选：暂停号照样列出，没有可读名就如实交空候选', async () => {
  const candidates = await listDelegatedAccountCandidates(
    reader([
      {
        accountId: 'acct-1',
        displayName: '工程师大白',
        names: ['工程师大白', '大白'],
        platform: 'facebook',
        status: 'active',
      },
      // 暂停号：**MUST 仍然在列**。在这里滤掉，运营给一个暂停号下指令时收到的是
      // 「找不到昵称」——把「这个号停着」说成「没有这个号」，两者的处置完全不同。
      { accountId: 'acct-2', displayName: '小红', names: ['小红'], platform: 'xiaohongshu', status: 'paused' },
      // 一个可读名都没有的号：候选为空、显示名为 null。**MUST NOT 回落成拿账号 ID 当昵称**，
      // 否则运营会在「可用昵称」里读到一串机器标识。
      { accountId: 'acct-3', displayName: null, names: [], platform: 'xiaohongshu', status: 'active' },
    ]),
  );

  assert.deepEqual(candidates, [
    {
      accountId: 'acct-1',
      displayName: '工程师大白',
      names: ['工程师大白', '大白'],
      platform: 'facebook',
      status: 'active',
    },
    { accountId: 'acct-2', displayName: '小红', names: ['小红'], platform: 'xiaohongshu', status: 'paused' },
    { accountId: 'acct-3', displayName: null, names: [], platform: 'xiaohongshu', status: 'active' },
  ]);
});

test('属主读失败照原样抛：MUST NOT 吞成空清单', async () => {
  const failing: DelegatedAccountDirectoryReader = {
    listAccountDirectory: async () => {
      throw new Error('api_authority_unavailable');
    },
  };
  // 吞成 `[]` 的后果不是少几行，而是委托解析如实回一句「无可用昵称」——
  // 一个听着合理、其实是编造的答复。
  await assert.rejects(
    () => listDelegatedAccountCandidates(failing),
    /api_authority_unavailable/,
  );
});
