/**
 * CommentScheduler.triggerTargeted 单测（change curated-note-actions：定向评论触发）。
 * 覆盖：各拒绝路径（账号/坏目标/人设/联系方式 fail-closed/单飞/去重前置/边端离线）带机器原因码、
 * happy path 端到端（搜索用综合排序+不限时间窗、搜索词截断 ≤20 字、接管/恢复成对、
 * 结果卡片可辨识定向来源、发布成功后记账）、targetedOutcomeToReceipt 绝不染绿。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '@automation/event-bus/index.js';
import {
  CommentScheduler,
  targetedOutcomeToReceipt,
  TARGETED_SEARCH_TERM_MAX_LEN,
} from '@automation/comment-agent/comment-scheduler.js';
import type { CommentSchedulerDeps } from '@automation/comment-agent/comment-scheduler.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

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
        if (env.type === 'xiaohongshu.search.execute') {
          bus.emit('page.cards.arrived', { cards: [{ index: 0, title: '目标笔记', noteId: targetNoteId, collectCount: 10 }], ts: 0 } as never);
        } else if (env.type === 'xiaohongshu.note.open') {
          bus.emit('note.detail.arrived', { detail: { noteId: targetNoteId, title: '目标笔记', content: '正文', likeCount: 10, collectCount: 9 }, ts: 0 } as never);
        } else if (env.type === 'xiaohongshu.note.scroll_comments') {
          bus.emit('action.completed', { action: 'scroll_comments', ok: true, candidates: [{ text: '学到了' }], ts: 0 } as never);
        } else if (env.type === 'xiaohongshu.note.comment') {
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
    edgeTaskLeases: {
      withLease: async (request, work) => work({ taskId: `task-${request.kind}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority }),
    },
    getSoul: () => soul,
    curatedSelection: { selectSamplesForSearchTerms: async () => [] },
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
    const s = new CommentScheduler(baseDeps({ personaBinding: () => 'unbound', onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerTargeted('acc-1', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'needs_persona');
    assert.equal(takeovers, 0);
  });

  it('带联系方式但账号无联系方式 → warning / contact_info_missing（fail-closed，绝不降级为内容评论）', async () => {
    const s = new CommentScheduler(baseDeps({ getContactInfo: async () => null }));
    const r = await s.triggerTargeted('acc-1', target, { injectContact: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'contact_info_missing');
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

  it('facebook 定向评论执行未接入 → error / unsupported_platform，绝不回落 xhs 流程（facebook-scheduled-comment 2.2 待实装）', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({
        getPlatform: () => 'facebook',
        onTakeoverStart: () => { takeovers += 1; },
      }),
    );
    const r = await s.triggerTargeted('acc-1', target);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unsupported_platform');
    assert.match(r.message, /Facebook 定向评论执行尚未接入|待实装/);
    assert.equal(takeovers, 0, '绝不回落 xhs 流程');
  });

  it('并发双触发（同账号）→ 恰一个 ok:true，单飞闸原子（回归：dedup await 不得切开 has→add）', async () => {
    // dedup 查询用一个延迟 promise 模拟真实 PG 往返，制造 has→add 之间的可插入窗口。
    const bus = new EventBus();
    let leaseStarts = 0;
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
        edgeTaskLeases: {
          withLease: async (request, work) => {
            leaseStarts += 1;
            return work({ taskId: `task-${request.kind}-${leaseStarts}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority });
          },
        },
        postResultCard: () => { cardDones.shift()?.(); },
      }),
    );
    const done = new Promise<void>((r) => { cardDones.push(r); });
    const [a, b] = await Promise.all([s.triggerTargeted('acc-1', target), s.triggerTargeted('acc-1', target)]);
    const oks = [a, b].filter((r) => r.ok);
    assert.equal(oks.length, 1, '并发双触发必须恰有一个成功、一个被单飞闸拒');
    const rejected = [a, b].find((r) => !r.ok)!;
    assert.equal(rejected.reason, 'running');
    assert.equal(leaseStarts, 1, '只启动唯一任务的 prepare 租约（不双驱动同一账号）');
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
    const leaseKinds: string[] = [];
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string; title: string; message: string }>();
    const longTitle = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯'; // 24 字 > 20 上限
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: edge.pusher,
        dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (noteId) => { recorded.push(noteId); } }),
        edgeTaskLeases: {
          withLease: async (request, work) => {
            leaseKinds.push(request.kind);
            return work({ taskId: `task-${request.kind}-${leaseKinds.length}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority });
          },
        },
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
    assert.match(receipt.message, /目标笔记《目标笔记》/);
    assert.doesNotMatch(receipt.message, /note-1/);

    const search = edge.pushed.find((e) => e.type === 'xiaohongshu.search.execute');
    assert.ok(search, '应下发 search.execute');
    assert.equal(search.payload.sort, undefined); // 定向搜索不驱动原生筛选面板
    assert.equal(search.payload.timeWindow, undefined); // 不沿用 /comment 的 one_day
    assert.equal((search.payload.keyword as string).length, TARGETED_SEARCH_TERM_MAX_LEN);
    assert.equal(search.payload.keyword, longTitle.slice(0, TARGETED_SEARCH_TERM_MAX_LEN));

    const comment = edge.pushed.find((e) => e.type === 'xiaohongshu.note.comment');
    assert.ok(comment, '应下发 xiaohongshu.note.comment');
    assert.equal(comment.payload.noteId, 'note-1');

    assert.deepEqual(leaseKinds, ['comment_prepare', 'comment_commit']);
    assert.deepEqual(recorded, ['note-1']); // 发布成功后记账
    await new Promise((r) => setImmediate(r)); // running 标志在任务 promise 的 finally 清，等一拍
    assert.equal(s.isRunning('acc-1'), false);
  });

  it('带联系方式：联系方式走 compose 注入路径，结果卡标「定向联系评论」', async () => {
    const bus = new EventBus();
    const edge = fakeEdge(bus, 'note-1');
    const cardDone = deferred<{ ok: boolean; title: string }>();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: edge.pusher,
        getContactInfo: async () => 'GROUP-CODE',
        postResultCard: (_a, receipt) => { cardDone.resolve(receipt); },
      }),
    );
    const r = await s.triggerTargeted('acc-1', target, { injectContact: true });
    assert.equal(r.ok, true);
    const receipt = await cardDone.promise;
    assert.equal(receipt.ok, true);
    assert.match(receipt.title, /定向联系评论/);
    const comment = edge.pushed.find((e) => e.type === 'xiaohongshu.note.comment');
    assert.ok(comment);
    assert.equal(comment.payload.groupChatCode, 'GROUP-CODE'); // 线协议字段名仍为 groupChatCode；联系方式整段注入（边端 insertText）
  });

  it('当前笔记触发：prepare 复用 currentNote，commit 重新搜索/开笔记复检，最终为 commented', async () => {
    const bus = new EventBus();
    const edge = fakeEdge(bus, 'note-1');
    const cardDone = deferred<{ ok: boolean; message: string }>();
    const finalOutcomes: string[] = [];
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: edge.pusher,
        postResultCard: (_a, receipt) => { cardDone.resolve(receipt); },
      }),
    );
    const r = await s.triggerTargeted(
      'acc-1',
      target,
      {
        currentNote: { noteId: 'note-1', title: '当前笔记标题', content: '当前正文', likeCount: 3522, collectCount: 2367 },
        onResult: (result) => { finalOutcomes.push(result.outcome); },
      },
    );
    assert.equal(r.ok, true);
    assert.match(r.message, /复用当前笔记上下文/);

    const receipt = await cardDone.promise;
    assert.equal(receipt.ok, true);
    assert.match(receipt.message, /复用当前笔记上下文/);
    assert.deepEqual(finalOutcomes, ['commented']);
    assert.equal(edge.pushed.some((e) => e.type === 'xiaohongshu.search.execute'), true, 'commit 必须重新搜索稳定 noteId');
    assert.equal(edge.pushed.some((e) => e.type === 'xiaohongshu.note.open'), true, 'commit 必须重新打开目标复检');
    assert.ok(edge.pushed.some((e) => e.type === 'xiaohongshu.note.scroll_comments'));
    assert.ok(edge.pushed.some((e) => e.type === 'xiaohongshu.note.comment'));
  });
});

describe('targetedOutcomeToReceipt（绝不染绿）', () => {
  it('commented → 绿；note_not_found/compose_skipped → 黄；read_failed/post_failed → 红', () => {
    const ok = targetedOutcomeToReceipt({ outcome: 'commented', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 1 }, false);
    assert.equal(ok.level, 'success');
    assert.match(ok.message, /目标笔记《目标笔记标题》/);
    assert.doesNotMatch(ok.message, / noteId| n /);
    const nf = targetedOutcomeToReceipt({ outcome: 'note_not_found', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 2 }, false);
    assert.equal(nf.level, 'warning');
    assert.equal(nf.ok, false);
    assert.match(nf.message, /绝不评「相似」笔记/);
    assert.doesNotMatch(nf.message, / n /);
    const current = targetedOutcomeToReceipt({ outcome: 'commented', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 0 }, true);
    assert.match(current.message, /复用当前笔记上下文/);
    assert.equal(targetedOutcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 1 }, false).level, 'warning');
    assert.equal(targetedOutcomeToReceipt({ outcome: 'read_failed', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 1 }, false).level, 'error');
    assert.equal(targetedOutcomeToReceipt({ outcome: 'post_failed', noteId: 'n', noteTitle: '目标笔记标题', searchAttempts: 1 }, false).level, 'error');
  });
});

// ── change honest-lease-failure-receipts ──
// 定向链此前的 catch **完全没有租约分类**：六种租约错误码全压成 post_failed，回执还带上一个具体的目标
// 笔记——运营会去那篇笔记下找一条根本不存在的评论。这里钉死「租约没拿到 = 未开始 + 不点名笔记」。
describe('定向评论：租约接管失败必须诚实报「未开始」（honest-lease-failure-receipts）', () => {
  it('回执不宣称已定位目标，也绝不带出目标笔记标识', () => {
    const r = targetedOutcomeToReceipt(
      {
        outcome: 'not_started',
        noteId: 'n-secret',
        noteTitle: '目标笔记标题',
        searchAttempts: 0,
        reason: '该账号边端在线、连接正常，但浏览器控制面不可用（驱不动浏览器）；需检查或重启该环境的客户端',
      },
      false,
    );
    assert.equal(r.ok, false);
    assert.equal(r.level, 'error');
    assert.match(r.message, /未搜索、未定位目标笔记、未发布评论/);
    assert.doesNotMatch(r.message, /已定位|已确认当前|发布未确认成功/, '零命令下发，绝不用「已定位/发布未确认」措辞');
    assert.doesNotMatch(r.message, /目标笔记标题|n-secret/, '绝不点名笔记——会让运营以为那篇下面可能已有评论');
    assert.match(r.message, /浏览器控制面不可用/);
    assert.doesNotMatch(r.message, /离线/, '驱不动浏览器 ≠ 掉线');
  });

  it('联系评论型同样走「未开始」，且不染绿', () => {
    const r = targetedOutcomeToReceipt(
      { outcome: 'not_started', noteId: 'n', searchAttempts: 0, reason: 'x' },
      true,
    );
    assert.equal(r.ok, false);
    assert.match(r.title, /定向联系评论未开始/);
  });
});
