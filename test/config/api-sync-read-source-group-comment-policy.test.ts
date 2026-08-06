import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import { ApiSyncReadSnapshotSource } from '@api/config/api-sync-read-source.js';
import { isSyncReadFactPayload } from '@kernel/kernel/sync-read-facts.js';

/**
 * 属主存储的策略视图**比载荷契约宽**（另带 bounds / 冷却来源 / 更新元数据）。
 * TS 对变量不做多余属性检查 ⇒ 组装根把整份视图交给同步读源时两侧类型都对、编译全绿。
 *
 * 现形方式不是报错，而是消费方按「键必须刚好是这几个」整条拒收 ⇒ 自动化就绪度永不 ready
 * ⇒ **边-云端口不监听、边缘一台都连不上**。2026-08-05 dev 上实测踩过一次，故补这一例：
 * 判据是「发出去的载荷能过校验器」，不是「字段值对不对」。
 */
test('content_schedule payload stays exactly-shaped even when the policy view carries extra keys', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('FROM config_mirror_version')) {
        return { rows: [{ mirror_key: 'content_schedule', version: '3' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const source = new ApiSyncReadSnapshotSource({
    executionTarget: 'dev',
    facebookOperationPolicy: async () => {
      throw new Error('facebook_operation_policy_not_exercised_here');
    },
    // 属主存储 `get()` 的真实形状：四个契约字段 + 四个只在接口域有意义的字段。
    facebookGroupCommentPolicy: () => ({
      joinToFirstCommentHours: 72,
      sameGroupRecommentCooldownHours: 72,
      revision: 2,
      source: 'db',
      bounds: { joinToFirstCommentHours: { min: 1, max: 168, default: 24 } },
      sameGroupRecommentCooldownSource: 'default',
      updatedAt: '2026-08-05T08:00:00.000Z',
      updatedBy: 'panel:admin',
    }) as never,
    pool: { connect: async () => client } as unknown as pg.Pool,
    parseSoul: () => null,
  });

  const snapshot = await source.snapshot('content_schedule', 1234);
  assert.deepEqual(snapshot.value, {
    global: null,
    accounts: [],
    facebookGroupCommentPolicy: {
      joinToFirstCommentHours: 72,
      sameGroupRecommentCooldownHours: 72,
      revision: 2,
      source: 'db',
    },
  });
  assert.equal(
    isSyncReadFactPayload('content_schedule', snapshot.value),
    true,
    '载荷过不了校验器 ⇒ 消费方整条拒收 ⇒ 边-云端口不监听',
  );
});
