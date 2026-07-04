/**
 * CommentScheduler.triggerTargeted 单测（change curated-note-actions：定向评论触发）。
 * 覆盖：各拒绝路径（账号/坏目标/人设/群码 fail-closed/单飞/去重前置/边端离线）带机器原因码、
 * happy path 端到端（搜索用综合排序+不限时间窗、搜索词截断 ≤20 字、接管/恢复成对、
 * 结果卡片可辨识定向来源、发布成功后记账）、targetedOutcomeToReceipt 绝不染绿。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import {
  CommentScheduler,
  targetedOutcomeToReceipt,
  TARGETED_SEARCH_TERM_MAX_LEN,
} from '../../src/comment-agent/comment-scheduler.js';
import type { CommentSchedulerDeps } from '../../src/comment-agent/comment-scheduler.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: 'x', tone: '理性' },
  interests: { primary: ['LLM Agent', 'RAG'], secondary: ['推理优化'], seed_keywords: ['vLLM'] },
};

interface Envelope { type: string; payload: Record<string, unknown>; }

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 假边端：记录所有下发 envelope；搜索回含目标 noteId 的卡片，后续步骤全成功。 */
function fakeEdge(bus: EventBus, targetNoteId: string) {
  const pushed: Envelope[] = [];
  return {
    pushed,
    pusher: {
      pushToEdges: (envelope: unknown): number => {
        const env = envelope as Envelope;
        pushed.push(env);
        if (env.type === 'search.execute') {
          bus.emit('page.cards.arrived', { cards: [{ index: 0, title: '目标笔记', noteId: targetNoteId, collectCount: 10 }], ts: 0 } as never);
        } else if (env.type === 'note.open') {
          bus.emit('note.detail.arrived', { detail: { noteId: targetNoteId, title: '目标笔记', content: '正文', likeCount: 10, collectCount: 9 }, ts: 0 } as never);
        } else if (env.type === 'note.scroll_comments') {
          bus.emit('action.completed', { action: 'scroll_comments', ok: true, candidates: [{ text: '学到了' }], ts: 0 } as never);
        } else if (env.type === 'interaction.comment') {
          bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
        }
        return 1;
      },
    },
  };
}

function fakeLlm() {
  return {
    complete: async (_p: string, opts?: { role?: string }): Promise<string> =>
      opts?.role === 'browse:comment_composer' ? '{"text":"这篇讲得很实在"}' : '{}',
  };
}

function baseDeps(over: Partial<CommentSchedulerDeps> = {}): CommentSchedulerDeps {
  const bus = new EventBus();
  return {
    resolveConnection: () => ({ bus, edgeId: 'e1' }),
    pusher: fakeEdge(bus, 'note-1').pusher,
    getSoul: () => soul,
    selectCurated: async () => [],
    llmFor: () => fakeLlm(),
    dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async () => {} }),
    approval: { request: async () => {}, isApproved: async () => true },
    onTakeoverStart: () => {},
    onTakeoverEnd: () => {},
    logger: { log: () => {}, warn: () => {} },
    ...over,
  };
}

const target = { noteId: 'note-1', title: '目标笔记标题' };

describe('CommentScheduler.triggerTargeted 拒绝路径（机器原因码）', () => {
  it('account=default → error / account_required', async () => {
    const s = new CommentScheduler(baseDeps());
    const r = await s.triggerTargeted('default', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'account_required');
  });

  it('目标缺标题 → warning / bad_target', async () => {
    const s = new CommentScheduler(baseDeps());
    const r = await s.triggerTargeted('acc-1', { noteId: 'n', title: '  ' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_target');
  });

  it('未绑人设 → warning / needs_persona，不接管边端', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(baseDeps({ isPersonaBound: () => false, onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerTargeted('acc-1', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'needs_persona');
    assert.equal(takeovers, 0);
  });

  it('带群但账号无群码 → warning / group_code_missing（fail-closed，绝不降级为内容评论）', async () => {
    const s = new CommentScheduler(baseDeps({ getGroupChatInfo: async () => null }));
    const r = await s.triggerTargeted('acc-1', target, { injectGroup: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'group_code_missing');
  });

  it('去重前置：已评过该笔记 → warning / already_commented，不接管边端', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({
        dedupFor: () => ({ hasInteracted: async () => true, recordInteraction: async () => {} }),
        onTakeoverStart: () => { takeovers += 1; },
      }),
    );
    const r = await s.triggerTargeted('acc-1', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already_commented');
    assert.equal(takeovers, 0);
  });

  it('边端离线 → error / edge_offline', async () => {
    const s = new CommentScheduler(baseDeps({ resolveConnection: () => null }));
    const r = await s.triggerTargeted('acc-1', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'edge_offline');
  });

  it('并发双触发（同账号）→ 恰一个 ok:true，单飞闸原子（回归：dedup await 不得切开 has→add）', async () => {
    // dedup 查询用一个延迟 promise 模拟真实 PG 往返，制造 has→add 之间的可插入窗口。
    const bus = new EventBus();
    let takeoverStarts = 0;
    const cardDones: Array<() => void> = [];
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: { pushToEdges: () => 1 }, // 边端不回上报 → 任务在步超时前挂着，保住在跑窗口
        stepTimeoutMs: 300,
        dedupFor: () => ({
          hasInteracted: async () => {
            await new Promise((r) => setImmediate(r)); // 模拟 PG 往返：给并发触发插入机会
            return false;
          },
          recordInteraction: async () => {},
        }),
        onTakeoverStart: () => { takeoverStarts += 1; },
        postResultCard: () => { cardDones.shift()?.(); },
      }),
    );
    const done = new Promise<void>((r) => { cardDones.push(r); });
    const [a, b] = await Promise.all([s.triggerTargeted('acc-1', target), s.triggerTargeted('acc-1', target)]);
    const oks = [a, b].filter((r) => r.ok);
    assert.equal(oks.length, 1, '并发双触发必须恰有一个成功、一个被单飞闸拒');
    const rejected = [a, b].find((r) => !r.ok)!;
    assert.equal(rejected.reason, 'running');
    assert.equal(takeoverStarts, 1, '只接管一次边端（不双接管同一账号）');
    await done; // 等唯一在跑任务收尾，防悬挂
  });

  it('同账号已有任务在跑 → warning / running（单飞）', async () => {
    // 边端不回任何上报 + 极短步超时：第一单很快失败，但在其在跑窗口内第二单必须被拒。
    const bus = new EventBus();
    const cardDone = deferred();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: { pushToEdges: () => 1 },
        stepTimeoutMs: 200,
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    const first = await s.triggerTargeted('acc-1', target);
    assert.equal(first.ok, true);
    const second = await s.triggerTargeted('acc-1', target);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'running');
    await cardDone.promise; // 等第一单收尾，防测试尾部悬挂
  });
});

