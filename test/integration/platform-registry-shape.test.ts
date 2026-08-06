/**
 * change platform-registry-shape (C1a) — 平台能力静态表驱动编排的可测场景。
 *
 * 验证（不改协议、不改 edge）：
 *  1) note-scoped 能力闸：Facebook collect 在唯一拒绝点被拒（不下发），like 照常下发——不靠数值巧合。
 *  2) 深读短路（fail-open + 诚实）：Facebook 不支持 browse_images/scroll_comments ⇒ 不下发这两类命令，
 *     且 reading.images_done 诚实回 imagesBrowsed:0 + reason。
 *  3) 循环闭合读静态表：小红书恒 back，与 page.cards 是否穿插到 note.detail 与 feed.entered 之间无关。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '@automation/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import type { PlatformId } from '@automation/platform/index.js';
import { EventBus } from '@automation/event-bus/index.js';
import type { ReadingImagesDonePayload } from '@automation/event-bus/types.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'skip' };

function setup(accountPlatform: PlatformId | undefined) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract: () => true,
    accountPlatform,
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
  });
  d.setup();
  d.startSession();
  return { bus, commands, d };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);

describe('platform-registry-shape: note-scoped capability gate', () => {
  it('facebook: collect refused at the single gate, like still dispatched', () => {
    const { bus, commands } = setup('facebook');
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    assert.ok(actionsOf(commands).includes('like'), 'facebook like 应照常下发');
    assert.ok(!actionsOf(commands).includes('collect'), 'facebook collect 应在唯一拒绝点被拒（不靠数值巧合）');
  });

  it('xhs: both like and collect dispatched (no regression)', () => {
    const { bus, commands } = setup('xiaohongshu');
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    assert.ok(actionsOf(commands).includes('like'), 'xhs like 应下发');
    assert.ok(actionsOf(commands).includes('collect'), 'xhs collect 应下发（零回归）');
  });
});

describe('platform-registry-shape: deep-read short-circuit (fail-open + honest)', () => {
  it('facebook: browse_images/scroll_comments not dispatched; reading.images_done honest', () => {
    const { bus, commands } = setup('facebook');
    const imagesDone: ReadingImagesDonePayload[] = [];
    bus.on('reading.images_done', (p) => {
      imagesDone.push(p);
    });

    bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 0 });

    assert.ok(!actionsOf(commands).includes('browse_images'), 'FB 不支持看图 ⇒ 不下发 browse_images');
    assert.ok(!actionsOf(commands).includes('scroll_comments'), 'FB 不支持滚评论 ⇒ 不下发 scroll_comments');
    assert.equal(imagesDone.length, 1, 'DeepReader 应诚实推进 reading.images_done');
    assert.equal(imagesDone[0].imagesBrowsed, 0, '未看图 ⇒ imagesBrowsed:0（不伪造）');
    assert.equal(imagesDone[0].reason, 'surface_unsupported', '带诚实 reason');
  });

  it('missing platform (fail-open wiring): deep-read command IS still dispatched', () => {
    // 锁死能力闸 fail-open 的**接线层**默认：closure 若被误反相成 `!!accountPlatform && supported`，
    // accountPlatform 缺失时会返回 false 而静默砍掉深读——本例把它钉住（纯 resolver 的 fail-open 已在
    // platform-surface.test.ts 覆盖）。random()=0 让 DeepReader 确定性决定翻图。
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { bus, commands } = setup(undefined);
      bus.emit('quality.pass', { noteId: 'n1', sourcePageType: 'feed', reason: 'ok', ts: 0 });
      assert.ok(
        actionsOf(commands).includes('browse_images'),
        'accountPlatform 缺失 ⇒ 能力闸 fail-open ⇒ browse_images 照常下发（防 closure 反相回归）',
      );
    } finally {
      Math.random = origRandom;
    }
  });
});

describe('platform-registry-shape: loop closure reads static table (order-independent)', () => {
  it('xhs: back_to_feed ⇒ back, and interleaved page.cards does not flip it to scroll', () => {
    const { bus, commands } = setup('xiaohongshu');

    // page.cards.arrived 穿插到 feed.entered 之前也不改闭合决策（闭合读静态表、不读运行时回声）。
    bus.emit('page.cards.arrived', { cards: [], ts: 0 });
    bus.emit('feed.entered', { trigger: 'back_to_feed', pageType: 'feed', ts: 0 });

    // 闭合决策靠 reason 隔离：back 的 reason=back_to_feed；若被误翻成就地续刷则 scroll 的 reason=feed_inline_continue。
    //（空 page.cards.arrived 自身会触发一个「取更多」scroll，与闭合无关，故不能只看 action 是否含 scroll。）
    assert.ok(
      commands.some((c) => c.action === 'back' && c.reason === 'back_to_feed'),
      '小红书循环闭合应发 back（reason=back_to_feed）',
    );
    assert.ok(
      !commands.some((c) => c.reason === 'feed_inline_continue'),
      '闭合不应因就地读被翻成 scroll（read=detail ⇒ 恒 back，与 page.cards 穿插无关）',
    );
  });
});
