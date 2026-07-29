/**
 * change generalize-facebook-content-derived-post-identity — 身份分档的准入边界（云端侧）。
 *
 * 内容派生的会话内引用没有平台地址：导航 / 打开详情 / 定向评论**结构性做不到**。
 * 这里守的是「云端绝不把明知做不到的命令发出去」这条红线——边缘拒绝只是最后一道保险，
 * 发出去本身就是一次假动作。同时守住反面：就地读、就地赞必须照常放行，否则浏览本身被掐死。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Surface } from '../../src/platform/index.js';
import { PLATFORM_REGISTRY } from '../../src/platform/registry.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'skip' };

/** 群组帖的会话内引用：前缀是历史命名，语义是「内容派生的会话内帖子引用」。 */
const CONTENT_REF = `aidcp:facebook-group-feed-post:v1:${'a1'.repeat(32)}`;
const PERMALINK = 'https://www.facebook.com/Alice/posts/pfbid1';

function setup(opts?: { inlineTargeting?: boolean }) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract: () => true,
    accountPlatform: 'facebook',
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
    ...(opts?.inlineTargeting ? { hasInlineTargeting: () => true } : {}),
  });
  d.setup();
  d.startSession();
  return { bus, commands };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);

function reportCard(bus: EventBus, noteId: string, noteIdKind?: 'permalink' | 'content_ref'): void {
  bus.emit('page.cards.arrived', {
    cards: [{
      index: 0,
      title: '一条群组帖',
      likeCount: 3,
      collectCount: 0,
      noteId,
      ...(noteIdKind ? { noteIdKind } : {}),
    }],
    listKind: 'feed',
    ts: 0,
  });
}

describe('会话内引用的命令准入分档', () => {
  // 迁移路径（评论前先导航）只在 read≠comment surface 时结构性可达；与既有迁移用例同样临时翻 registry。
  let originalReadSurface: Surface;
  beforeEach(() => {
    originalReadSurface = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = originalReadSurface;
  });

  it('红线：对会话内引用绝不下发导航 / 定向评论类命令', () => {
    const { bus, commands } = setup({ inlineTargeting: true });
    reportCard(bus, CONTENT_REF, 'content_ref');
    const base = commands.length;

    bus.emit('comment.approved', { noteId: CONTENT_REF, sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });

    const after = commands.slice(base);
    assert.ok(
      !after.some((c) => c.action === 'open_note' && c.params?.purpose === 'navigate'),
      '会话内引用没有平台地址 ⇒ MUST NOT 下发导航类 open_note',
    );
    assert.ok(!actionsOf(after).includes('comment'), '会话内引用 MUST NOT 被定向评论');
  });

  it('分档缺省（老边端）时逐位等于今天：同一条帖子照常走导航迁移', () => {
    const { bus, commands } = setup({ inlineTargeting: true });
    reportCard(bus, PERMALINK); // 不带 noteIdKind ⇒ 缺省即平台链接
    const base = commands.length;

    bus.emit('comment.approved', { noteId: PERMALINK, sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });

    const after = commands.slice(base);
    assert.deepEqual(actionsOf(after), ['open_note'], '缺分档 ⇒ 与今天一样先发导航第一步');
    assert.equal(after[0]!.params?.purpose, 'navigate');
  });

  it('就地读必须放行：会话内引用的卡照常发 open_note{surface:feed}，浏览不被掐死', () => {
    const { bus, commands } = setup({ inlineTargeting: true });
    reportCard(bus, CONTENT_REF, 'content_ref');
    const base = commands.length;

    bus.emit('content.valuable', {
      index: 0,
      noteId: CONTENT_REF,
      title: '一条群组帖',
      confidence: 0.9,
      reason: 'interesting',
      sourcePageType: 'feed',
      ts: 0,
    });

    const after = commands.slice(base);
    assert.deepEqual(actionsOf(after), ['open_note']);
    assert.equal(after[0]!.params?.surface, 'feed', '就地读不跳转、不需要地址 ⇒ 放行');
    assert.equal(after[0]!.params?.purpose, undefined);
  });

  it('同一条引用换成打开详情（非 feed 面）则被扣住——那一步真的需要地址', () => {
    const { bus, commands } = setup(); // 未声明 inline_targeting ⇒ 读回落详情页，需要真地址
    reportCard(bus, CONTENT_REF, 'content_ref');
    const base = commands.length;

    bus.emit('content.valuable', {
      index: 0,
      noteId: CONTENT_REF,
      title: '一条群组帖',
      confidence: 0.9,
      reason: 'interesting',
      sourcePageType: 'feed',
      ts: 0,
    });

    assert.deepEqual(actionsOf(commands.slice(base)), [], '打开详情要跳转 ⇒ 不下发，诚实不动手');
  });
});
