/**
 * 配置副本停手闸的纯判定段（kernel 工厂）——两条 fail-safe 策略的行为闸。
 *
 * 这段之所以析出到 kernel，是因为拆进程后有了第二个读者（自动化进程）。
 * **两边各写一份的现形方式不是报错，是「该停手的时候没停」**，所以这两条策略必须只有一份定义、
 * 且每条都有会真触发它的用例：
 *
 * - **没装事实源 → fresh**：这不是「不知道就当新鲜」。没装的情形下根本不存在跨进程副本，
 *   镜像与库在同一次写入路径上，语义上就是权威本身。
 * - **事实源抛错 → 按 stale 收敛**：查询口在热路径上、契约是永不抛；查不出来时不敢断言新鲜，
 *   所以偏向停手那一侧。兜成 fresh 就是把「查不出来」洗成「没问题」。
 *
 * 另外两条容易被顺手改坏的：记账挂了绝不能连累停手本身；只读裁决路径 MUST NOT 记账（会污染指标）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ConfigMirrorFreshnessSource,
  ConfigMirrorKey,
  MirrorReadState,
} from '../src/kernel/config-mirror-bump-types.js';
import { createConfigMirrorGate } from '../src/kernel/config-mirror-gate.js';

const GATE_KEYS = ['session_config_global', 'quota_config'] as unknown as ConfigMirrorKey[];

function sourceOf(
  states: Partial<Record<string, MirrorReadState>>,
  hooks: { onNote?: (key: string, context?: string) => void; throwOnState?: boolean; throwOnNote?: boolean } = {},
): ConfigMirrorFreshnessSource {
  return {
    stateOf: (key) => {
      if (hooks.throwOnState) throw new Error('freshness_source_down');
      return states[key] ?? 'fresh';
    },
    noteStaleRefusal: (key, context) => {
      if (hooks.throwOnNote) throw new Error('accounting_down');
      hooks.onNote?.(key, context);
    },
  };
}

test('没装事实源 → fresh，且不停手、不记账', () => {
  const gate = createConfigMirrorGate({ source: () => null, gateMirrorKeys: GATE_KEYS });
  assert.equal(gate.stateOf(GATE_KEYS[0]!), 'fresh');
  assert.equal(gate.isStale(GATE_KEYS[0]!), false);
  assert.deepEqual(gate.staleGateMirrors(), []);
  assert.equal(gate.hasStaleGateMirror(), false);
  assert.deepEqual(gate.platformActionHalt('ctx'), { halted: false });
  // 没装事实源时记账是无处可记的空操作，MUST NOT 抛
  gate.noteStaleRefusal(GATE_KEYS[0]!, 'ctx');
});

test('事实源抛错 → 按 stale 收敛（偏向停手），MUST NOT 兜成 fresh', () => {
  const gate = createConfigMirrorGate({
    source: () => sourceOf({}, { throwOnState: true }),
    gateMirrorKeys: GATE_KEYS,
  });
  assert.equal(
    gate.stateOf(GATE_KEYS[0]!),
    'stale',
    '查不出来时不敢断言新鲜。兜成 fresh 就是把「查不出来」洗成「没问题」——不报错，只是判错',
  );
  assert.equal(gate.hasStaleGateMirror(), true);
  assert.equal(gate.platformActionHalt().halted, true);
});

test('闸门镜像陈旧 → 停手并点名是哪一个，同时记一次拒绝', () => {
  const noted: [string, string | undefined][] = [];
  const gate = createConfigMirrorGate({
    source: () => sourceOf({ [GATE_KEYS[1]! as string]: 'stale' }, { onNote: (k, c) => noted.push([k, c]) }),
    gateMirrorKeys: GATE_KEYS,
  });
  const halt = gate.platformActionHalt('account=acct-a');
  assert.deepEqual(halt, { halted: true, mirrorKey: GATE_KEYS[1] });
  assert.deepEqual(noted, [[GATE_KEYS[1]! as string, 'account=acct-a']], '停手时 MUST 记一次拒绝');
});

test('只读裁决路径 MUST NOT 记账（记了会污染「因陈旧拒绝真实平台动作」这个指标）', () => {
  const noted: string[] = [];
  const gate = createConfigMirrorGate({
    source: () => sourceOf({ [GATE_KEYS[0]! as string]: 'stale' }, { onNote: (k) => noted.push(k) }),
    gateMirrorKeys: GATE_KEYS,
  });
  assert.equal(gate.hasStaleGateMirror(), true);
  assert.deepEqual(gate.staleGateMirrors(), [GATE_KEYS[0]]);
  assert.deepEqual(noted, [], '只读裁决什么都没拒绝，MUST NOT 计入拒绝数');
});

test('记账挂了绝不连累停手本身', () => {
  const gate = createConfigMirrorGate({
    source: () => sourceOf({ [GATE_KEYS[0]! as string]: 'stale' }, { throwOnNote: true }),
    gateMirrorKeys: GATE_KEYS,
  });
  assert.deepEqual(
    gate.platformActionHalt('ctx'),
    { halted: true, mirrorKey: GATE_KEYS[0] },
    '记账是可观测性、不是判定；它抛错时停手结论 MUST 原样成立',
  );
});

test('事实源按调用取值：装卸载即时生效（不是构造期快照）', () => {
  const slot: { current: ConfigMirrorFreshnessSource | null } = { current: null };
  const gate = createConfigMirrorGate({ source: () => slot.current, gateMirrorKeys: GATE_KEYS });
  assert.equal(gate.isStale(GATE_KEYS[0]!), false);
  slot.current = sourceOf({ [GATE_KEYS[0]! as string]: 'stale' });
  assert.equal(
    gate.isStale(GATE_KEYS[0]!),
    true,
    '构造期取一次快照的话，秒级回滚开关（装/卸载刷新器）就永远不生效',
  );
  slot.current = null;
  assert.equal(gate.isStale(GATE_KEYS[0]!), false);
});

test('参数档镜像不入闸门清单：清单是入参，本模块不自作主张', () => {
  const gate = createConfigMirrorGate({
    source: () => sourceOf({ some_parameter_mirror: 'stale' }),
    gateMirrorKeys: GATE_KEYS,
  });
  assert.equal(
    gate.hasStaleGateMirror(),
    false,
    '不在清单里的镜像陈旧只告警、不停手；清单按进程各自给，本模块 MUST NOT 自己枚举',
  );
});
