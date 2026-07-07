/**
 * CommentScheduler 单测（change comment-search-command，最终装配）。
 * 覆盖：边端离线→红、已在跑→黄、触发成功→绿、happy path 端到端跑通（接管/恢复成对 + 结果卡片 success）、
 * outcomeToReceipt 各结果 → level 映射（失败/未产出绝不染绿）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentScheduler, outcomeToReceipt } from '../../src/comment-agent/comment-scheduler.js';
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

/** 假边端：按命令类型同步 emit 对应上报，跑通 happy path。 */
function fakeEdge(bus: EventBus) {
  return {
    pushToEdges: (envelope: unknown): number => {
      const env = envelope as Envelope;
      if (env.type === 'search.execute') {
        bus.emit('page.cards.arrived', { cards: [{ index: 0, title: 'RAG 实战', noteId: 'n1', collectCount: 900 }], ts: 0 } as never);
      } else if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', { detail: { noteId: 'n1', title: 'RAG 实战', content: '正文', likeCount: 10, collectCount: 9 }, ts: 0 } as never);
      } else if (env.type === 'note.scroll_comments') {
        bus.emit('action.completed', { action: 'scroll_comments', ok: true, candidates: [{ text: '学到了' }], ts: 0 } as never);
      } else if (env.type === 'interaction.comment') {
        bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
      }
      return 1;
    },
  };
}

/** LLM 桩：按角色键返回对应 JSON。 */
function fakeLlm() {
  return {
    complete: async (_p: string, opts?: { role?: string }): Promise<string> => {
      switch (opts?.role) {
        case 'browse:comment_search_term_generator':
          return '{"terms":["RAG 实战"],"source":"curated"}';
        case 'browse:comment_target_picker':
          return '{"pickIndex":0,"stronglyRelevantIndexes":[0],"reason":"领域内"}';
        case 'browse:comment_composer':
          return '{"text":"这套检索链路很实在"}';
        default:
          return '{}';
      }
    },
  };
}

function baseDeps(over: Partial<CommentSchedulerDeps> = {}): CommentSchedulerDeps {
  const bus = new EventBus();
  return {
    resolveConnection: () => ({ bus, edgeId: 'e1' }),
    pusher: fakeEdge(bus),
    getSoul: () => soul,
    selectCurated: async () => [{ title: 'RAG 工程实战' }],
    llmFor: () => fakeLlm(),
    dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async () => {} }),
    approval: { request: async () => {}, isApproved: async () => true },
    onTakeoverStart: () => {},
    onTakeoverEnd: () => {},
    logger: { log: () => {}, warn: () => {} },
    ...over,
  };
}

