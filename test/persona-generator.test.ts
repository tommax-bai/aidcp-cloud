/**
 * change edge-persona-keyword-generation — 建号自助人设生成的单测。
 *
 * 覆盖：
 *  - serializeSoul → loadSoulFromYaml round-trip（含中文/引号/#/空数组，守 YAML 子集不漂移）；
 *  - PersonaGenerator：合法 JSON → ok；垃圾/缺字段/LLM 抛错 → 硬 fail-closed（绝不返回模板/半成品）；
 *  - 每账号差异化种子拌进 prompt；
 *  - handler persona.generate 幂等去重（同 idempotencyKey 只调一次生成器、不双计费）。
 *
 * 环境层级：离线 / 逻辑级（stub LLM，无外部依赖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeSoul, loadSoulFromYaml } from '../src/soul/index.js';
import type { Soul } from '../src/kernel/soul-types.js';
import {
  extractLikeAffinitySelection,
  PersonaGenerator,
  type PersonaGenerateInput,
} from '../src/agents/persona-generator.js';
import { makeEnvelope } from '../src/comm/protocol.js';
import { DefaultMessageHandler } from '../src/comm/handler.js';

const VALID_SOUL_JSON = JSON.stringify({
  identity: {
    name: '小柚',
    role: '护肤成分党',
    background: '平时爱研究成分表，喜欢分享踩坑经验',
    tone: '亲切、爱分享、接地气',
  },
  interests: {
    primary: ['护肤成分', '敏感肌护理'],
    secondary: ['平价好物'],
    seed_keywords: ['烟酰胺 测评', '敏感肌 面霜', '成分党 护肤'],
  },
});

/** 造一个返回固定文本的 stub LLM，并记录收到的 prompt。 */
function stubLlm(response: string | (() => Promise<string>)) {
  const calls: { prompt: string }[] = [];
  return {
    calls,
    complete: async (prompt: string): Promise<string> => {
      calls.push({ prompt });
      return typeof response === 'string' ? response : response();
    },
  };
}

describe('serializeSoul round-trip（YAML 子集不漂移）', () => {
  it('中文 + 引号 + # + 空 secondary 数组都能 round-trip', () => {
    const soul: Soul = {
      identity: {
        name: '阿"引号"号',
        role: '带 # 井号的角色',
        background: '第一行背景',
        tone: '技术向、理性',
      },
      interests: {
        primary: ['LLM 应用', 'RAG 实战'],
        secondary: [], // 空数组：序列化为行内 []，避免被解析成 null
        seed_keywords: ['大模型 部署', 'Prompt 技巧'],
      },
    };
    const yaml = serializeSoul(soul);
    const back = loadSoulFromYaml(yaml);
    assert.equal(back.identity.name, '阿"引号"号');
    assert.equal(back.identity.role, '带 # 井号的角色');
    assert.deepEqual(back.interests.secondary, []);
    assert.deepEqual(back.interests.seed_keywords, ['大模型 部署', 'Prompt 技巧']);
  });

  it('可选 behavior_guidelines 存在时也 round-trip', () => {
    const soul: Soul = {
      identity: { name: 'n', role: 'r', background: 'b', tone: 't' },
      interests: { primary: ['a'], secondary: ['b'], seed_keywords: ['c'] },
      behavior_guidelines: {
        style: '精准浏览',
        privacy: '不盲目回关',
        collection_principle: '只收藏硬核',
        like_principle: '有共鸣才点',
        like_affinity: 'like_more',
      },
    };
    const back = loadSoulFromYaml(serializeSoul(soul));
    assert.equal(back.behavior_guidelines?.style, '精准浏览');
    assert.equal(back.behavior_guidelines?.like_principle, '有共鸣才点');
    assert.equal(back.behavior_guidelines?.like_affinity, 'like_more');
  });
});

