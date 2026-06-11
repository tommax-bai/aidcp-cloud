/**
 * 验收用例 AC-RISK-* — 风控"绝不自残"安全闸
 *
 * 守护点：把分散在单测里的风控断言聚成一条产品红线用例——被禁止时绝不放行、绝不静默执行。
 *   覆盖：配额硬上限、状态机降级（normal→warned→restricted→frozen）、致命信号一步冻结。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖；不接 PG，纯内存计数 + 状态机）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController } from '../../src/risk/risk-controller.js';

describe('AC-RISK 风控安全闸（绝不自残）', () => {
  it('AC-RISK-01 配额存在硬上限：有限次互动后必被拒，且超限 record 返回 false', async () => {
    const rc = new RiskController({ quotaLevel: 'conservative' });
    let allowed = 0;
    for (let i = 0; i < 1000 && rc.canDo('comment'); i++) {
      if (await rc.record('comment')) allowed++;
    }
    assert.ok(allowed > 0, '初始应允许若干互动');
    assert.equal(rc.canDo('comment'), false, '达上限后必须拒绝');
    assert.equal(await rc.record('comment'), false, '超限 record 必须返回 false（不静默执行）');
    assert.match(rc.explain('comment').reason ?? '', /quota/);
  });

  it('AC-RISK-02 状态机降级链路：warned 停发布 → restricted 停互动 → frozen 全停', async () => {
    const rc = new RiskController({ quotaLevel: 'normal' });
    assert.equal(rc.getState().status, 'normal');
    assert.equal(rc.canDo('publish'), true);

    // 一次轻度风险信号 → warned：暂停发布，浏览仍可
    await rc.applySignal({ kind: 'light' });
    assert.equal(rc.getState().status, 'warned');
    assert.equal(rc.canDo('publish'), false, 'warned 必须暂停发布');
    assert.equal(rc.explain('publish').reason, 'state:warned_publish_paused');
    assert.equal(rc.canDo('view'), true);

    // 再一次轻度信号 → restricted：互动全停，仅允许浏览
    await rc.applySignal({ kind: 'light' });
    assert.equal(rc.getState().status, 'restricted');
    assert.equal(rc.canDo('like'), false, 'restricted 仅允许浏览');
    assert.equal(rc.canDo('collect'), false);
    assert.equal(rc.canDo('follow'), false);
    assert.equal(rc.canDo('view'), true);

    // 致命信号 → frozen：完全停手
    await rc.applySignal({ kind: 'fatal' });
    assert.equal(rc.getState().status, 'frozen');
    assert.equal(rc.canDo('view'), false, 'frozen 必须完全停手');
    assert.equal(await rc.record('view'), false, 'frozen 下 record 也必须返回 false');
  });

  it('AC-RISK-03 致命信号一步冻结（平台封号/限流回执）', async () => {
    const rc = new RiskController();
    await rc.applySignal({ kind: 'fatal' });
    assert.equal(rc.getState().status, 'frozen');
  });
});
