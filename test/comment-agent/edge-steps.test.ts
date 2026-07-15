/**
 * buildEdgeCommentSteps 单测（change comment-search-command，task 3.2 接真边端 + 去重）。
 * 用真 EventBus + 假 pusher（收到命令即模拟边端回相应上报）测往返；覆盖 honest 超时/离线、去重、记账。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { buildEdgeCommentSteps } from '../../src/comment-agent/edge-steps.js';
import type { CommentDedup } from '../../src/comment-agent/edge-steps.js';

interface Envelope {
  type: string;
  payload: Record<string, unknown>;
}

/** 假边端：pushToEdges 时按命令类型同步 emit 对应上报；可配是否「离线」、评论是否成功、是否静默（不回报=超时）。 */
function makeEnv(
  bus: EventBus,
  opts: {
    offline?: boolean;
    silent?: boolean; // 收到命令但不回报（测超时）
    searchFail?: { reason?: string }; // search.execute 回诚实失败 action.completed{search,ok:false}（未导航到结果页等）
    openFail?: { reason?: string }; // note.open 回诚实失败 action.completed{open_note,ok:false}（弹层不弹/抽取失败等）
    openReportsCards?: boolean; // note.open 后目标卡被回收 → 边端重报 page.cards（而非 note.detail）
    cards?: Array<{ title?: string; author?: string; collectCount?: number; noteId?: string }>;
    detail?: { title?: string; content?: string };
    comments?: Array<{ author?: string; text: string; likeCount?: number }>;
    scrollOk?: boolean; // scroll_comments 回执 ok（默认 true）；false 模拟采集失败（no_scroll/no_target）
    scrollReason?: string;
    postOk?: boolean;
    postReason?: string; // 7.6：comment 回执 reason（submitted_unconfirmed / preempted_by_task / …）
  },
) {
  const sentTypes: string[] = [];
  const pusher = {
    pushToEdges: (envelope: unknown, _edgeId?: string): number => {
      if (opts.offline) return 0;
      const env = envelope as Envelope;
      sentTypes.push(env.type);
      if (opts.silent) return 1;
      // 同步模拟边端上报（订阅已先建立）。
      if (env.type === 'search.execute') {
        if (opts.searchFail) {
          bus.emit('action.completed', { action: 'search', ok: false, reason: opts.searchFail.reason, ts: Date.now() } as never);
        } else {
          bus.emit('page.cards.arrived', { cards: opts.cards ?? [], ts: Date.now() } as never);
        }
      } else if (env.type === 'note.open') {
        const noteId = env.payload.noteId as string;
        if (opts.openFail) {
          bus.emit('action.completed', { action: 'open_note', ok: false, reason: opts.openFail.reason, ts: Date.now() } as never);
        } else if (opts.openReportsCards) {
          bus.emit('page.cards.arrived', { cards: opts.cards ?? [], ts: Date.now() } as never);
        } else {
          bus.emit('note.detail.arrived', {
            detail: {
              noteId,
              title: opts.detail?.title ?? '标题',
              content: opts.detail?.content ?? '正文',
              likeCount: 10,
              collectCount: 5,
            },
            ts: Date.now(),
          } as never);
        }
      } else if (env.type === 'note.scroll_comments') {
        bus.emit('action.completed', { action: 'scroll_comments', ok: opts.scrollOk ?? true, reason: opts.scrollReason, candidates: opts.comments ?? [], ts: Date.now() } as never);
      } else if (env.type === 'interaction.comment') {
        bus.emit('action.completed', { action: 'comment', ok: opts.postOk ?? true, reason: opts.postReason, ts: Date.now() } as never);
      }
      return 1;
    },
  };
  return { pusher, sentTypes };
}

function makeDedup(commented: Set<string> = new Set()): CommentDedup & { recorded: string[] } {
  const recorded: string[] = [];
  return {
    hasInteracted: async (noteId) => commented.has(noteId),
    recordInteraction: async (noteId) => {
      recorded.push(noteId);
      commented.add(noteId);
    },
    recorded,
  };
}