describe('PersonaGenerator', () => {
  const baseInput: PersonaGenerateInput = {
    accountId: 'acc-1',
    keywordSelections: ['美妆', '护肤', '活泼'],
    diversitySeed: 'account:acc-1|nonce:SEED-XYZ',
  };

  it('合法 JSON → ok，soulYaml 能被 loadSoulFromYaml 解析', async () => {
    const llm = stubLlm(VALID_SOUL_JSON);
    const gen = new PersonaGenerator({ llm });
    const out = await gen.generate(baseInput);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const soul = loadSoulFromYaml(out.soulYaml);
    assert.equal(soul.identity.name, '小柚');
    assert.deepEqual(soul.interests.seed_keywords, ['烟酰胺 测评', '敏感肌 面霜', '成分党 护肤']);
    assert.equal(soul.behavior_guidelines?.like_affinity, 'normal', '旧客户端无标记应按正常档');
    assert.match(soul.behavior_guidelines?.like_principle ?? '', /护肤成分/);
    assert.equal(soul.mandatory_interactions, undefined, '点赞倾向绝不生成强制互动规则');
    assert.ok(out.identitySummary.includes('小柚'));
  });

  it('Facebook 发言语言由结构化输入确定性写入 Soul，不交给模型猜', async () => {
    const llm = stubLlm(VALID_SOUL_JSON);
    const gen = new PersonaGenerator({ llm });
    const out = await gen.generate({ ...baseInput, writingLanguage: 'vi' });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(loadSoulFromYaml(out.soulYaml).writing_language, 'vi');
    assert.doesNotMatch(llm.calls[0].prompt, /writing_language|越南语/, '结构化账号配置不应被模型自由改写');
  });

  it('更喜欢标记被剥离并确定性映射到 behavior_guidelines', async () => {
    const llm = stubLlm(VALID_SOUL_JSON);
    const gen = new PersonaGenerator({ llm });
    const out = await gen.generate({
      ...baseInput,
      keywordSelections: [...baseInput.keywordSelections, 'like_affinity:like_most'],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const soul = loadSoulFromYaml(out.soulYaml);
    assert.equal(soul.behavior_guidelines?.like_affinity, 'like_most');
    assert.match(soul.behavior_guidelines?.like_principle ?? '', /明显偏向点赞/);
    assert.doesNotMatch(llm.calls[0].prompt, /like_affinity:/, '内部 token 不得污染生成 prompt');
    assert.equal(soul.mandatory_interactions, undefined);
  });

  it('未知或重复档位标记按 normal，且全部从兴趣关键词剥离', () => {
    assert.deepEqual(
      extractLikeAffinitySelection(['美妆', 'like_affinity:bogus']),
      { keywords: ['美妆'], likeAffinity: 'normal' },
    );
    assert.deepEqual(
      extractLikeAffinitySelection(['美妆', 'like_affinity:like_more', 'like_affinity:like_most']),
      { keywords: ['美妆'], likeAffinity: 'normal' },
    );
  });

  it('垃圾输出（非 JSON）→ 硬 fail-closed，绝不返回模板/半成品', async () => {
    const llm = stubLlm('抱歉我不能帮你做这个');
    const gen = new PersonaGenerator({ llm, maxRetries: 1 });
    const out = await gen.generate(baseInput);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'persona_invalid');
    assert.equal('soulYaml' in out, false); // 无任何草稿字段
    assert.equal(llm.calls.length, 2); // 首次 + 1 次重试
  });

  it('缺字段 JSON（结构校验不过）→ fail-closed persona_invalid', async () => {
    const llm = stubLlm(JSON.stringify({ identity: { name: 'x' } }));
    const gen = new PersonaGenerator({ llm, maxRetries: 0 });
    const out = await gen.generate(baseInput);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, 'persona_invalid');
  });

  it('LLM 抛错 → fail-closed generation_failed（不抛、不兜底）', async () => {
    const llm = {
      complete: async (): Promise<string> => {
        throw new Error('timeout');
      },
    };
    const gen = new PersonaGenerator({ llm, maxRetries: 1 });
    const out = await gen.generate(baseInput);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, 'generation_failed');
  });

  it('空关键词 → no_keywords（不调用 LLM）', async () => {
    const llm = stubLlm(VALID_SOUL_JSON);
    const gen = new PersonaGenerator({ llm });
    const out = await gen.generate({ accountId: 'a', keywordSelections: [] });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, 'no_keywords');
    assert.equal(llm.calls.length, 0);
  });

  it('差异化种子拌进 prompt（抗跨账号同质化）', async () => {
    const llm = stubLlm(VALID_SOUL_JSON);
    const gen = new PersonaGenerator({ llm });
    await gen.generate(baseInput);
    assert.ok(llm.calls[0].prompt.includes('SEED-XYZ'));
  });
});