describe('CommentScheduler.triggerManual', () => {
  it('边端离线（无 edgeId）→ ok:false / level:error', async () => {
    const s = new CommentScheduler(baseDeps({ resolveConnection: () => ({ bus: new EventBus(), edgeId: undefined }) }));
    const r = await s.triggerManual('acc-1');
    assert.equal(r.ok, false);
    assert.equal(r.level, 'error');
    assert.match(r.message, /在线边端/);
  });

  it('facebook 平台评论执行未接入 → 诚实拒绝，绝不回落 xhs 流程（facebook-scheduled-comment 2.2 待实装）', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({
        getPlatform: () => 'facebook',
        onTakeoverStart: () => { takeovers += 1; },
      }),
    );
    const r = await s.triggerManual('acc-1');
    assert.equal(r.ok, false);
    assert.equal(r.level, 'error');
    // facebook 现已在 registry（供平台闸/未来路由），但定向评论执行尚未接入 → 诚实拒绝、不跑 xhs 搜索。
    assert.match(r.message, /Facebook 定向评论执行尚未接入|待实装/);
    assert.equal(takeovers, 0, '绝不回落 xhs 流程（不启动接管）');
  });

  it('account=default → 拒绝（绝不回落）', async () => {
    const s = new CommentScheduler(baseDeps());
    const r = await s.triggerManual('default');
    assert.equal(r.ok, false);
    assert.equal(r.level, 'error');
  });

  it('未绑人设 → 拒绝、不接管边端（不以默认人设代评）', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(baseDeps({ isPersonaBound: () => false, onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerManual('acc-1');
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /未绑定人设/);
    assert.equal(takeovers, 0, '未绑人设绝不接管边端');
  });

  it('触发成功 → ok:true / level:success；happy path 跑通：接管/恢复成对 + 结果卡片 success', async () => {
    const bus = new EventBus();
    const takeovers: string[] = [];
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string; message: string }>();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (n) => { recorded.push(n); } }),
        onTakeoverStart: () => takeovers.push('start'),
        onTakeoverEnd: () => takeovers.push('end'),
        postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level, message: r.message }); },
      }),
    );
    const receipt = await s.triggerManual('acc-1');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.level, 'success');

    const card = await cardDone.promise;
    assert.deepEqual(takeovers, ['start', 'end'], '接管→恢复成对');
    assert.deepEqual(recorded, ['n1'], '发布成功后记一笔去重');
    assert.equal(card.ok, true);
    assert.equal(card.level, 'success', '评了 → 结果卡片绿');
    assert.match(card.message, /笔记《RAG 实战》/);
    assert.doesNotMatch(card.message, / n1 /);
  });

  // ── change account-group-chat-injection：group:on 缺码 fail-closed + 有码端到端注入 ──

  it('group:on 但未注入 getGroupChatInfo → fail-closed（黄告警、不接管边端）', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(baseDeps({ onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerManual('acc-1', { injectGroup: true });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /关联群聊/);
    assert.equal(takeovers, 0, '缺码绝不接管边端 / 绝不发无码评论');
  });

  it('group:on 但账号未配码（getGroupChatInfo→null）→ fail-closed，不接管边端', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({ getGroupChatInfo: async () => null, onTakeoverStart: () => { takeovers += 1; } }),
    );
    const r = await s.triggerManual('acc-1', { injectGroup: true });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /关联群聊/);
    assert.equal(takeovers, 0);
  });

  it('group:on + 有码 → 触发成功，且群聊码注入到人审卡文本（端到端，审=发）', async () => {
    const bus = new EventBus();
    const cardDone = deferred<void>();
    let approvedText: string | undefined;
    const code = '加群🐶\n第二行';
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        getGroupChatInfo: async () => code,
        approval: {
          request: async (r: { text: string }) => { approvedText = r.text; },
          isApproved: async () => true,
        },
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    const receipt = await s.triggerManual('acc-1', { injectGroup: true });
    assert.equal(receipt.ok, true);
    await cardDone.promise;
    assert.equal(approvedText, `这套检索链路很实在\n${code}`, '人审卡文本 = 正文 + 换行 + verbatim 码');
  });

  it('无 group:on（缺省）→ 不读码、正常评论，零回归', async () => {
    const bus = new EventBus();
    const cardDone = deferred<void>();
    let approvedText: string | undefined;
    let readCode = false;
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        getGroupChatInfo: async () => { readCode = true; return '加群码'; },
        approval: {
          request: async (r: { text: string }) => { approvedText = r.text; },
          isApproved: async () => true,
        },
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    await s.triggerManual('acc-1'); // 无 injectGroup
    await cardDone.promise;
    assert.equal(readCode, false, '不带开关时绝不读码');
    assert.equal(approvedText, '这套检索链路很实在', '正文原样、无码追加');
  });

  it('同账号已在跑 → ok:false / level:warning（不并发抢边端）', async () => {
    // 用可控 gate 把首个任务卡在 generateTerms（running 持续），断言后释放让其干净收尾、不挂住进程。
    const bus = new EventBus();
    const gate = deferred();
    const cardDone = deferred();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        selectCurated: async () => {
          await gate.promise; // 卡住直到释放
          return [{ title: 'x' }];
        },
        approval: { request: async () => {}, isApproved: async () => true },
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    const first = await s.triggerManual('acc-1');
    assert.equal(first.ok, true);
    assert.equal(s.isRunning('acc-1'), true);
    const second = await s.triggerManual('acc-1');
    assert.equal(second.ok, false);
    assert.equal(second.level, 'warning');
    gate.resolve(); // 释放，让首个任务跑完
    await cardDone.promise;
    await new Promise((r) => setTimeout(r, 5)); // 让 .finally 清 running 跑完
    assert.equal(s.isRunning('acc-1'), false, '任务收尾后清掉 running');
  });
});

