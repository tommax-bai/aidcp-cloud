import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACEBOOK_REELS_LIKE_PROBABILITY,
  RoleDispatcher,
  type EdgeCommand,
} from '../../src/orchestrator/role-dispatcher.js';
import { ActionCooldownGate } from '../../src/risk/action-cooldown.js';
import { InteractionGuard } from '../../src/risk/interaction-guard.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'Reel Test', role: 'viewer', background: 'test', tone: 'plain' },
  interests: { primary: ['video'], secondary: [], seed_keywords: [] },
};

const reelCard = (id = '42') => ({
  index: 0,
  noteId: `https://www.facebook.com/reel/${id}`,
  title: `reel ${id}`,
  likeCount: 0,
  collectCount: 0,
});

const feedVideoCard = (id = '42', title = `feed video ${id}`) => ({
  index: 0,
  noteId: `https://www.facebook.com/watch?v=${id}`,
  title,
  likeCount: 0,
  collectCount: 0,
  isVideo: true,
});

type InteractionAction = 'like' | 'collect' | 'follow' | 'comment' | 'comment_like';

function startDispatcher(options: {
  randomFn?: () => number;
  platform?: 'facebook' | 'xiaohongshu';
  canInteract?: (action: InteractionAction) => boolean;
  hasReelFollow?: boolean;
  cooldownGate?: ActionCooldownGate;
  interactionGuard?: InteractionGuard;
  clock?: () => number;
  mode?: 'persona' | 'slow_start' | 'facebook_rule' | 'consumption' | 'blocked';
  modeRef?: { current: 'persona' | 'slow_start' | 'facebook_rule' | 'consumption' | 'blocked' };
  reelCadence?: { viewsPerLike?: number; viewsPerFollow: number };
} = {}) {
  const commands: EdgeCommand[] = [];
  let llmCalls = 0;
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => { llmCalls++; return '{"verdict":"skip","reason":"test"}'; } },
    accountPlatform: options.platform ?? 'facebook',
    randomFn: options.randomFn,
    canInteract: options.canInteract,
    hasReelFollow: () => options.hasReelFollow ?? false,
    cooldownGate: options.cooldownGate,
    interactionGuard: options.interactionGuard,
    clock: options.clock,
    facebookRuleModeDecision: () => {
      const mode = options.modeRef?.current ?? options.mode ?? 'persona';
      return {
        mode,
        blocker: mode === 'blocked' ? 'test_blocked' : null,
        reelCadence: options.reelCadence ?? (
          mode === 'persona'
            ? { viewsPerLike: 4, viewsPerFollow: 10 }
            : mode === 'slow_start'
              ? { viewsPerLike: 15, viewsPerFollow: 15 }
              : { viewsPerFollow: 15 }
        ),
      };
    },
    sendCommand: (command) => commands.push(command),
  });
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands, llmCalls: () => llmCalls };
}

function reportReel(dispatcher: RoleDispatcher, id = '42', author?: string): void {
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...reelCard(id), ...(author ? { author } : {}) }],
    listKind: 'reels',
    ts: Date.now(),
  });
}

function reportFeedVideo(dispatcher: RoleDispatcher, id = '42', title = `feed video ${id}`): void {
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [feedVideoCard(id, title)],
    listKind: 'feed',
    ts: Date.now(),
  });
}

test('普通人设 Reel: 默认每 4 个唯一 Reel 只在第 4 个下发 note-scoped like', () => {
  const { dispatcher, commands } = startDispatcher();
  for (let id = 1; id <= 4; id += 1) reportReel(dispatcher, String(id), `Author ${id}`);

  const likes = commands.filter((command) => command.action === 'like');
  assert.equal(likes.length, 1);
  assert.equal(likes[0]?.reason, 'facebook_reel_persona_cadence_hit');
  assert.equal(likes[0]?.params?.noteId, 'https://www.facebook.com/reel/4');
  dispatcher.endSession('test');
});