describe('buildEdgeCommentSteps', () => {
  it('searchAndHarvest：搜到卡片 → 仅取带 noteId 的、保序、index 重排', async () => {
    const bus = new EventBus();
    const { pusher, sentTypes } = makeEnv(bus, {
      cards: [
        { title: 'A', noteId: 'a', collectCount: 900 },
        { title: '无id', collectCount: 999 }, // 无 noteId → 丢
        { title: 'B', noteId: 'b', collectCount: 800 },
      ],
    });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), sort: 'most_collected', timeWindow: 'one_day' });
    const cards = await steps.searchAndHarvest('Agent');
    assert.equal(sentTypes[0], 'search.execute');
    assert.deepEqual(cards.map((c) => c.noteId), ['a', 'b']);
    assert.deepEqual(cards.map((c) => c.index), [0, 1]);
  });

  it('searchAndHarvest：边端离线（送达0）→ honest 空', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { offline: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.deepEqual(await steps.searchAndHarvest('x'), []);
  });

  it('searchAndHarvest：超时无上报 → honest 空', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { silent: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 40 });
    assert.deepEqual(await steps.searchAndHarvest('x'), []);
  });

  // change comment-search-nav-confirm：边端诚实回 search ok:false（未导航到结果页）→ 消费回执快速空候选，
  // 不干等满超时（消除 maxTerms×超时空转），且不冒充离线/无结果。
  it('searchAndHarvest：边端诚实回 search ok:false（not_on_search_page）→ 快速空候选、不等超时', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { searchFail: { reason: 'not_on_search_page' } });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 5000 });
    const t0 = Date.now();
    const cards = await steps.searchAndHarvest('x');
    const elapsed = Date.now() - t0;
    assert.deepEqual(cards, [], '诚实失败回执 → 空候选');
    assert.ok(elapsed < 1000, `应消费诚实回执快速失败、不干等 5s 超时（实际 ${elapsed}ms）`);
  });

  it('filterUncommented：滤掉已评过的、index 重排', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, {});
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(new Set(['b'])) });
    const fresh = await steps.filterUncommented([
      { index: 0, noteId: 'a', title: 'A' },
      { index: 1, noteId: 'b', title: 'B（已评）' },
      { index: 2, noteId: 'c', title: 'C' },
    ]);
    assert.deepEqual(fresh.map((c) => c.noteId), ['a', 'c']);
    assert.deepEqual(fresh.map((c) => c.index), [0, 1]);
  });

  it('readNote：开笔记 + 翻评论 → {note, comments}', async () => {
    const bus = new EventBus();
    const { pusher, sentTypes } = makeEnv(bus, {
      detail: { title: 'RAG 实战', content: '正文' },
      comments: [{ text: '学到了', likeCount: 3 }, { text: '求教程' }],
    });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    const r = await steps.readNote({ index: 0, noteId: 'a', title: 'RAG 实战' });
    assert.ok(r);
    assert.equal(r!.note.noteId, 'a');
    assert.equal(r!.note.title, 'RAG 实战');
    assert.deepEqual(r!.comments.map((c) => c.text), ['学到了', '求教程']);
    assert.deepEqual(sentTypes, ['note.open', 'note.scroll_comments']);
  });

  // change fix-interaction-and-comment-capture：采集失败(ok:false)但边端仍带回可见候选时，撰写仍拿到现场评论
  // （区分「采集失败」与「真无评论」，不把失败静默抹平成无评论）。
  it('readNote：scroll_comments ok:false 但带回候选 → comments 仍填充（不抹平失败）', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, {
      detail: { title: 'x', content: '正文' },
      scrollOk: false,
      scrollReason: 'no_scroll',
      comments: [{ text: '短评论区也采到了', likeCount: 1 }],
    });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    const r = await steps.readNote({ index: 0, noteId: 'a', title: 'x' });
    assert.ok(r);
    assert.deepEqual(r!.comments.map((c) => c.text), ['短评论区也采到了'], 'ok:false 也应带回边端可见候选');
  });

  it('readNote：note.detail 超时 → null', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { silent: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 40 });
    assert.equal(await steps.readNote({ index: 0, noteId: 'a', title: 'x' }), null);
  });

  // change comment-readnote-fastfail：开笔记失败边端诚实回 action.completed{open_note,ok:false}（弹层不弹等）→
  // 云端竞速消费、立即 null，不干等满单步超时（不再 28s 空等 + 不冒充离线）。
  it('readNote：边端诚实回 open_note ok:false → 立即 null、不等超时', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { openFail: { reason: 'modal_timeout' } });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 5000 });
    const t0 = Date.now();
    const r = await steps.readNote({ index: 0, noteId: 'a', title: 'x' });
    const elapsed = Date.now() - t0;
    assert.equal(r, null, '开笔记诚实失败 → null');
    assert.ok(elapsed < 1000, `应消费 open_note ok:false 快速失败、不干等 5s 超时（实际 ${elapsed}ms）`);
  });

  // change comment-readnote-fastfail：目标卡被虚拟列表回收、边端重报 page.cards（而非目标 note.detail）→
  // 云端竞速消费、立即 null，不干等满单步超时。
  it('readNote：目标卡被回收、边端重报 page.cards → 立即 null、不等超时', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { openReportsCards: true, cards: [{ noteId: 'z', title: '别的卡' }] });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 5000 });
    const t0 = Date.now();
    const r = await steps.readNote({ index: 0, noteId: 'a', title: 'x' });
    const elapsed = Date.now() - t0;
    assert.equal(r, null, '重报卡片（目标不在当前页）→ null');
    assert.ok(elapsed < 1000, `应消费重报 page.cards 快速失败、不干等 5s 超时（实际 ${elapsed}ms）`);
  });

  it('post：真回执 ok:true → confirmed', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.deepEqual(await steps.post('a', '一条评论'), { status: 'confirmed' });
  });

  it('post：回执 ok:false 无 reason → not_dispatched（提交前失败，可重排）', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: false });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.deepEqual(await steps.post('a', 'x'), { status: 'not_dispatched', reason: undefined });
  });

  it('post：边端离线（超时无回报）→ not_dispatched', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { offline: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.equal((await steps.post('a', 'x')).status, 'not_dispatched');
  });

  it('7.6 post：ok:false + reason=submitted_unconfirmed → submitted_unconfirmed（可能已发出，上游写去重不重投）', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: false, postReason: 'submitted_unconfirmed' });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.deepEqual(await steps.post('a', 'x'), { status: 'submitted_unconfirmed' });
  });

  it('7.6 post：ok:false + reason=preempted_by_task → preempted（提交前被抢占，放弃本轮不写去重）', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: false, postReason: 'preempted_by_task' });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.deepEqual(await steps.post('a', 'x'), { status: 'preempted', reason: 'preempted_by_task' });
  });

  it('recordCommented：记一笔到 dedup', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, {});
    const dedup = makeDedup();
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup });
    await steps.recordCommented('a');
    assert.deepEqual(dedup.recorded, ['a']);
  });
});
