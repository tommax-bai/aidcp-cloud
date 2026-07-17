import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { ActionCooldownGate } from '../../src/risk/action-cooldown.js';
import type { MandatoryInteractionContext } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'Tianxing Bai', role: 'người tìm việc', background: 'Tìm việc tại Việt Nam', tone: 'thân thiện' },
  interests: { primary: ['tuyển dụng'], secondary: [], seed_keywords: ['cần tuyển'] },
};
const mandatoryInteraction: MandatoryInteractionContext = {
  ruleId: 'vietnam-recruitment',
  actions: ['like', 'comment'],
  commentGuidance: 'Bình luận bằng tiếng Việt và hỏi về công việc.',
  commentApproval: 'auto_approve',
};
const now = 1_000_000;

function makeDispatcher(
  canInteract: () => boolean,
  explainInteract?: () => { allowed: boolean; reason?: string; retryAfterMs?: number },
): { dispatcher: RoleDispatcher; commands: EdgeCommand[] } {
  const commands: EdgeCommand[] = [];
  const cooldownGate = new ActionCooldownGate({ startedAtMs: 0, restartQuietMs: 0 });
  cooldownGate.markActed('acc-fb', 'like', now - 1_000);
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => '{"verdict":"skip","reason":"unused"}' },
    sendCommand: (command) => { commands.push(command); },
    canInteract,
    ...(explainInteract ? { explainInteract } : {}),
    cooldownGate,
    clock: () => now,
  });
  dispatcher.setCurrentAccountId('acc-fb');
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands };
}

describe('mandatory interaction dispatch safety', () => {
  it('mandatory like 绕过普通动作冷却并真实下发', () => {
    const { dispatcher, commands } = makeDispatcher(() => true);
    dispatcher.bus.emit('interaction.completed', {
      noteId: 'fb-job',
      sourcePageType: 'feed',
      actions: ['like'],
      mandatoryInteraction,
      ts: now,
    });

    const likes = commands.filter((command) => command.action === 'like');
    assert.equal(likes.length, 1);
    assert.equal(likes[0]?.params?.noteId, 'fb-job');
    dispatcher.endSession('test');
  });

  it('mandatory like+comment 先下发点赞，再进入评论钉页保护', async () => {
    const { dispatcher, commands } = makeDispatcher(() => true);
    dispatcher.updateNoteData({
      noteId: 'fb-job',
      title: 'Tuyển dụng công nhân',
      content: 'Công ty đang tuyển công nhân tại Hà Nam.',
      author: 'Việc Làm Hà Nam',
      likeCount: 0,
      collectCount: 0,
    });
    let commentAppraised = false;
    const logs: string[] = [];
    const originalLog = console.log;
    dispatcher.bus.on('comment.appraised', () => { commentAppraised = true; });
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      dispatcher.bus.emit('interaction.completed', {
        noteId: 'fb-job',
        sourcePageType: 'feed',
        actions: ['like'],
        mandatoryInteraction,
        ts: now,
      });

      const likes = commands.filter((command) => command.action === 'like');
      assert.equal(likes.length, 1, '同帖强制评论不得在当前同步事件内吞掉点赞命令');
      assert.equal(likes[0]?.params?.noteId, 'fb-job');
      assert.equal(commentAppraised, false, '评论钉页必须延后到当前 interaction.completed 分发结束后');

      await Promise.resolve();
      assert.equal(commentAppraised, true, '点赞已入队后应立即进入评论支线，不引入可见等待');
      dispatcher.bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: now });
      assert.ok(
        logs.some((line) => line.includes('command.suppressed reason=comment_inflight action=scroll')),
        '钉页期间被抑制的命令必须留下稳定 reason 日志',
      );
    } finally {
      console.log = originalLog;
      dispatcher.endSession('test');
    }
  });

  it('RiskController 硬闸拒绝时 mandatory like 仍诚实不下发', () => {
    const { dispatcher, commands } = makeDispatcher(() => false);
    dispatcher.updateNoteData({
      noteId: 'fb-job',
      title: 'Tuyển dụng công nhân',
      content: 'Công ty đang tuyển công nhân tại Hà Nam.',
      likeCount: 0,
      collectCount: 0,
    });
    dispatcher.bus.emit('interaction.completed', {
      noteId: 'fb-job',
      sourcePageType: 'feed',
      actions: ['like'],
      mandatoryInteraction,
      ts: now,
    });

    assert.equal(commands.some((command) => command.action === 'like'), false);
    dispatcher.endSession('test');
  });

  it('comment 预检拒绝时先发 mandatory like，但不进入评论生成/通知链', async () => {
    const { dispatcher, commands } = makeDispatcher(
      () => true,
      () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 30_000 }),
    );
    dispatcher.updateNoteData({
      noteId: 'fb-job',
      title: 'Tuyển dụng công nhân',
      content: 'Công ty đang tuyển công nhân tại Hà Nam.',
      author: 'Việc Làm Hà Nam',
      likeCount: 0,
      collectCount: 0,
    });
    const appraised: unknown[] = [];
    const skipped: { reason: string }[] = [];
    dispatcher.bus.on('comment.appraised', (payload) => { appraised.push(payload); });
    dispatcher.bus.on('comment.skipped', (payload) => { skipped.push(payload); });
    dispatcher.bus.emit('interaction.completed', {
      noteId: 'fb-job',
      sourcePageType: 'feed',
      actions: ['like'],
      mandatoryInteraction,
      ts: now,
    });
    assert.equal(commands.filter((command) => command.action === 'like').length, 1);
    await Promise.resolve();
    assert.equal(appraised.length, 0);
    assert.equal(skipped[0]?.reason, 'risk_preflight:quota:minute');
    assert.equal(commands.some((command) => command.action === 'comment'), false);
    dispatcher.endSession('test');
  });
});