describe('outcomeToReceipt（失败/未产出绝不染绿）', () => {
  it('commented → success（绿）', () => {
    const r = outcomeToReceipt({ outcome: 'commented', noteId: 'n1', noteTitle: 'RAG 实战', text: 'x', term: 't', termsTried: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.level, 'success');
    assert.match(r.message, /笔记《RAG 实战》/);
    assert.doesNotMatch(r.message, /n1/);
  });
  it('no_strong_candidate / no_terms / compose_skipped → warning（黄）', () => {
    assert.equal(outcomeToReceipt({ outcome: 'no_strong_candidate', termsTried: 5 }).level, 'warning');
    assert.equal(outcomeToReceipt({ outcome: 'no_terms', termsTried: 0 }).level, 'warning');
    assert.equal(outcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n1', termsTried: 1 }).level, 'warning');
  });
  it('read_failed / post_failed → error（红）', () => {
    assert.equal(outcomeToReceipt({ outcome: 'read_failed', noteId: 'n1', termsTried: 1 }).level, 'error');
    assert.equal(outcomeToReceipt({ outcome: 'post_failed', noteId: 'n1', termsTried: 1 }).level, 'error');
  });
  it('未产出/失败一律 ok:false（不染绿）', () => {
    for (const o of ['no_terms', 'no_strong_candidate', 'compose_skipped', 'read_failed', 'post_failed'] as const) {
      assert.equal(outcomeToReceipt({ outcome: o, termsTried: 0 }).ok, false, `${o} 必须 ok:false`);
    }
  });
});

// ── facebook-scheduled-comment 2.2/2.3：runFacebookTargetedTask 影子先行编排（纯云，物理不发） ──
describe('CommentScheduler runFacebookTargetedTask (facebook shadow-first)', () => {
  type Audit = import('../../src/comment-agent/facebook-comment-audit-store.js').FacebookCommentAuditRow;
  function fbDeps(over: Partial<CommentSchedulerDeps> & {
    keywords?: string[]; containers?: string[]; auto?: boolean; shadow?: boolean;
    compose?: string | null; canComment?: boolean; cap?: number; done?: number;
  } = {}): { deps: CommentSchedulerDeps; audits: Audit[]; posted: string[] } {
    const audits: Audit[] = [];
    const posted: string[] = [];
    const bus = new EventBus();
    const deps = baseDeps({
      getPlatform: () => 'facebook',
      // 记录任何真发出去的 edge 命令（用来断言影子/未接入路径绝不下发提交）。
      pusher: { pushToEdges: (env: unknown) => { posted.push((env as { type: string }).type); return 1; } },
      resolveConnection: () => ({ bus, edgeId: 'e-fb' }),
      random: () => 0,
      facebookConfigFor: () => ({
        enabled: (over.keywords ?? ['咖啡']).length > 0 && (over.containers ?? ['g1']).length > 0,
        keywords: over.keywords ?? ['咖啡'],
        containers: over.containers ?? ['g1'],
      }),
      facebookAutoEnabled: () => over.auto ?? false,
      facebookShadow: () => over.shadow ?? false,
      facebookCompose: async () => (over.compose === undefined ? '这家手冲咖啡很不错' : over.compose),
      facebookCanComment: async () => over.canComment ?? true,
      facebookDailyCap: () => over.cap ?? 5,
      facebookCommentedToday: async () => over.done ?? 0,
      facebookAudit: (row) => audits.push(row),
      ...over,
    });
    return { deps, audits, posted };
  }
  const tick = () => new Promise((r) => setTimeout(r, 15));

  it('影子模式：撰写+校验通过 → 审计 shadow_ok，且绝不下发任何 edge 命令', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true });
    const r = await new CommentScheduler(deps).triggerManual('fb-1');
    assert.equal(r.ok, true);
    await tick();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'shadow_ok');
    assert.equal(audits[0].shadow, true);
    assert.deepEqual(posted, [], '影子绝不下发提交命令');
  });

  it('配置空（无容器）→ fail-closed 审计 no_targets，不发', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true, containers: [] });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'no_targets');
    assert.deepEqual(posted, []);
  });

  it('校验器拒（含链接）→ 审计 compose_skipped（只拒不修），不发', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true, compose: '好文 https://spam.example 推荐' });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'compose_skipped');
    assert.equal(audits[0].reason, 'contains_url');
    assert.deepEqual(posted, []);
  });

  it('撰写为空 → compose_skipped(empty_compose)', async () => {
    const { deps, audits } = fbDeps({ shadow: true, compose: null });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'compose_skipped');
    assert.equal(audits[0].reason, 'empty_compose');
  });

  it('kill switch 全关（auto=false, shadow=false）→ 静默不跑、无审计、不发', async () => {
    const { deps, audits, posted } = fbDeps({ auto: false, shadow: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.deepEqual(audits, []);
    assert.deepEqual(posted, []);
  });

  it('真发路径 canDo 拒 → quota_denied，不发', async () => {
    const { deps, audits, posted } = fbDeps({ auto: true, shadow: false, canComment: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'canDo');
    assert.deepEqual(posted, []);
  });

  it('真发路径日上限满 → quota_denied(daily_cap)', async () => {
    const { deps, audits } = fbDeps({ auto: true, shadow: false, cap: 2, done: 2 });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'daily_cap');
  });

  it('真发路径过闸但边端能力未接入 → not_wired（绝不假成功、绝不下发提交）', async () => {
    const { deps, audits, posted } = fbDeps({ auto: true, shadow: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'not_wired');
    assert.deepEqual(posted, [], 'not_wired 绝不下发提交命令');
  });

  it('未注入 FB deps → 维持诚实拒绝（零回归）', async () => {
    const deps = baseDeps({ getPlatform: () => 'facebook' }); // 不注入 facebookConfigFor
    const r = await new CommentScheduler(deps).triggerManual('fb-1');
    assert.equal(r.ok, false);
    assert.match(r.message, /尚未接入|待实装/);
  });
});
