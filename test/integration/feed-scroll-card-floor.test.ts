/**
 * Integration: feed-scroll-card-floor —— feed 翻页按新卡数下发停留兜底。
 * 验证：出新卡的 feed_scroll 携带 dwellMs>0；返回未刷新（同一批 noteId）的 feed_scroll 不带 dwellMs。
 * 复用 role-dispatcher.test 的最小 harness（mock LLM 恒返回 skip → content.no_valuable → feed.scrolled）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand, VisibleCard } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};

function skipLlm() {
  return {
    complete: async (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve('{"verdict":"skip","reason":"不相关"}'), 5)),
  };
}

function card(noteId: string, index: number): VisibleCard {
  return { index, title: `t${index}`, author: 'u', likeCount: 0, collectCount: 0, noteId };
}

const tick = () => new Promise((r) => setTimeout(r, 40));

function lastFeedScroll(commands: EdgeCommand[]): EdgeCommand | undefined {
  return [...commands].reverse().find((c) => c.action === 'scroll' && c.reason === 'feed_scroll');
}

describe('feed-scroll-card-floor', () => {
  it('出新卡 → feed_scroll 携带 dwellMs>0（按新卡数）', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm: skipLlm(), sendCommand: (c) => commands.push(c) });
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('page.cards.arrived', { cards: [card('n1', 0), card('n2', 1), card('n3', 2)], ts: Date.now() });
    await tick();

    const scroll = lastFeedScroll(commands);
    assert.ok(scroll, '应产生一次 feed_scroll');
    assert.ok(typeof scroll!.params?.dwellMs === 'number' && (scroll!.params!.dwellMs as number) > 0,
      `出新卡的 feed_scroll 应带 dwellMs>0，实得 ${JSON.stringify(scroll!.params)}`);
    dispatcher.endSession();
  });

  it('返回未刷新（同一批 noteId）→ feed_scroll 不带 dwellMs', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm: skipLlm(), sendCommand: (c) => commands.push(c) });
    dispatcher.setup();
    dispatcher.startSession();

    // 第一批：新卡 → 带 dwellMs
    dispatcher.bus.emit('page.cards.arrived', { cards: [card('n1', 0), card('n2', 1)], ts: Date.now() });
    await tick();
    const first = lastFeedScroll(commands);
    assert.ok((first?.params?.dwellMs as number) > 0, '第一批新卡应带 dwellMs');

    const beforeSecond = commands.length;
    // 第二批：同一批 noteId（返回未刷新）→ 0 新卡 → 不带 dwellMs
    dispatcher.bus.emit('page.cards.arrived', { cards: [card('n1', 0), card('n2', 1)], ts: Date.now() });
    await tick();
    const second = commands.slice(beforeSecond).reverse().find((c) => c.action === 'scroll' && c.reason === 'feed_scroll');
    assert.ok(second, '第二次也应产生 feed_scroll');
    assert.equal(second!.params?.dwellMs, undefined, `返回未刷新的 feed_scroll 不应带 dwellMs，实得 ${JSON.stringify(second!.params)}`);
    dispatcher.endSession();
  });
});
