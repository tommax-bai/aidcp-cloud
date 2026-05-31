import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSoul, loadSoulFromYaml, parseYaml } from '../src/soul/index.js';

test('loadSoul 从 soul.yaml 装载完整人设', () => {
  const soul = loadSoul();
  assert.equal(soul.identity.name, '小林');
  assert.equal(soul.identity.role, 'AI方向研发工程师');
  assert.equal(soul.interests.primary.length, 5);
  assert.equal(soul.interests.secondary.length, 3);
  assert.equal(soul.interests.seed_keywords.length, 6);
  assert.ok(soul.interests.seed_keywords.includes('LLM Agent'));
});

test('engagement_rules 含硬门槛与三类规则', () => {
  const soul = loadSoul();
  assert.equal(soul.engagement_rules.quality_threshold.min_likes, 50);
  assert.equal(soul.engagement_rules.quality_threshold.min_collects, 20);
  assert.equal(soul.engagement_rules.like.length, 3);
  assert.equal(soul.engagement_rules.skip.length, 3);
  assert.equal(soul.engagement_rules.comment_trigger.length, 3);
});

test('browse_patterns 状态机与会话上限解析正确', () => {
  const soul = loadSoul();
  assert.equal(soul.browse_patterns.mode, 'state_machine');
  assert.deepEqual(Object.keys(soul.browse_patterns.states).sort(), ['browse', 'search']);
  const browse = soul.browse_patterns.states.browse;
  assert.equal(browse.transitions.length, 3);
  assert.equal(browse.transitions[0].trigger, 'liked_count >= 3');
  assert.equal(browse.transitions[0].to, 'search');
  assert.equal(browse.transitions[0].search_source, 'extract_from_liked');
  assert.equal(soul.browse_patterns.states.search.max_results_to_browse, 3);
  const s = soul.browse_patterns.session;
  assert.equal(s.max_duration_min, 10);
  assert.equal(s.max_likes, 8);
  assert.equal(s.max_searches, 3);
  assert.deepEqual(s.cooldown_between_actions_sec, [3, 8]);
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
    '  quality_threshold:', '    min_likes: 1', '    min_collects: 1',
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
