import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseRole } from '../src/agents/base-role.js';
import { EventBus } from '../src/event-bus/index.js';
import { loadSoulFromYaml, type Soul } from '../src/soul/index.js';
import type { RoleName } from '../src/event-bus/types.js';

const soulYaml = (name: string) => `
identity:
  name: "${name}"
  role: "美妆博主"
  background: "三年护肤经验"
  tone: "亲切"
interests:
  primary:
    - "护肤"
  secondary:
    - "彩妆"
  seed_keywords:
    - "成分党"
`;

/** 最小具体角色：暴露 protected soul getter 供断言。 */
class TestRole extends BaseRole {
  readonly roleName = 'content_evaluator' as RoleName;
  subscribe(): void {}
  unsubscribe(): void {}
  readSoul(): Soul {
    return this.soul;
  }
}

test('base-role：soul 快照路径（兼容旧构造）—— this.soul 读快照', () => {
  const snapshot = loadSoulFromYaml(soulYaml('SNAPSHOT'));
  const role = new TestRole({ eventBus: new EventBus(), soul: snapshot });
  assert.equal(role.readSoul().identity.name, 'SNAPSHOT');
});

test('base-role：getSoul 取值口优先于快照', () => {
  const snapshot = loadSoulFromYaml(soulYaml('SNAPSHOT'));
  const hot = loadSoulFromYaml(soulYaml('HOT'));
  const role = new TestRole({ eventBus: new EventBus(), soul: snapshot, getSoul: () => hot });
  assert.equal(role.readSoul().identity.name, 'HOT');
});

test('base-role：热加载 —— 改变 getSoul 返回值后 this.soul 即时反映（无需重建 agent）', () => {
  let current = loadSoulFromYaml(soulYaml('V1'));
  const role = new TestRole({ eventBus: new EventBus(), getSoul: () => current });
  assert.equal(role.readSoul().identity.name, 'V1');
  current = loadSoulFromYaml(soulYaml('V2')); // 模拟后台 PUT 人设后取值口解析到新值
  assert.equal(role.readSoul().identity.name, 'V2');
});

test('base-role：soul / getSoul 皆缺 → 读 this.soul 诚实抛（不静默）', () => {
  const role = new TestRole({ eventBus: new EventBus() });
  assert.throws(() => role.readSoul(), /缺少人设注入/);
});
