import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AccountPersonaService,
  summarizePersona,
} from '../src/config/account-persona-service.js';
import { createPersonaPanel } from '../src/config/persona-facade.js';
import type { PersonaStore } from '../src/config/persona-store.js';
import type { PersonaDetailView } from '../src/panel/types.js';

const SOUL = `identity:
  name: "阿柚"
  role: "数据标注内容分享者"
  background: "关注数据标注与 AI 工具"
  tone: "亲切接地气"
writing_language: "zh-CN"
interests:
  primary:
    - "数据标注"
    - "AI 工具"
  secondary:
    - "远程工作"
  seed_keywords:
    - "数据标注兼职"
behavior_guidelines:
  style: "自然"
  privacy: "不泄露隐私"
  collection_principle: "只收藏长期有用的内容"
  like_principle: "真正喜欢才点赞"
  like_affinity: "like_more"
`;

function makeService(options: {
  detail?: PersonaDetailView | null;
  generate?: () => Promise<unknown>;
  setPersona?: () => Promise<unknown>;
  armFirstBind?: () => Promise<boolean>;
} = {}) {
  let detail = options.detail === undefined
    ? {
        accountId: 'acc-1', label: '阿柚', source: 'override' as const, persona: SOUL,
        updatedAt: '2026-07-20T00:00:00.000Z', updatedBy: 'test',
      }
    : options.detail;
  const generator = {
    generate: options.generate ?? (async () => ({ ok: true, soulYaml: SOUL, identitySummary: '阿柚·数据标注内容分享者' })),
  };
  const facade = {
    getDetail: async () => detail,
    setPersona: options.setPersona ?? (async (_accountId: string, persona: string) => {
      detail = {
        accountId: 'acc-1', label: '阿柚', source: 'override', persona,
        updatedAt: '2026-07-20T01:00:00.000Z', updatedBy: 'client',
      };
      return {
        ok: true,
        view: {
          accounts: [{
            accountId: 'acc-1', label: '阿柚', source: 'override', identityName: '阿柚',
            identityRole: '数据标注内容分享者', updatedAt: detail.updatedAt, updatedBy: 'client',
          }],
        },
      };
    }),
  };
  const service = new AccountPersonaService({
    generator: generator as never,
    facade: facade as never,
    ...(options.armFirstBind ? { firstPostOnboarding: { armFirstBind: options.armFirstBind } } : {}),
    logger: { warn() {} },
  });
  return { service, generator, facade };
}

