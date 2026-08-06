import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventBus } from '@automation/event-bus/index.js';
import type { EventMap, RoleEventMap } from '@automation/event-bus/types.js';
import type { ContentRoleEventMap, RoleEventSource } from '@kernel/kernel/role-runtime.js';

/**
 * 总线实际派发的事件全集 = 边缘上报事件表 ∪ 角色事件表（与 `EventBus` 内部的 `AllEventMap` 同源）。
 * 本夹具第一版只对着 `RoleEventMap` 断言，当场编译红——那三个键里有两个其实住在 `EventMap`。
 * 这正是这道闸的价值：靠肉眼记「哪个事件在哪张表」必然会记错。
 */
type BusEventMap = EventMap & RoleEventMap;

/**
 * content 侧角色事件载荷的**合同夹具**（change cloud-coupling-phase5 · P5-2）。
 *
 * 背景：`ContentRoleEventMap` 是 automation 事件全集里三个键的逐字子集，
 * 但它**刻意不 import 后者**——事件映射表归 automation，kernel MUST NOT 反向依赖业务层，
 * 且拆仓后 content 的 src 里根本没有那个文件。
 *
 * 代价是这两处形状从此靠自觉同源。这里把「自觉」换成编译期硬约束
 * （`src/` 才是边界闸的扫描范围，`test/` 不是，所以在这里跨引用不造边）：
 *
 *   - 任一键从总线事件全集消失或改名 → `AssertSameKeys` 编译失败；
 *   - 任一键的载荷不再能赋给 kernel 侧声明 → `AssertAssignable` 编译失败。
 *
 * 漂了会怎样：automation 发出的事件仍然被 content 角色收到（运行时不看类型），
 * 但新增/改名的字段在 content 侧永远读不到，角色照常跑、照常写库，只是少了那部分依据——
 * 没有任何一条日志会提到这件事。这正是必须让它编译红的原因。
 */

/** 类型层断言一：kernel 声明的每个键都仍是 automation 事件全集的成员。 */
type AssertSameKeys<T extends keyof BusEventMap> = T;

/** 类型层断言二：automation 侧的载荷仍可赋给 kernel 侧的声明（结构兼容）。 */
type AssertAssignable<K extends keyof ContentRoleEventMap & keyof BusEventMap> =
  BusEventMap[K] extends ContentRoleEventMap[K] ? K : never;

// export 是必要的：未导出的类型别名会被 noUnusedLocals 判为死代码，删掉就等于把这道闸也删了。
export type ContentRoleEventKeysAreValid = [
  AssertSameKeys<keyof ContentRoleEventMap>,
  AssertAssignable<'note.detail.arrived'>,
  AssertAssignable<'note.image_snapshot.arrived'>,
  AssertAssignable<'comment_like.confirmed'>,
];

test('automation 的进程内总线结构上满足 content 角色的窄事件源（只订阅那一半）', () => {
  const bus = new EventBus();
  // 赋值本身就是断言：EventBus 不满足 RoleEventSource 时这一行编译失败。
  const source: RoleEventSource = bus;

  const seen: string[] = [];
  const off = source.on('comment_like.confirmed', (p) => seen.push(p.commentAnchorId));
  bus.emit('comment_like.confirmed', {
    noteId: 'n1', commentAnchorId: 'c1', text: 'hi', reason: 'r', ts: 1,
  });
  assert.deepEqual(seen, ['c1'], '经窄事件源订阅 MUST 真收到 automation 侧发出的事件');

  off();
  bus.emit('comment_like.confirmed', {
    noteId: 'n1', commentAnchorId: 'c2', text: 'hi', reason: 'r', ts: 2,
  });
  assert.deepEqual(seen, ['c1'], '退订函数 MUST 真的摘下订阅');
});

test('窄事件源只暴露订阅：content 角色拿不到 emit（拆进程后往别人的总线发事件会静默失效）', () => {
  const source: RoleEventSource = new EventBus();
  // 运行时对象确实带 emit（它就是 EventBus），但类型上取不到——这正是这道闸要挡的：
  // 单体里写 emit 能跑通，拆完 content 手里的总线不再是那一条，事件发出去没人收、且不报错。
  assert.equal('emit' in (source as object), true, '底层实例仍是完整总线（此处只验类型面收窄，不改运行时）');
  assert.deepEqual(Object.keys({} as RoleEventSource), [], 'RoleEventSource 是纯类型面，无运行时成员');
});
