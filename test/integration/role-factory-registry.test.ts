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
import { ContentPortError } from '../../src/kernel/content-port-error.js';

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

/**
 * 概念池装载失败 ≠ 概念池是空的（change split-cloud-automation-production-runtime，task 0.6f 吞点③）。
 *
 * 降级本身保留（概念池 MUST NOT 拖垮浏览闭环），要改的是降级的依据必须说得出名字：
 * 「本进程没接概念池」「问了没问到」「池里真的没词」三种情形原本落成同一个空池 + 至多一行没有原因码的日志。
 */
describe('概念池装载失败：退化为 seed_keywords 可以，冒充空池不行', () => {
  function captureWarn(): { warns: string[]; restore: () => void } {
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    return { warns, restore: () => { console.warn = original; } };
  }

  it('loadPool 抛出 → 具名 reason 落日志，且写明「未确认池为空」', async () => {
    const { warns, restore } = captureWarn();
    try {
      const d = new RoleDispatcher({
        soul: mockSoul,
        llm,
        sendCommand: () => {},
        conceptStore: {
          ...conceptStoreStub,
          loadPool: async () => { throw new ContentPortError('unreachable', 'concept-pool.loadPool'); },
        },
        roleFactories: contentRoleFactories(),
      });
      d.setup();
      d.startSession();
      // refreshConceptPool 是 fire-and-forget（不阻塞 feed.entered），故让出一轮微任务再断言。
      await new Promise((r) => setTimeout(r, 5));
      d.endSession();
    } finally {
      restore();
    }
    const named = warns.filter((w) => w.includes('概念池装载失败') && w.includes('reason=unreachable'));
    assert.equal(named.length, 1, '装载失败必须带具名 reason，不能只有一句 message');
    assert.match(named[0], /未.*确认池为空/, '日志必须点明空池是降级结果、不是事实');
  });

  it('未注入概念池 → 具名 not_configured 告警，且只响一次', async () => {
    const { warns, restore } = captureWarn();
    try {
      const d = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: () => {}, roleFactories: contentRoleFactories() });
      d.setup();
      d.startSession();
      d.startSession();
      await new Promise((r) => setTimeout(r, 5));
      d.endSession();
    } finally {
      restore();
    }
    assert.equal(
      warns.filter((w) => w.includes('概念池未接线') && w.includes('reason=not_configured')).length,
      1,
      '缺席要说出来，但只说一次（进程生命周期内不变）',
    );
  });
});
