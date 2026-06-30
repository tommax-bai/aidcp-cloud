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
    cards?: Array<{ title?: string; author?: string; collectCount?: number; noteId?: string }>;
    detail?: { title?: string; content?: string };
    comments?: Array<{ author?: string; text: string; likeCount?: number }>;
    postOk?: boolean;
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
        bus.emit('page.cards.arrived', { cards: opts.cards ?? [], ts: Date.now() } as never);
      } else if (env.type === 'note.open') {
        const noteId = env.payload.noteId as string;
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
      } else if (env.type === 'note.scroll_comments') {
        bus.emit('action.completed', { action: 'scroll_comments', ok: true, candidates: opts.comments ?? [], ts: Date.now() } as never);
      } else if (env.type === 'interaction.comment') {
        bus.emit('action.completed', { action: 'comment', ok: opts.postOk ?? true, ts: Date.now() } as never);
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

  it('readNote：note.detail 超时 → null', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { silent: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup(), stepTimeoutMs: 40 });
    assert.equal(await steps.readNote({ index: 0, noteId: 'a', title: 'x' }), null);
  });

  it('post：真回执 ok:true → true', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.equal(await steps.post('a', '一条评论'), true);
  });

  it('post：回执 ok:false → false（不假成功）', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { postOk: false });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.equal(await steps.post('a', 'x'), false);
  });

  it('post：边端离线 → false', async () => {
    const bus = new EventBus();
    const { pusher } = makeEnv(bus, { offline: true });
    const steps = buildEdgeCommentSteps({ bus, pusher, edgeId: 'e1', dedup: makeDedup() });
    assert.equal(await steps.post('a', 'x'), false);
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