describe('AccountPersonaService', () => {
  it('returns configured truth with a bounded structured summary', async () => {
    const { service } = makeService();
    const result = await service.get('acc-1');
    assert.equal(result.ok, true);
    if (!result.ok || result.view.state !== 'configured') return;
    assert.equal(result.view.persona.soulYaml, SOUL);
    assert.deepEqual(result.view.persona.summary, {
      name: '阿柚',
      role: '数据标注内容分享者',
      background: '关注数据标注与 AI 工具',
      tone: '亲切接地气',
      writingLanguage: 'zh-CN',
      primaryInterests: ['数据标注', 'AI 工具'],
      secondaryInterests: ['远程工作'],
      seedKeywords: ['数据标注兼职'],
      likeAffinity: 'like_more',
    });
  });

  it('returns missing without exposing the facade editor template', async () => {
    const { service } = makeService({
      detail: {
        accountId: 'acc-1', label: '阿柚', source: 'none', persona: 'PACKAGED TEMPLATE',
        updatedAt: null, updatedBy: null,
      },
    });
    assert.deepEqual(await service.get('acc-1'), { ok: true, view: { state: 'missing', persona: null } });
  });

  it('deduplicates successful generation and evicts failed generation for retry', async () => {
    let calls = 0;
    const { service } = makeService({
      generate: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, reason: 'generation_failed' }
          : { ok: true, soulYaml: SOUL, identitySummary: '阿柚·数据标注内容分享者' };
      },
    });
    const input = {
      accountId: 'acc-1', platform: 'facebook', keywordSelections: ['数据标注'],
      writingLanguage: 'zh-CN', idempotencyKey: 'same-key',
    };
    assert.deepEqual(await service.generate(input), { ok: false, reason: 'generation_failed' });
    const successful = await service.generate(input);
    assert.equal(successful.ok, true);
    const duplicate = await service.generate(input);
    assert.equal(duplicate.ok, true);
    assert.equal(calls, 2);
  });

  it('validates platform language and input bounds before calling the model', async () => {
    let calls = 0;
    const { service } = makeService({
      generate: async () => { calls += 1; return { ok: true, soulYaml: SOUL, identitySummary: 'x' }; },
    });
    assert.deepEqual(await service.generate({
      accountId: 'acc-1', platform: 'facebook', keywordSelections: ['数据标注'], idempotencyKey: 'a',
    }), { ok: false, reason: 'writing_language_required' });
    assert.deepEqual(await service.generate({
      accountId: 'acc-1', platform: 'xiaohongshu', keywordSelections: ['数据标注'],
      writingLanguage: 'en', idempotencyKey: 'b',
    }), { ok: false, reason: 'writing_language_not_supported' });
    assert.deepEqual(await service.generate({
      accountId: 'acc-1', platform: undefined, keywordSelections: ['数据标注'], idempotencyKey: 'missing-platform',
    }), { ok: false, reason: 'unsupported_platform' });
    const expanded = await service.generate({
      accountId: 'acc-1', platform: 'xiaohongshu',
      keywordSelections: Array.from({ length: 64 }, (_, index) => `关键词-${index}`), idempotencyKey: 'expanded',
    });
    assert.equal(expanded.ok, true, '24 个可见偏好展开出的正常载荷应被允许');
    assert.deepEqual(await service.generate({
      accountId: 'acc-1', platform: 'xiaohongshu',
      keywordSelections: Array.from({ length: 65 }, (_, index) => `关键词-${index}`), idempotencyKey: 'too-many',
    }), { ok: false, reason: 'input_too_large' });
    assert.deepEqual(await service.generate({
      accountId: 'acc-1', platform: 'xiaohongshu', keywordSelections: ['x'.repeat(41)], idempotencyKey: 'c',
    }), { ok: false, reason: 'input_too_large' });
    assert.equal(calls, 1, '只有 64 项合法载荷可进入模型');
  });

  it('persists through the facade and returns the first-bind receipt', async () => {
    let armed = 0;
    const { service } = makeService({ armFirstBind: async () => (++armed === 1) });
    const result = await service.persist('acc-1', SOUL, 'client-auth:u1:p1');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.firstPostOnboarding, true);
    assert.equal(result.view.persona.updatedAt, '2026-07-20T01:00:00.000Z');
    assert.equal(result.view.persona.summary.name, '阿柚');
  });

  it('admin clear resets onboarding eligibility; next real bind returns true once and ordinary update stays idempotent', async () => {
    type TestPersonaRow = {
      accountId: string; persona: string; updatedAt: string | null; updatedBy: string | null;
    };
    let personaRow: TestPersonaRow | undefined = {
      accountId: 'acc-1', persona: SOUL, updatedAt: '2026-07-20T00:00:00.000Z', updatedBy: 'seed',
    };
    let firstPostExists = true;
    let boundCalls = 0;
    const store = {
      getRow: () => personaRow,
      listAccounts: async () => [{ accountId: 'acc-1', label: '阿柚' }],
      accountExists: async (accountId: string) => accountId === 'acc-1',
      set: async (accountId: string, persona: string, updatedBy: string) => {
        const next = { accountId, persona, updatedAt: '2026-07-20T02:00:00.000Z', updatedBy };
        personaRow = next;
        return next;
      },
      clear: async () => {
        personaRow = undefined;
        firstPostExists = false;
      },
    } as unknown as PersonaStore;
    const facade = createPersonaPanel({ store, onBound: () => { boundCalls += 1; } });
    const service = new AccountPersonaService({
      generator: {} as never,
      facade,
      firstPostOnboarding: {
        armFirstBind: async () => {
          if (firstPostExists) return false;
          firstPostExists = true;
          return true;
        },
      },
      logger: { warn() {} },
    });

    const cleared = await facade.setPersona('acc-1', '   ', 'admin');
    assert.equal(cleared.ok, true);
    assert.equal(firstPostExists, false, '后台清空把首作资格恢复为未建立');
    assert.equal(boundCalls, 0, '清空不误触发绑定唤醒');

    const rebound = await service.persist('acc-1', SOUL, 'client');
    assert.equal(rebound.ok && rebound.firstPostOnboarding, true, '重新建立人设只在首次重建时返回引导');
    const updated = await service.persist('acc-1', SOUL, 'client');
    assert.equal(updated.ok && updated.firstPostOnboarding, false, '普通更新不重复建立首作状态');
  });

  it('rejects invalid or failed persistence without returning success', async () => {
    const invalid = makeService().service;
    assert.deepEqual(await invalid.persist('acc-1', '', 'client'), { ok: false, reason: 'persona_required' });
    assert.deepEqual(await invalid.persist('acc-1', 'not yaml', 'client'), { ok: false, reason: 'persona_invalid' });

    const failed = makeService({ setPersona: async () => { throw new Error('pg down'); } }).service;
    assert.deepEqual(await failed.persist('acc-1', SOUL, 'client'), { ok: false, reason: 'persist_failed' });
  });

  it('summarizePersona rejects invalid definitions instead of inventing a summary', () => {
    assert.throws(() => summarizePersona('identity:\n  name: x\n'));
  });
});
