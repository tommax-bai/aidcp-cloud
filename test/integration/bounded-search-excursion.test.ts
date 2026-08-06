/**
 * bounded-search-excursion —— 搜索行程「有界进入 + 正确页型 + 有界退出」。
 * #2：真正下发搜索后当前页型标为 search（被闸拦下的搜索不翻转，由代码结构保证——setSourcePageType 在通过两道闸之后）。
 * #3：搜索结果页累计浏览到阈值张不重复卡后回首页（复用 refresh 指令，reason=search_home_return）；空转（无可点内容）照样计卡、同样回首页。
 * 复用 feed-scroll-card-floor 的最小 harness（mock LLM 恒 skip → content.no_valuable → 翻页；search_evaluator 亦 skip）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '@automation/orchestrator/role-dispatcher.js';
import type { EdgeCommand, VisibleCard } from '@automation/orchestrator/role-dispatcher.js';
import { SessionContext } from '@automation/agents/session-context.js';
import { SEARCH_HOME_RETURN_AFTER } from '@automation/agents/search-scroller.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

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

let seq = 0;
function distinctCards(n: number): VisibleCard[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    title: `t${seq}`,
    author: 'u',
    likeCount: 0,
    collectCount: 0,
    noteId: `s${seq++}`,
  }));
}

const tick = () => new Promise((r) => setTimeout(r, 40));
const homeReturns = (cmds: EdgeCommand[]) =>
  cmds.filter((c) => c.action === 'refresh' && c.reason === 'search_home_return');

describe('bounded-search-excursion — SessionContext 搜索卡计数', () => {
  it('addSearchCardsBrowsed 累加、忽略非正数；resetSearchCardsBrowsed 归零并清差分基准', () => {
    const ctx = new SessionContext();
    assert.equal(ctx.searchCardsBrowsed, 0);
    ctx.addSearchCardsBrowsed(6);
    ctx.addSearchCardsBrowsed(4);
    assert.equal(ctx.searchCardsBrowsed, 10);
    ctx.addSearchCardsBrowsed(0);
    ctx.addSearchCardsBrowsed(-3);
    assert.equal(ctx.searchCardsBrowsed, 10, '非正数不改变计数');
    ctx.resetSearchCardsBrowsed();
    assert.equal(ctx.searchCardsBrowsed, 0);
  });

  it('searchBatchNewCount 只计不重复新卡，独立于 feed 差分基准', () => {
    const ctx = new SessionContext();
    assert.equal(ctx.searchBatchNewCount(['a', 'b']), 2);
    assert.equal(ctx.searchBatchNewCount(['a', 'b']), 0, '同一批 noteId 无新卡');
    assert.equal(ctx.searchBatchNewCount(['b', 'c']), 1, '只有 c 是新卡');
    // feed 差分基准不受搜索差分影响（互不污染）
    assert.equal(ctx.feedBatchNewCount(['a', 'b']), 2, 'feed 基准独立、a/b 对 feed 仍是新卡');
  });

  it('reset() 归零搜索卡计数与差分基准（per-excursion，重连即重置）', () => {
    const ctx = new SessionContext();
    ctx.addSearchCardsBrowsed(42);
    ctx.searchBatchNewCount(['x']);
    ctx.reset();
    assert.equal(ctx.searchCardsBrowsed, 0);
    assert.equal(ctx.searchBatchNewCount(['x']), 1, '差分基准已清、x 再次算新卡');
  });
});

describe('bounded-search-excursion — dispatcher 有界退出', () => {
  it('下发搜索后累计满阈值张搜索卡 → 回首页（refresh/search_home_return），未达阈值不回', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm: skipLlm(), sendCommand: (c) => commands.push(c) });
    dispatcher.setup();
    dispatcher.startSession();

    // 真正下发一次搜索：通过预算 + 限频两道闸 → 发 search 指令 + 页型标 search（#2）。
    dispatcher.bus.emit('search.approved', { keyword: 'foo', reason: 'test', currentPageType: 'feed', source: 'random_from_interests', ts: Date.now() });
    await tick();
    assert.ok(commands.some((c) => c.action === 'search' && c.params?.keyword === 'foo'), '应下发 search 指令');

    // 未达阈值：搜索页出 (阈值-1) 张不重复卡 → 不回首页。
    dispatcher.bus.emit('page.cards.arrived', { cards: distinctCards(SEARCH_HOME_RETURN_AFTER - 1), ts: Date.now() });
    await tick();
    assert.equal(homeReturns(commands).length, 0, '未达阈值不应回首页');

    // 跨批累计越过阈值：再出 2 张新卡 → 累计 = 阈值+1 → 回首页恰一次。
    dispatcher.bus.emit('page.cards.arrived', { cards: distinctCards(2), ts: Date.now() });
    await tick();
    assert.equal(homeReturns(commands).length, 1, '达阈值应回首页恰一次');
    assert.equal(homeReturns(commands)[0].params?.thinkMs !== undefined, true, '回首页指令带 thinkMs');

    dispatcher.endSession();
  });

  it('搜索页空转（一篇都点不开）照样累计卡数、同样在达阈值时回首页', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm: skipLlm(), sendCommand: (c) => commands.push(c) });
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('search.approved', { keyword: 'bar', reason: 'test', currentPageType: 'feed', ts: Date.now() });
    await tick();

    // mock LLM 恒 skip ⇒ 每批都 content.no_valuable（无 open_note）；卡数仍按不重复差分累计到阈值。
    let total = 0;
    while (total < SEARCH_HOME_RETURN_AFTER) {
      dispatcher.bus.emit('page.cards.arrived', { cards: distinctCards(3), ts: Date.now() });
      total += 3;
      await tick();
    }
    assert.equal(homeReturns(commands).length, 1, '空转也应在达阈值时回首页恰一次');

    dispatcher.endSession();
  });

  it('未下发搜索时（页型仍 feed）feed 卡不触发搜索回首页闸', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm: skipLlm(), sendCommand: (c) => commands.push(c) });
    dispatcher.setup();
    dispatcher.startSession();

    // 从未 search.approved ⇒ sourcePageType 仍 feed ⇒ 这些卡走 feed 深度路径，绝不触发 search_home_return。
    dispatcher.bus.emit('page.cards.arrived', { cards: distinctCards(SEARCH_HOME_RETURN_AFTER + 5), ts: Date.now() });
    await tick();
    assert.equal(homeReturns(commands).length, 0, 'feed 卡不应触发搜索回首页');

    dispatcher.endSession();
  });
});