test('普通人设 Reel: Feed、畸形目标和重复 Reel 不推进 N 计数', () => {
  const { dispatcher, commands } = startDispatcher({
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
    randomFn: () => Number.NaN,
  });
  dispatcher.bus.emit('page.cards.arrived', { cards: [reelCard('feed')], listKind: 'feed', ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', { cards: [reelCard('1'), reelCard('2')], listKind: 'reels', ts: 2 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...reelCard('bad'), noteId: 'https://evil.example/reel/bad' }], listKind: 'reels', ts: 3,
  });
  reportReel(dispatcher, '10', 'A');
  reportReel(dispatcher, '10', 'A');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  reportReel(dispatcher, '11', 'B');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  assert.equal(commands.find((command) => command.action === 'like')?.params?.noteId, 'https://www.facebook.com/reel/11');
  dispatcher.endSession('test');
});

test('冷启动 Reel: 独立 N 边界只对唯一规范 Reel 下发 mode-scoped like', () => {
  const { dispatcher, commands } = startDispatcher({
    mode: 'slow_start',
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
  });
  reportReel(dispatcher, '20', 'A');
  reportReel(dispatcher, '20', 'A');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  reportReel(dispatcher, '21', 'B');
  const likes = commands.filter((command) => command.action === 'like');
  assert.equal(likes.length, 1);
  assert.equal(likes[0]?.reason, 'facebook_reel_slow_start_cadence_hit');
  assert.equal(likes[0]?.params?.noteId, 'https://www.facebook.com/reel/21');
  dispatcher.endSession('test');
});

test('规则与消费模式不获得 Reel 点赞节奏，即使投影意外夹带 viewsPerLike', () => {
  for (const mode of ['facebook_rule', 'consumption'] as const) {
    const candidate = startDispatcher({
      mode,
      reelCadence: { viewsPerLike: 1, viewsPerFollow: 100 },
    });
    reportReel(candidate.dispatcher, mode, 'Bao');
    assert.equal(candidate.commands.some((command) => command.action === 'like'), false, mode);
    candidate.dispatcher.endSession('test');
  }
});

test('冷启动 Reel: 点赞与关注同一 N 边界分别产生一个既有意图', () => {
  const { dispatcher, commands } = startDispatcher({
    mode: 'slow_start',
    hasReelFollow: true,
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 2 },
  });
  reportReel(dispatcher, '30', 'A');
  reportReel(dispatcher, '31', 'B');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  assert.equal(commands.filter((command) => command.action === 'follow').length, 1);
  dispatcher.endSession('test');
});

test('Reel cadence: 会话中模式切换仍按模式分别去重和计数', () => {
  const modeRef = { current: 'persona' as 'persona' | 'facebook_rule' };
  const candidate = startDispatcher({
    modeRef,
    hasReelFollow: true,
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 2 },
  });
  reportReel(candidate.dispatcher, '1', 'A');
  modeRef.current = 'facebook_rule';
  reportReel(candidate.dispatcher, '1', 'A');
  reportReel(candidate.dispatcher, '2', 'B');
  assert.equal(candidate.commands.filter((command) => command.action === 'follow').length, 1);
  assert.equal(candidate.commands.some((command) => command.action === 'like'), false);

  modeRef.current = 'persona';
  reportReel(candidate.dispatcher, '2', 'B');
  assert.equal(candidate.commands.filter((command) => command.action === 'like').length, 1);
  assert.equal(candidate.commands.filter((command) => command.action === 'follow').length, 2);
  candidate.dispatcher.endSession('test');
});

test('Reel cadence: persona 与冷启动对同一 Reel 分别去重和计数', () => {
  const modeRef = { current: 'persona' as 'persona' | 'slow_start' };
  const { dispatcher, commands } = startDispatcher({
    modeRef,
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
  });
  reportReel(dispatcher, '60', 'A');
  modeRef.current = 'slow_start';
  reportReel(dispatcher, '60', 'A');
  reportReel(dispatcher, '61', 'B');
  modeRef.current = 'persona';
  reportReel(dispatcher, '61', 'B');
  assert.deepEqual(
    commands.filter((command) => command.action === 'like').map((command) => command.reason),
    ['facebook_reel_slow_start_cadence_hit', 'facebook_reel_persona_cadence_hit'],
  );
  dispatcher.endSession('test');
});

