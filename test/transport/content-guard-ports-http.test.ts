/**
 * 内容域两个**守卫读**的跨进程往返：账号平台（问 api）与参照稿触发去重（问 automation）。
 *
 * 两条钉的是同一件事、方向相反地说了两遍：**「查过、没有」与「没查成」必须可区分。**
 *   - 账号平台：缺账号回 `null` 是答案；读失败吞成 `null` 会让守卫看着在正常拒绝，其实通道断了。
 *   - 参照稿去重：读失败吞成空集合会让**每条已用过的参照稿重新变成可用**，同一份来稿被反复洗，
 *     且看起来完全正常。属主侧既有实现就是抛具名不可用错误、让调用方诚实拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  ACCOUNT_PLATFORM_ROUTES,
  AccountPlatformHttpClient,
  registerAccountPlatformRoutes,
} from '../../src/transport/account-platform-http.js';
import {
  TRIGGERED_PUBLISH_REFS_ROUTES,
  TriggeredPublishRefsHttpClient,
  registerTriggeredPublishRefsRoutes,
} from '../../src/transport/triggered-publish-refs-http.js';

test('账号平台：命中回平台、缺账号回 null（是答案），读失败必须抛（不是答案）', async () => {
  const server = new InternalHttpServer();
  registerAccountPlatformRoutes(server, {
    getPlatformOrNull: async (accountId) => {
      if (accountId === 'boom') throw new Error('accounts unreachable');
      return accountId === 'acct-fb' ? 'facebook' : null;
    },
  });
  const port = await server.listen(0);
  try {
    const client = new AccountPlatformHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    assert.equal(await client.getPlatformOrNull('acct-fb'), 'facebook');
    assert.equal(await client.getPlatformOrNull('acct-missing'), null, '查过、没有 —— 这是答案');
    await assert.rejects(() => client.getPlatformOrNull('boom'), '没查成 —— MUST NOT 与上一行同形');
  } finally {
    await server.close();
  }
});

test('参照稿去重：集合原样往返；读失败必须抛，绝不回空集合冒充「一条都没用过」', async () => {
  const server = new InternalHttpServer();
  registerTriggeredPublishRefsRoutes(server, {
    triggeredPublishRefs: async (accountId, executionTarget) => {
      if (accountId === 'boom') throw new Error('delegated tasks unreachable');
      return { curatedIds: [`c-${accountId}`], sourceIds: [`s-${executionTarget}`] };
    },
  });
  const port = await server.listen(0);
  try {
    const client = new TriggeredPublishRefsHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
    assert.deepEqual(await client.triggeredPublishRefs('acct-1', 'dev'), {
      curatedIds: ['c-acct-1'],
      sourceIds: ['s-dev'],
    });
    await assert.rejects(
      () => client.triggeredPublishRefs('boom', 'dev'),
      '回空集合会让每条用过的参照稿重新变成可用，同一份来稿被反复洗',
    );
  } finally {
    await server.close();
  }
});

test('对端没起：两条都抛', async () => {
  const dead = new InternalHttpClient('http://127.0.0.1:1');
  await assert.rejects(() => new AccountPlatformHttpClient(dead).getPlatformOrNull('a'));
  await assert.rejects(() => new TriggeredPublishRefsHttpClient(dead).triggeredPublishRefs('a', 'dev'));
});

test('路由名两侧共用同一常量', () => {
  assert.equal(ACCOUNT_PLATFORM_ROUTES.getPlatformOrNull, 'account-platform/get-or-null');
  assert.equal(TRIGGERED_PUBLISH_REFS_ROUTES.triggeredPublishRefs, 'triggered-publish-refs/list');
});
