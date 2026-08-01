import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContentRole } from '../../src/agents/content-role.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/kernel/soul-types.js';

/**
 * 人设注入的构造契约（change split-cloud-automation-production-runtime · task 2.7 层④）。
 *
 * `soul?` / `getSoul?` 两个都是可选字段，契约是「至少给一个」。这个契约此前**只在第一次读
 * `this.soul` 时才检查** —— 而读它的位置全都坐在 fire-and-forget + try/catch 里。
 * 于是漏传的表现不是报错，是这个角色悄悄什么都不产出：没有异常、没有日志，
 * 下游只看到「它这轮没给结论」，与「它认为不值得」完全同形。
 *
 * 单体里这个失败态**从未发生过**：角色调度器的公共选项恒传 `getSoul`。
 * 也就是说它是一个只可能由拆仓引入的洞——现有测试不可能覆盖它，必须专门钉。
 *
 * 落法与本 change 0.6d 对 Sink 可选方法的裁定同源：契约违背要在**组装期**响，
 * 那里没有任何 try/catch 接得住。
 */

const SOUL: Soul = {
  identity: { name: 'T', role: 'R', background: 'B', tone: 'friendly' },
  interests: { primary: ['x'], secondary: [], seed_keywords: [] },
};

class ProbeRole extends ContentRole {
  readonly roleName = 'probe_role';
  subscribe(): void {}
  unsubscribe(): void {}
  /** 暴露受保护的读取口，供「给了就能读到」那条用。 */
  readSoul(): Soul {
    return this.soul;
  }
}

test('两种人设注入皆缺 → 构造期当场抛具名错误，绝不拖到第一次读', () => {
  const eventBus = new EventBus();
  assert.throws(
    () => new ProbeRole({ eventBus }),
    (err: Error) => {
      // 点名具体角色类，否则一堆角色一起装配时这行日志说不清是谁漏了。
      assert.match(err.message, /ProbeRole/);
      assert.match(err.message, /人设注入/);
      return true;
    },
    '漏传人设 MUST 在构造期响。拖到第一次读 = 落进 fire-and-forget 的 catch 里，等于没有信号',
  );
});

test('给 soul 快照或 getSoul 取值口任一，构造通过且读得到', () => {
  const eventBus = new EventBus();
  assert.equal(new ProbeRole({ eventBus, soul: SOUL }).readSoul(), SOUL);
  assert.equal(new ProbeRole({ eventBus, getSoul: () => SOUL }).readSoul(), SOUL);
  // 两者皆给时取值口优先（热加载：改人设即时生效，快照会过期）。
  const other: Soul = { ...SOUL, identity: { ...SOUL.identity, name: 'HOT' } };
  assert.equal(new ProbeRole({ eventBus, soul: SOUL, getSoul: () => other }).readSoul(), other);
});
