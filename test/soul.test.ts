import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSoul, loadSoulFromYaml, parseYaml, serializeSoul } from '../src/soul/index.js';
import { resolveLikeAffinity } from '../src/kernel/like-affinity.js';

test('loadSoul 从 soul.yaml 装载完整人设', () => {
  const soul = loadSoul();
  assert.equal(soul.identity.name, '小林');
  assert.equal(soul.identity.role, 'AI方向研发工程师');
  assert.equal(soul.interests.primary.length, 5);
  assert.equal(soul.interests.secondary.length, 3);
  assert.equal(soul.interests.seed_keywords.length, 6);
  assert.ok(soul.interests.seed_keywords.includes('LLM Agent'));
});

test('soul.yaml 新版已移除 engagement_rules / browse_patterns / session_limits，改用 behavior_guidelines（单场上限已搬到安全限额层）', () => {
  const soul = loadSoul();
  // 旧字段已废弃，应为 undefined
  assert.equal(soul.engagement_rules, undefined);
  assert.equal(soul.browse_patterns, undefined);
  // 新字段存在
  assert.ok(soul.behavior_guidelines);
  assert.equal(typeof soul.behavior_guidelines!.style, 'string');
  assert.equal(soul.behavior_guidelines!.like_affinity, 'normal');
  // 单场上限已从人设搬到安全限额层（change session-limits-to-quota-layer）：loader 不再解析该字段。
  assert.equal((soul as unknown as Record<string, unknown>).session_limits, undefined);
});

test('历史人设缺 like_affinity 按 normal，未知档位严格拒绝', () => {
  const soul = loadSoul();
  const legacy = {
    ...soul,
    behavior_guidelines: { ...soul.behavior_guidelines!, like_affinity: undefined },
  };
  const legacyBack = loadSoulFromYaml(serializeSoul(legacy));
  assert.equal(resolveLikeAffinity(legacyBack), 'normal');

  const invalid = {
    ...soul,
    behavior_guidelines: { ...soul.behavior_guidelines!, like_affinity: 'always' as never },
  };
  assert.throws(() => loadSoulFromYaml(serializeSoul(invalid)), /like_affinity/);
});

test('writing_language 可选兼容历史人设，合法值 round-trip，未知值严格拒绝', () => {
  const legacy = loadSoul();
  assert.equal(legacy.writing_language, undefined);

  const configured = { ...legacy, writing_language: 'vi' as const };
  const back = loadSoulFromYaml(serializeSoul(configured));
  assert.equal(back.writing_language, 'vi');
  assert.match(serializeSoul(configured), /writing_language: "vi"/);

  const invalidYaml = serializeSoul(configured).replace('writing_language: "vi"', 'writing_language: "fr"');
  assert.throws(() => loadSoulFromYaml(invalidYaml), /writing_language/);
});

test('parseYaml 处理嵌套 map / 列表 / 行内数组 / 注释', () => {
  const v = parseYaml([
    '# top comment',
    'a:',
    '  b: 1',
    '  c: "hello"  # inline',
    'list:',
    '  - x',
    '  - y',
    'flow: [1, 2, 3]',
  ].join('\n')) as Record<string, unknown>;
  assert.deepEqual(v.a, { b: 1, c: 'hello' });
  assert.deepEqual(v.list, ['x', 'y']);
  assert.deepEqual(v.flow, [1, 2, 3]);
});

test('loadSoulFromYaml 缺字段抛错（fail-fast）', () => {
  assert.throws(() => loadSoulFromYaml('identity:\n  name: "x"\n'));
});

test('loadSoulFromYaml 非法 search_source 抛错', () => {
  const bad = [
    'identity:',
    '  name: "n"', '  role: "r"', '  background: "b"', '  tone: "t"',
    'interests:',
    '  primary:', '    - "p"',
    '  secondary:', '    - "s"',
    '  seed_keywords:', '    - "k"',
    'engagement_rules:',
    '  like:', '    - "l"',
    '  skip:', '    - "sk"',
    '  comment_trigger:', '    - "c"',
    'browse_patterns:',
    '  mode: "state_machine"',
    '  states:',
    '    browse:',
    '      action: "a"',
    '      transitions:',
    '        - trigger: "t"',
    '          to: "search"',
    '          search_source: "bogus"',
    '  session:',
    '    max_duration_min: 1', '    max_likes: 1', '    max_searches: 1',
    '    cooldown_between_actions_sec: [1, 2]',
  ].join('\n');
  assert.throws(() => loadSoulFromYaml(bad), /search_source/);
});
