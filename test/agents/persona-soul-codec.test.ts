import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONA_SOUL_CODEC } from '../../src/agents/persona-soul-codec.js';

test('persona Soul codec round-trips the exact content-owned generation subset', () => {
  const parsed = PERSONA_SOUL_CODEC.parseValue({
    identity: {
      name: '成分阿满',
      role: '克制的护肤成分党',
      background: '记录配方与肤感，不编造职业经历',
      tone: '理性、亲切',
    },
    interests: {
      primary: ['护肤'],
      secondary: ['摄影'],
      seed_keywords: ['屏障修护', '视黄醇搭配'],
    },
  });
  const withGeneratedFields = {
    ...parsed,
    writing_language: 'zh-CN' as const,
    behavior_guidelines: {
      style: '理性、亲切；浏览、点赞与收藏保持自然、有分寸',
      privacy: '不编造私人经历',
      collection_principle: '只收藏长期有用的内容',
      like_principle: '谨慎点赞',
      like_affinity: 'normal' as const,
    },
  };

  const yaml = PERSONA_SOUL_CODEC.serialize(withGeneratedFields);
  assert.deepEqual(PERSONA_SOUL_CODEC.parseYaml(yaml), withGeneratedFields);
});

test('persona Soul codec rejects fields outside the generated schema truth', () => {
  assert.throws(
    () => PERSONA_SOUL_CODEC.parseValue({
      identity: {
        name: '测试',
        role: '测试',
        background: '测试',
        tone: '测试',
      },
      interests: {
        primary: ['测试'],
        secondary: [],
        seed_keywords: ['测试'],
      },
      writing_language: 'unknown',
    }),
    /writing_language/,
  );
  assert.throws(
    () => PERSONA_SOUL_CODEC.parseValue({
      identity: {
        name: '测试',
        role: '测试',
        background: '测试',
        tone: '',
      },
      interests: {
        primary: ['测试'],
        secondary: [],
        seed_keywords: ['测试'],
      },
    }),
    /identity\.tone/,
  );
});
