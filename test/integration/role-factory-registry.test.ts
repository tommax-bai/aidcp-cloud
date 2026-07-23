/**
 * RoleDispatcher content 角色工厂注册表回归。
 *
 * 背景：change decouple-roles-from-dispatcher 把 dispatcher（automation）对 4 个 content 层角色的直接
 * `new` 倒置为「组合根注入 roleFactories，dispatcher 按 RoleName 取工厂构造」。本测试锁死行为等价：
 * 条件注册逐一保持（有依赖才构造对应角色）、注册全经注册表、缺工厂诚实抛错（绝不静默少注册一个角色）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { ConceptStorePort, RoleFactoryRegistry } from '../../src/orchestrator/role-dispatcher.js';
import type { RoleName } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import { contentRoleFactories } from '../helpers/role-factories.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
const llm = { complete: async () => 'pass' };

const conceptStoreStub: ConceptStorePort = {
  addCandidate: async () => true,
  loadPool: async () => ({ known: [], candidates: [], source: new Map() }),
  markSearched: async () => {},
};

/** 包住真实 content 工厂并记录被请求的 RoleName —— 顺带验证 dispatcher 组装的 options 满足真实构造签名。 */
function recordingFactories(seen: RoleName[]): RoleFactoryRegistry {
  const real = contentRoleFactories();
  const wrapped: RoleFactoryRegistry = {};
  for (const key of Object.keys(real) as RoleName[]) {
    const f = real[key]!;
    wrapped[key] = (...args: unknown[]) => {
      seen.push(key);
      return f(...args);
    };
  }
  return wrapped;
}

describe('RoleDispatcher content 角色工厂注册表', () => {
  it('全部依赖就绪时，4 个 content 角色都经注册表按 RoleName 构造（各一次）', () => {
    const seen: RoleName[] = [];
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: () => {},
      conceptStore: conceptStoreStub,
      curatedStore: {},
      archiveValuableComment: async () => {},
      roleFactories: recordingFactories(seen),
    });
    d.setup();
    assert.deepEqual(
      [...seen].sort(),
      ['concept_extractor', 'curated_comment_evaluator', 'curated_note_evaluator', 'valuable_comment_archivist'],
      '4 个 content 角色应各经注册表构造一次',
    );
    d.endSession();
  });

  it('无任何 content 依赖时，一个 content 工厂都不被调用（条件注册保持）', () => {
    const seen: RoleName[] = [];
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: () => {},
      roleFactories: recordingFactories(seen),
    });
    d.setup();
    assert.deepEqual(seen, [], '缺依赖时不构造任何 content 角色');
    d.endSession();
  });

  it('仅注入 curatedStore 时，只构造两段式准入两角色，其余 content 角色不构造', () => {
    const seen: RoleName[] = [];
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: () => {},
      curatedStore: {},
      roleFactories: recordingFactories(seen),
    });
    d.setup();
    assert.deepEqual(
      [...seen].sort(),
      ['curated_comment_evaluator', 'curated_note_evaluator'],
      '仅 curatedStore ⇒ 只注册两个 curated 角色',
    );
    d.endSession();
  });

  it('依赖已注入但缺对应工厂 → setup() 诚实抛错，绝不静默少注册角色', () => {
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: () => {},
      conceptStore: conceptStoreStub,
      roleFactories: {}, // 缺 concept_extractor 工厂
    });
    assert.throws(() => d.setup(), /concept_extractor/, 'conceptStore 已注入却缺工厂应抛错点名该角色');
  });
});