describe('handler persona.generate 幂等去重', () => {
  function makeHandler(gen: { generate: (i: PersonaGenerateInput) => Promise<unknown> }) {
    // persona 路径只用 personaGenerator / session.accountId / clock；其余 deps 造 noop stub（永不被调）。
    return new DefaultMessageHandler({
      planner: { plan: async () => ({ steps: [], reason: '' }) } as never,
      llm: { complete: async () => '' } as never,
      cache: {
        get: async () => null,
        recordHit: async () => {},
        recordFailure: async () => {},
        stage: async () => {},
        confirmStaged: async () => ({ promoted: false, successes: 0, needed: 0 }),
        dropStaged: async () => {},
      } as never,
      eventBus: { emit: () => {}, on: () => {} } as never,
      personaGenerator: gen as never,
    });
  }

  it('同 idempotencyKey 重复请求只调一次生成器（防双计费）', async () => {
    let calls = 0;
    const gen = {
      generate: async () => {
        calls++;
        return { ok: true, soulYaml: 'identity:\n  name: "x"', identitySummary: 'x' };
      },
    };
    const handler = makeHandler(gen);
    const session = { accountId: 'acc-1', edgeId: 'edge-1' } as never;
    const payload = { accountId: 'acc-1', keywordSelections: ['美妆'], idempotencyKey: 'k1' };

    const r1 = await handler.handle(makeEnvelope('persona.generate', 'req-1', 1700000000000, payload), session);
    const r2 = await handler.handle(makeEnvelope('persona.generate', 'req-2', 1700000000001, payload), session);

    assert.equal(calls, 1); // 幂等：第二次命中缓存、不再调生成器
    assert.equal(r1?.type, 'persona.generate.result');
    assert.equal((r1?.payload as { ok: boolean }).ok, true);
    assert.equal((r2?.payload as { ok: boolean }).ok, true);
  });

  it('兼容入口允许 64 项展开载荷，并在模型调用前拒绝第 65 项或 41 字单项', async () => {
    const inputs: PersonaGenerateInput[] = [];
    const handler = makeHandler({
      generate: async (input) => {
        inputs.push(input);
        return { ok: true, soulYaml: 'identity:\n  name: "x"', identitySummary: 'x' };
      },
    });
    const session = { accountId: 'acc-1', edgeId: 'edge-1', platform: 'xiaohongshu' } as never;
    const accepted = await handler.handle(makeEnvelope('persona.generate', 'bounds-64', 1, {
      accountId: 'ignored',
      keywordSelections: Array.from({ length: 64 }, (_, index) => `关键词-${index}`),
      idempotencyKey: 'bounds-64',
    }), session);
    assert.equal((accepted?.payload as { ok?: boolean }).ok, true);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].keywordSelections.length, 64);

    const tooMany = await handler.handle(makeEnvelope('persona.generate', 'bounds-65', 2, {
      accountId: 'ignored',
      keywordSelections: Array.from({ length: 65 }, (_, index) => `关键词-${index}`),
      idempotencyKey: 'bounds-65',
    }), session);
    assert.equal((tooMany?.payload as { reason?: string }).reason, 'input_too_large');

    const tooLong = await handler.handle(makeEnvelope('persona.generate', 'bounds-long', 3, {
      accountId: 'ignored', keywordSelections: ['x'.repeat(41)], idempotencyKey: 'bounds-long',
    }), session);
    assert.equal((tooLong?.payload as { reason?: string }).reason, 'input_too_large');
    assert.equal(inputs.length, 1, '超限请求不得进入模型');
  });

  it('Facebook 生成人设必须携带合法发言语言；小红书禁止携带', async () => {
    const inputs: PersonaGenerateInput[] = [];
    const handler = makeHandler({
      generate: async (input) => {
        inputs.push(input);
        return { ok: true, soulYaml: 'identity:\n  name: "x"', identitySummary: 'x' };
      },
    });
    const fbSession = { accountId: 'fb-1', edgeId: 'edge-1', platform: 'facebook' } as never;
    const missing = await handler.handle(makeEnvelope('persona.generate', 'fb-1', 1, {
      accountId: 'fb-1', keywordSelections: ['咖啡'], idempotencyKey: 'fb-missing',
    }), fbSession);
    assert.equal((missing?.payload as { reason?: string }).reason, 'writing_language_required');

    const ok = await handler.handle(makeEnvelope('persona.generate', 'fb-2', 2, {
      accountId: 'fb-1', keywordSelections: ['咖啡'], writingLanguage: 'en', idempotencyKey: 'fb-ok',
    }), fbSession);
    assert.equal((ok?.payload as { ok?: boolean }).ok, true);
    assert.equal(inputs[0].writingLanguage, 'en');

    const xhsSession = { accountId: 'xhs-1', edgeId: 'edge-1', platform: 'xiaohongshu' } as never;
    const unsupported = await handler.handle(makeEnvelope('persona.generate', 'xhs-1', 3, {
      accountId: 'xhs-1', keywordSelections: ['咖啡'], writingLanguage: 'vi', idempotencyKey: 'xhs-lang',
    }), xhsSession);
    assert.equal((unsupported?.payload as { reason?: string }).reason, 'writing_language_not_supported');
  });

  it('缺 accountId → 诚实回 unknown_account，不调生成器', async () => {
    let calls = 0;
    const gen = { generate: async () => { calls++; return { ok: true, soulYaml: '', identitySummary: '' }; } };
    const handler = makeHandler(gen);
    const session = { edgeId: 'edge-1' } as never; // 无 accountId
    const payload = { accountId: 'acc-1', keywordSelections: ['x'], idempotencyKey: 'k' };
    const r = await handler.handle(makeEnvelope('persona.generate', 'req-1', 1700000000000, payload), session);
    assert.equal((r?.payload as { ok: boolean; reason?: string }).ok, false);
    assert.equal((r?.payload as { reason?: string }).reason, 'unknown_account');
    assert.equal(calls, 0);
  });

  it('persona.persist 只在账号首次建立持久首作状态时返回一次性引导标记', async () => {
    let armCalls = 0;
    const handler = new DefaultMessageHandler({
      planner: { plan: async () => ({ steps: [], reason: '' }) } as never,
      llm: { complete: async () => '' } as never,
      cache: {
        get: async () => null,
        recordHit: async () => {},
        recordFailure: async () => {},
        stage: async () => {},
        confirmStaged: async () => ({ promoted: false, successes: 0, needed: 0 }),
        dropStaged: async () => {},
      } as never,
      eventBus: { emit: () => {}, on: () => {} } as never,
      personaFacade: { setPersona: async () => ({ ok: true }) } as never,
      firstPostOnboarding: { armFirstBind: async () => (++armCalls === 1) },
    });
    const session = { accountId: 'acc-1', edgeId: 'edge-1' } as never;
    const first = await handler.handle(
      makeEnvelope('persona.persist', 'persist-1', 1700000000000, { accountId: 'acc-1', soulYaml: 'identity: {}' }),
      session,
    );
    const update = await handler.handle(
      makeEnvelope('persona.persist', 'persist-2', 1700000000001, { accountId: 'acc-1', soulYaml: 'identity: {}' }),
      session,
    );

    assert.deepEqual(first?.payload, { ok: true, firstPostOnboarding: true });
    assert.deepEqual(update?.payload, { ok: true, firstPostOnboarding: false });
  });
});