test('普通人设 Reel: N 边界被风险拒绝不形成补写债', () => {
  let allowed = false;
  const { dispatcher, commands } = startDispatcher({
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
    canInteract: (action) => action !== 'like' || allowed,
  });
  reportReel(dispatcher, '1');
  reportReel(dispatcher, '2');
  allowed = true;
  reportReel(dispatcher, '3');
  assert.equal(commands.some((command) => command.action === 'like'), false, '第 3 个不得补写第 2 个的债');
  reportReel(dispatcher, '4');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  dispatcher.endSession('test');
});

test('冷启动 Reel: N 边界被风险拒绝不形成补写债', () => {
  let allowed = false;
  const { dispatcher, commands } = startDispatcher({
    mode: 'slow_start',
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
    canInteract: (action) => action !== 'like' || allowed,
  });
  reportReel(dispatcher, '40');
  reportReel(dispatcher, '41');
  allowed = true;
  reportReel(dispatcher, '42');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  reportReel(dispatcher, '43');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  dispatcher.endSession('test');
});

test('普通人设 Reel: 会话边界清空 N 计数和 Reel 去重', () => {
  const { dispatcher, commands } = startDispatcher({
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
  });
  reportReel(dispatcher, '1');
  dispatcher.endSession('first');
  dispatcher.startSession();
  reportReel(dispatcher, '1');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  reportReel(dispatcher, '2');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  dispatcher.endSession('second');
});

test('冷启动 Reel: 会话边界清空 N 计数和 Reel 去重', () => {
  const { dispatcher, commands } = startDispatcher({
    mode: 'slow_start',
    reelCadence: { viewsPerLike: 2, viewsPerFollow: 100 },
  });
  reportReel(dispatcher, '50');
  dispatcher.endSession('first');
  dispatcher.startSession();
  reportReel(dispatcher, '50');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  reportReel(dispatcher, '51');
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  dispatcher.endSession('second');
});

test('Reel follow: 当前模式独立 N 计数并保留作者与 Reel 双锚点', () => {
  const persona = startDispatcher({
    hasReelFollow: true,
    reelCadence: { viewsPerLike: 100, viewsPerFollow: 2 },
  });
  reportReel(persona.dispatcher, '1', 'A');
  reportReel(persona.dispatcher, '2', ' Salon   de Comolis ');
  const follow = persona.commands.find((command) => command.action === 'follow');
  assert.equal(follow?.reason, 'facebook_reel_mode_cadence_hit');
  assert.equal(follow?.params?.noteId, 'https://www.facebook.com/reel/2');
  assert.equal(follow?.params?.authorId, 'Salon de Comolis');
  persona.dispatcher.endSession('test');

  const rule = startDispatcher({
    mode: 'facebook_rule',
    hasReelFollow: true,
    reelCadence: { viewsPerFollow: 2 },
  });
  reportReel(rule.dispatcher, '10', 'A');
  reportReel(rule.dispatcher, '11', 'B');
  assert.equal(rule.commands.filter((command) => command.action === 'follow').length, 1);
  assert.equal(rule.commands.some((command) => command.action === 'like'), false);
  rule.dispatcher.endSession('test');
});

test('Reel follow: 旧 Edge、缺作者、会话配额耗尽均在 N 边界失败关闭', () => {
  const oldEdge = startDispatcher({ reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 } });
  reportReel(oldEdge.dispatcher, '90', 'Bao');
  assert.equal(oldEdge.commands.some((command) => command.action === 'follow'), false);
  oldEdge.dispatcher.endSession('test');

  const missingAuthor = startDispatcher({ hasReelFollow: true, reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 } });
  reportReel(missingAuthor.dispatcher, '91');
  assert.equal(missingAuthor.commands.some((command) => command.action === 'follow'), false);
  missingAuthor.dispatcher.endSession('test');

  const exhausted = startDispatcher({ hasReelFollow: true, reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 } });
  while (exhausted.dispatcher.consumeBudget('follow')) { /* exhaust the bounded session quota */ }
  reportReel(exhausted.dispatcher, '92', 'Bao');
  assert.equal(exhausted.commands.some((command) => command.action === 'follow'), false);
  exhausted.dispatcher.endSession('test');
});