describe('CommentScheduler.triggerTargeted happy path', () => {
  it('端到端：综合排序+不限时间窗、搜索词截断、接管/恢复成对、结果卡定向可辨识、记账', async () => {
    const bus = new EventBus();
    const edge = fakeEdge(bus, 'note-1');
    const takeovers: string[] = [];
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string; title: string }>();
    const longTitle = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯'; // 24 字 > 20 上限
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: edge.pusher,
        dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (noteId) => { recorded.push(noteId); } }),
        onTakeoverStart: (a) => takeovers.push(`start:${a}`),
        onTakeoverEnd: (a) => takeovers.push(`end:${a}`),
        postResultCard: (_a, receipt) => { cardDone.resolve(receipt); },
      }),
    );
    const r = await s.triggerTargeted('acc-1', { noteId: 'note-1', title: longTitle });
    assert.equal(r.ok, true);
    assert.equal(r.level, 'success');

    const receipt = await cardDone.promise;
    assert.equal(receipt.ok, true);
    assert.equal(receipt.level, 'success');
    assert.match(receipt.title, /定向内容评论/); // 卡面可辨识定向来源

    const search = edge.pushed.find((e) => e.type === 'search.execute');
    assert.ok(search, '应下发 search.execute');
    assert.equal(search.payload.sort, 'comprehensive'); // 不沿用 /comment 的 most_collected
    assert.equal(search.payload.timeWindow, 'all'); // 不沿用 one_day（老笔记须可检索）
    assert.equal((search.payload.keyword as string).length, TARGETED_SEARCH_TERM_MAX_LEN);
    assert.equal(search.payload.keyword, longTitle.slice(0, TARGETED_SEARCH_TERM_MAX_LEN));

    const comment = edge.pushed.find((e) => e.type === 'interaction.comment');
    assert.ok(comment, '应下发 interaction.comment');
    assert.equal(comment.payload.noteId, 'note-1');

    assert.deepEqual(takeovers, ['start:acc-1', 'end:acc-1']); // 接管/恢复成对
    assert.deepEqual(recorded, ['note-1']); // 发布成功后记账
    await new Promise((r) => setImmediate(r)); // running 标志在任务 promise 的 finally 清，等一拍
    assert.equal(s.isRunning('acc-1'), false);
  });

  it('带群：群码走 compose 注入路径，结果卡标「定向带群评论」', async () => {
    const bus = new EventBus();
    const edge = fakeEdge(bus, 'note-1');
    const cardDone = deferred<{ ok: boolean; title: string }>();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: edge.pusher,
        getGroupChatInfo: async () => 'GROUP-CODE',
        postResultCard: (_a, receipt) => { cardDone.resolve(receipt); },
      }),
    );
    const r = await s.triggerTargeted('acc-1', target, { injectGroup: true });
    assert.equal(r.ok, true);
    const receipt = await cardDone.promise;
    assert.equal(receipt.ok, true);
    assert.match(receipt.title, /定向带群评论/);
    const comment = edge.pushed.find((e) => e.type === 'interaction.comment');
    assert.ok(comment);
    assert.equal(comment.payload.groupChatCode, 'GROUP-CODE'); // 码整段注入（边端 insertText）
  });
});

describe('targetedOutcomeToReceipt（绝不染绿）', () => {
  it('commented → 绿；note_not_found/compose_skipped → 黄；read_failed/post_failed → 红', () => {
    assert.equal(targetedOutcomeToReceipt({ outcome: 'commented', noteId: 'n', searchAttempts: 1 }, false).level, 'success');
    const nf = targetedOutcomeToReceipt({ outcome: 'note_not_found', noteId: 'n', searchAttempts: 2 }, false);
    assert.equal(nf.level, 'warning');
    assert.equal(nf.ok, false);
    assert.match(nf.message, /绝不评「相似」笔记/);
    assert.equal(targetedOutcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n', searchAttempts: 1 }, false).level, 'warning');
    assert.equal(targetedOutcomeToReceipt({ outcome: 'read_failed', noteId: 'n', searchAttempts: 1 }, false).level, 'error');
    assert.equal(targetedOutcomeToReceipt({ outcome: 'post_failed', noteId: 'n', searchAttempts: 1 }, false).level, 'error');
  });
});
