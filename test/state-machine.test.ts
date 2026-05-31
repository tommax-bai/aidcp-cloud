import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSoul } from '../src/soul/index.js';
import {
  BrowseStateMachine,
  createSession,
  emptyConceptPool,
  type ActionFeedback,
} from '../src/orchestrator/index.js';
import type { Soul } from '../src/soul/index.js';

function fixedClock(start = 1000): () => number {
  return () => start;
}

function makeMachine(soul: Soul, now = 1000, rng = () => 0) {
  const session = createSession(now, emptyConceptPool());
  return new BrowseStateMachine({ soul, clock: fixedClock(now), rng }, session);
}

test('browse: 点赞数达 3 → 迁移到 search（extract_from_liked，用点赞话题）', () => {
  const soul = loadSoul();
  const m = makeMachine(soul);
  let cmd!: ReturnType<BrowseStateMachine['feed']>;
  for (let i = 0; i < 3; i++) {
    cmd = m.feed({ kind: 'liked', topic: `topic-${i}` } as ActionFeedback);
  }
  assert.equal(cmd.kind, 'search');
  if (cmd.kind === 'search') {
    assert.equal(cmd.source, 'extract_from_liked');
    assert.equal(cmd.keyword, 'topic-2');
  }
  assert.equal(m.session.state, 'search');
  assert.equal(m.session.searchCount, 1);
  // 迁移后 likedCount 清零，避免反复触发
  assert.equal(m.session.likedCount, 0);
});

test('browse: 跳过数达 5 → 迁移到 search（random_from_interests，用种子词）', () => {
  const soul = loadSoul();
  const m = makeMachine(soul, 1000, () => 0);
  let cmd!: ReturnType<BrowseStateMachine['feed']>;
  for (let i = 0; i < 5; i++) cmd = m.feed({ kind: 'skipped' });
  assert.equal(cmd.kind, 'search');
  if (cmd.kind === 'search') {
    assert.equal(cmd.source, 'random_from_interests');
    assert.equal(cmd.keyword, soul.interests.seed_keywords[0]);
  }
  assert.equal(m.session.skippedCount, 0);
});

test('browse: 概念池有候选 → found_new_concept 迁移到 search', () => {
  const soul = loadSoul();
  const session = createSession(1000, { known: [], candidates: ['MoE 架构'], source: new Map() });
  const m = new BrowseStateMachine({ soul, clock: fixedClock(), rng: () => 0 }, session);
  const cmd = m.feed({ kind: 'browsed' });
  assert.equal(cmd.kind, 'search');
  if (cmd.kind === 'search') {
    assert.equal(cmd.source, 'new_concept');
    assert.equal(cmd.keyword, 'MoE 架构');
  }
  // 候选被消费，进入 known
  assert.ok(m.session.conceptPool.known.includes('MoE 架构'));
  assert.equal(m.session.conceptPool.candidates.length, 0);
});

test('search: 浏览满 max_results_to_browse → 回到 browse', () => {
  const soul = loadSoul();
  const session = createSession(1000, { known: [], candidates: ['x'], source: new Map() });
  const m = new BrowseStateMachine({ soul, clock: fixedClock(), rng: () => 0 }, session);
  // 进入 search
  m.feed({ kind: 'browsed' });
  assert.equal(m.session.state, 'search');
  // 浏览 3 个结果（max=3）
  let cmd!: ReturnType<BrowseStateMachine['feed']>;
  for (let i = 0; i < 3; i++) cmd = m.feed({ kind: 'browsed' });
  assert.equal(cmd.kind, 'browse_next');
  assert.equal(m.session.state, 'browse');
});

test('会话上限：点赞达 max_likes → end_session', () => {
  const soul = loadSoul();
  const m = makeMachine(soul);
  let cmd!: ReturnType<BrowseStateMachine['feed']>;
  for (let i = 0; i < soul.browse_patterns.session.max_likes; i++) {
    cmd = m.feed({ kind: 'liked', topic: `t${i}` });
  }
  assert.equal(cmd.kind, 'end_session');
  if (cmd.kind === 'end_session') assert.equal(cmd.reason, 'max_likes_reached');
  assert.equal(m.session.state, 'done');
});

test('会话上限：超时长 → end_session', () => {
  const soul = loadSoul();
  let now = 1000;
  const session = createSession(now, emptyConceptPool());
  const m = new BrowseStateMachine({ soul, clock: () => now, rng: () => 0 }, session);
  now += soul.browse_patterns.session.max_duration_min * 60000 + 1;
  const cmd = m.feed({ kind: 'browsed' });
  assert.equal(cmd.kind, 'end_session');
  if (cmd.kind === 'end_session') assert.equal(cmd.reason, 'max_duration_reached');
});

test('冷却秒数落在 soul 配置区间内', () => {
  const soul = loadSoul();
  const m = makeMachine(soul, 1000, () => 0.999999);
  const cmd = m.feed({ kind: 'browsed' });
  assert.equal(cmd.kind, 'browse_next');
  if (cmd.kind === 'browse_next') {
    const [min, max] = soul.browse_patterns.session.cooldown_between_actions_sec;
    assert.ok(cmd.cooldownSec >= min && cmd.cooldownSec <= max);
  }
});

test('done 后再 feed → 始终 end_session', () => {
  const soul = loadSoul();
  const m = makeMachine(soul);
  m.end('manual');
  const cmd = m.feed({ kind: 'liked' });
  assert.equal(cmd.kind, 'end_session');
});