test('Reel follow: RiskController、动作冷却与作者去重逐层拦截', () => {
  const now = 1_000_000;
  const cooldownGate = new ActionCooldownGate({ startedAtMs: 0, restartQuietMs: 0 });
  cooldownGate.markActed('__unbound__', 'follow', now - 1_000);
  const guard = new InteractionGuard();
  guard.complete(InteractionGuard.keyFor('follow', { authorId: 'Bao' }));

  const cases = [
    startDispatcher({ hasReelFollow: true, reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 }, canInteract: (action) => action !== 'follow' }),
    startDispatcher({ hasReelFollow: true, reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 }, cooldownGate, clock: () => now }),
    startDispatcher({ hasReelFollow: true, reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 }, interactionGuard: guard }),
  ];
  for (const [index, candidate] of cases.entries()) {
    reportReel(candidate.dispatcher, String(100 + index), 'Bao');
    assert.equal(candidate.commands.some((command) => command.action === 'follow'), false);
    candidate.dispatcher.endSession('test');
  }
});

test('Facebook Reel follow: 下发不扣配额，只有新关注成功回执扣一次', () => {
  const { dispatcher, commands } = startDispatcher({
    hasReelFollow: true,
    reelCadence: { viewsPerLike: 100, viewsPerFollow: 1 },
  });
  const before = dispatcher.remainingFollows;
  reportReel(dispatcher, '120', 'Bao');
  assert.equal(commands.filter((command) => command.action === 'follow').length, 1);
  assert.equal(dispatcher.remainingFollows, before, '命令下发不乐观扣关注配额');

  dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, ts: 1 });
  assert.equal(dispatcher.remainingFollows, before - 1, '真实新关注成功才扣一次');
  dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, reason: 'already_followed', ts: 2 });
  assert.equal(dispatcher.remainingFollows, before - 1, 'already_followed 是 no-op，不重复扣额');
  dispatcher.endSession('test');
});

test('Facebook Feed video: 唯一安全视频 random < 0.25 时立即下发一次 note-scoped like 意图', () => {
  const { dispatcher, commands } = startDispatcher({ randomFn: () => FACEBOOK_REELS_LIKE_PROBABILITY - Number.EPSILON });
  reportFeedVideo(dispatcher, '1632570071375207', 'Cách nấu cá niêng trong ống tre ngon đến mức ăn quên no');

  const likes = commands.filter((command) => command.action === 'like');
  assert.equal(likes.length, 1);
  assert.equal(likes[0]?.reason, 'facebook_feed_video_probability_hit');
  assert.equal(likes[0]?.params?.noteId, 'https://www.facebook.com/watch?v=1632570071375207');
  dispatcher.endSession('test');
});

test('Facebook Feed video: random === 0.25、空摘要和明显高风险摘要均弃权且重报不重抽', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return FACEBOOK_REELS_LIKE_PROBABILITY; } });
  reportFeedVideo(dispatcher, '100', 'safe cooking video');
  reportFeedVideo(dispatcher, '100', 'safe cooking video');
  reportFeedVideo(dispatcher, '200', '');
  reportFeedVideo(dispatcher, '200', 'now safe but duplicate');
  reportFeedVideo(dispatcher, '300', 'casino gambling highlights');
  reportFeedVideo(dispatcher, '300', 'now safe but duplicate');

  assert.equal(randomCalls, 1, '只有安全且有摘要的视频掷一次骰；安全缺口也占据一次性决策坑');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  dispatcher.endSession('test');
});

test('Facebook Feed video: 一批可混有普通卡但必须恰好一个视频；多视频与非规范目标失败关闭', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return 0.1; } });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [
      { ...feedVideoCard('401'), index: 1 },
      { index: 0, noteId: 'https://www.facebook.com/a/posts/400', title: 'text', likeCount: 0, collectCount: 0, isVideo: false },
    ],
    listKind: 'feed', ts: 1,
  });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [feedVideoCard('501'), feedVideoCard('502')], listKind: 'feed', ts: 2,
  });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...feedVideoCard('601'), noteId: 'https://evil.example/watch?v=601' }], listKind: 'feed', ts: 3,
  });

  assert.equal(randomCalls, 1);
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  assert.equal(commands.find((command) => command.action === 'like')?.params?.noteId, 'https://www.facebook.com/watch?v=401');
  dispatcher.endSession('test');
});
