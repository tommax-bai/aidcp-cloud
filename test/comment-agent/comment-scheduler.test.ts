/**
 * CommentScheduler 单测（change comment-search-command，最终装配）。
 * 覆盖：边端离线→红、已在跑→黄、触发成功→绿、happy path 端到端跑通（接管/恢复成对 + 结果卡片 success）、
 * outcomeToReceipt 各结果 → level 映射（失败/未产出绝不染绿）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '@automation/event-bus/index.js';
import { CommentScheduler, outcomeToReceipt, humanGroupLabel, joinOnlyReceipt, joinCommentReceipt, commentOutcomeReason } from '@automation/comment-agent/comment-scheduler.js';
import { EdgeTaskLeaseError } from '@automation/comm/edge-task-lease-client.js';
import type { CommentSchedulerDeps } from '@automation/comment-agent/comment-scheduler.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import { ContentPortError } from '@kernel/kernel/content-port-error.js';

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
    edgeTaskLeases: {
      withLease: async (request, work) => work({ taskId: `task-${request.kind}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority }),
    },
    getSoul: () => soul,
    curatedSelection: { selectSamplesForSearchTerms: async () => [{ title: 'RAG 工程实战', topics: [], collectCount: null }] },
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
    const s = new CommentScheduler(baseDeps({ personaBinding: () => 'unbound', onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerManual('acc-1');
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /未绑定人设/);
    assert.equal(takeovers, 0, '未绑人设绝不接管边端');
  });

  it('触发成功 → ok:true / level:success；keep-open 单租约贯穿搜索→人审→发布 + 结果卡片 success', async () => {
    const bus = new EventBus();
    const leaseKinds: string[] = [];
    let activeLeases = 0;
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string; message: string }>();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (n) => { recorded.push(n); } }),
        edgeTaskLeases: {
          withLease: async (request, work) => {
            leaseKinds.push(request.kind);
            activeLeases++;
            try {
              return await work({ taskId: `task-${request.kind}-${leaseKinds.length}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority });
            } finally {
              activeLeases--;
            }
          },
        },
        approval: {
          // keep-open（change comment-keep-open-through-approval）：撰写/人审在持有租约内进行，
          // 浏览器停在目标详情页不释放——审批期间 activeLeases 恒为 1（不再是旧的「审批前释放」）。
          request: async () => { assert.equal(activeLeases, 1, 'keep-open：发人审卡时仍持 edge 租约（浏览器停在详情页）'); },
          isApproved: async () => { assert.equal(activeLeases, 1, 'keep-open：等待/读取人审期间持锁不释放'); return true; },
        },
        postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level, message: r.message }); },
      }),
    );
    const receipt = await s.triggerManual('acc-1');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.level, 'success');

    const card = await cardDone.promise;
    assert.deepEqual(leaseKinds, ['comment_prepare'], 'keep-open：一条评论只申请一个持有租约（无 prepare 复搜 / commit 复搜）');
    assert.deepEqual(recorded, ['n1'], '发布成功后记一笔去重');
    assert.equal(card.ok, true);
    assert.equal(card.level, 'success', '评了 → 结果卡片绿');
    assert.match(card.message, /笔记《RAG 实战》/);
    assert.doesNotMatch(card.message, / n1 /);
  });

  // keep-open 核心不变量（change comment-keep-open-through-approval）：一条评论只搜一次、持锁贯穿人审、
  // 人审拒绝 → 结束不复搜不换词。
  it('keep-open：人审拒绝 → 只搜一次、单持有租约、诚实不发（不复搜、不换词）', async () => {
    const bus = new EventBus();
    const fe = fakeEdge(bus);
    const leaseKinds: string[] = [];
    let searchExecutes = 0;
    let activeLeases = 0;
    let maxActiveLeases = 0;
    const cardDone = deferred<{ ok: boolean; level: string }>();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: {
          pushToEdges: (env: unknown) => {
            if ((env as Envelope).type === 'search.execute') searchExecutes++;
            return fe.pushToEdges(env);
          },
        },
        edgeTaskLeases: {
          withLease: async (request, work) => {
            leaseKinds.push(request.kind);
            activeLeases++; maxActiveLeases = Math.max(maxActiveLeases, activeLeases);
            try {
              return await work({ taskId: `t-${leaseKinds.length}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority });
            } finally { activeLeases--; }
          },
        },
        approval: {
          timeoutMs: 50, // 短超时：人审未通过（拒绝/超时）快速收敛，不真等 90s
          request: async () => { assert.equal(activeLeases, 1, '发人审卡时持锁（浏览器停在详情页）'); },
          isApproved: async () => { assert.equal(activeLeases, 1, '人审等待期持锁不释放'); return false; }, // 未通过
        },
        postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level }); },
      }),
    );
    await s.triggerManual('acc-1');
    const card = await cardDone.promise;
    assert.equal(searchExecutes, 1, 'keep-open：一条评论只搜一次，人审拒绝也不复搜/不换词');
    assert.deepEqual(leaseKinds, ['comment_prepare'], '单持有租约，无 commit 复搜租约');
    assert.equal(maxActiveLeases, 1, '任意时刻至多一个持有租约');
    assert.equal(card.ok, false, '拒绝 → 不发、诚实回执');
  });

  // ── change account-group-chat-injection → generalize-contact-info：--contact 缺联系方式 fail-closed + 有联系方式端到端注入 ──

  it('--contact 但未注入 getContactInfo → fail-closed（黄告警、不接管边端）', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(baseDeps({ onTakeoverStart: () => { takeovers += 1; } }));
    const r = await s.triggerManual('acc-1', { injectContact: true });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /联系方式/);
    assert.equal(takeovers, 0, '缺联系方式绝不接管边端 / 绝不发无联系方式评论');
  });

  it('--contact 但账号未配联系方式（getContactInfo→null）→ fail-closed，不接管边端', async () => {
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({ getContactInfo: async () => null, onTakeoverStart: () => { takeovers += 1; } }),
    );
    const r = await s.triggerManual('acc-1', { injectContact: true });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /联系方式/);
    assert.equal(takeovers, 0);
  });

  // ── change facebook-rule-comment-plain-fallback：缺联系方式的**范围化**降级 ──
  //
  // 默认仍是 fail-closed（上面两条用例守着）。只有调用方**显式**声明 contactFallback 才降级，
  // 且当前唯一获授权的调用方是 Facebook 规则模式的加群联系评论。

  it('未声明 contactFallback 的调用方 MUST 保持 fail-closed（默认安全侧不因新能力而松动）', async () => {
    // 六个入口共用同一道闸。这条锁住「默认值」本身——任何人把默认改成降级都会打红。
    let takeovers = 0;
    const s = new CommentScheduler(
      baseDeps({ getPlatform: () => 'facebook', getContactInfo: async () => null, onTakeoverStart: () => { takeovers += 1; } }),
    );
    const r = await s.triggerManual('acc-1', { injectContact: true, joinFirst: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /联系方式/);
    assert.equal(takeovers, 0, '未声明降级时 MUST NOT 接管边端——连加群都不该发生');
  });

  it('显式声明 contactFallback 后缺联系方式 → 降级发普通评论，且触发回执按实际值说「不带联系方式」', async () => {
    const joined: string[] = [];
    const s = new CommentScheduler(
      baseDeps({
        getPlatform: () => 'facebook',
        getContactInfo: async () => null,
        facebookConfigFor: () => ({
          enabled: true,
          keywords: ['k'],
          containers: [{ url: 'https://www.facebook.com/groups/1' }],
          commentMode: 'template' as const,
          commentTemplates: ['你好'],
        }),
        facebookJoinNewGroup: async () => { joined.push('acc-1'); return { triggered: true, outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/1' }; },
      }),
    );
    const r = await s.triggerManual('acc-1', {
      injectContact: true,
      joinFirst: true,
      contactFallback: { kind: 'plain', approvalMode: 'review' },
    });
    assert.equal(r.ok, true, '声明降级后 MUST 继续，而不是整段停住');
    assert.match(r.message, /未配联系方式/, '回执 MUST 说清本次为什么不带联系方式');
    assert.match(r.message, /降级/);
    assert.doesNotMatch(
      r.message,
      /（带联系方式/,
      '回执 MUST NOT 按请求意图宣称带了联系方式——那是对运营说谎',
    );
  });

  it('降级产出走**普通评论**车道的审批模式，MUST NOT 继承联系评论车道的免审', async () => {
    // 运营给的是「联系评论免审」，授权对象是带码的模板评论。把它外溢到一条从未为该车道
    // 授权的普通评论正文，就是授权外溢——这条用最容易出事的组合锁住：联系评论免审、普通评论需人审。
    const sources: Array<string | undefined> = [];
    const s = new CommentScheduler(
      baseDeps({
        getPlatform: () => 'facebook',
        getContactInfo: async () => null,
        resolveApprovalMode: async (_accountId, sourceMode) => { sources.push(sourceMode); return sourceMode; },
        facebookConfigFor: () => ({
          enabled: true,
          keywords: ['k'],
          containers: [{ url: 'https://www.facebook.com/groups/1' }],
          commentMode: 'template' as const,
          commentTemplates: ['你好'],
        }),
        facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/1' }),
      }),
    );
    const r = await s.triggerManual('acc-1', {
      injectContact: true,
      joinFirst: true,
      approvalMode: 'auto_approve',                                   // 联系评论车道：免审
      contactFallback: { kind: 'plain', approvalMode: 'review' },      // 普通评论车道：需人审
    });
    assert.equal(r.ok, true);
    assert.deepEqual(sources, ['review'], '降级后 MUST 用普通评论车道的来源模式解析审批');
    assert.match(r.message, /人审/, '回执也要如实说这条要走人审');
  });

  it('有联系方式时声明 contactFallback 不改变任何行为（降级只在缺联系方式时生效）', async () => {
    const sources: Array<string | undefined> = [];
    const s = new CommentScheduler(
      baseDeps({
        getPlatform: () => 'facebook',
        getContactInfo: async () => 'wx: abc',
        resolveApprovalMode: async (_accountId, sourceMode) => { sources.push(sourceMode); return sourceMode; },
        facebookConfigFor: () => ({
          enabled: true,
          keywords: ['k'],
          containers: [{ url: 'https://www.facebook.com/groups/1' }],
          commentMode: 'template' as const,
          commentTemplates: ['你好'],
        }),
        facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/1' }),
      }),
    );
    const r = await s.triggerManual('acc-1', {
      injectContact: true,
      joinFirst: true,
      approvalMode: 'auto_approve',
      contactFallback: { kind: 'plain', approvalMode: 'review' },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(sources, ['auto_approve'], '拿得到联系方式时 MUST 走联系评论车道，与改造前一致');
    assert.match(r.message, /带联系方式/);
  });

  it('--contact + 有联系方式 → 触发成功，且联系方式注入到人审卡文本（端到端，审=发）', async () => {
    const bus = new EventBus();
    const cardDone = deferred<void>();
    let approvedText: string | undefined;
    const code = '加群🐶\n第二行';
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        getContactInfo: async () => code,
        approval: {
          request: async (r: { text: string }) => { approvedText = r.text; },
          isApproved: async () => true,
        },
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    const receipt = await s.triggerManual('acc-1', { injectContact: true });
    assert.equal(receipt.ok, true);
    await cardDone.promise;
    assert.equal(approvedText, `这套检索链路很实在\n${code}`, '人审卡文本 = 正文 + 换行 + verbatim 联系方式');
  });

  it('无 --contact（缺省）→ 不读联系方式、正常评论，零回归', async () => {
    const bus = new EventBus();
    const cardDone = deferred<void>();
    let approvedText: string | undefined;
    let readCode = false;
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        getContactInfo: async () => { readCode = true; return '加群码'; },
        approval: {
          request: async (r: { text: string }) => { approvedText = r.text; },
          isApproved: async () => true,
        },
        postResultCard: () => { cardDone.resolve(); },
      }),
    );
    await s.triggerManual('acc-1'); // 无 injectContact
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
        curatedSelection: {
          selectSamplesForSearchTerms: async () => {
            await gate.promise; // 卡住直到释放
            return [{ title: 'x', topics: [], collectCount: null }];
          },
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
  // change comment-keep-open-through-approval 收尾：compose_skipped 回执按 reason 诚实区分——
  // 「送审未获批」绝不再误说成"撰写为空"（否则运营看到有稿的失败卡却写"撰写为空"，假归因）。
  it('compose_skipped 回执按 reason 诚实区分（送审未获批 ≠ 撰写为空）', () => {
    const unapproved = outcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n1', noteTitle: 'X', termsTried: 1, reason: 'approval_unapproved' });
    assert.match(unapproved.message, /送飞书人审|超时或被拒/, '送审未获批应如实说明送审+未获批');
    assert.doesNotMatch(unapproved.message, /模型未产出|撰写为空$/, '有稿送审的失败绝不误说成撰写为空');

    const empty = outcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n1', noteTitle: 'X', termsTried: 1, reason: 'empty_compose' });
    assert.match(empty.message, /模型未产出|清洗后为空/, '撰写为空应如实说明未产出');

    const notWired = outcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n1', noteTitle: 'X', termsTried: 1, reason: 'approval_not_wired' });
    assert.match(notWired.message, /人审口未接线/, '人审口未接线应如实说明');

    // reason 缺省（老结果 / 未知）→ 回落旧措辞、向后兼容不炸。
    const legacy = outcomeToReceipt({ outcome: 'compose_skipped', noteId: 'n1', termsTried: 1 });
    assert.equal(legacy.level, 'warning');
    assert.equal(legacy.ok, false);
  });
  it('read_failed / post_failed → error（红）', () => {
    assert.equal(outcomeToReceipt({ outcome: 'read_failed', noteId: 'n1', termsTried: 1 }).level, 'error');
    assert.equal(outcomeToReceipt({ outcome: 'post_failed', noteId: 'n1', termsTried: 1 }).level, 'error');
  });
  it('not_started → error，明确未搜索、未选中、未发布', () => {
    const r = outcomeToReceipt({ outcome: 'not_started', termsTried: 0, reason: 'edge task acquire timeout' });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'error');
    assert.match(r.message, /未搜索、未选中笔记、未发布评论/);
    assert.doesNotMatch(r.message, /已选中笔记|发布未确认成功/);
  });
  // change comment-search-nav-confirm：read_failed 回执带真实 reason，绝不硬编码「边端超时或离线」（假归因红线）。
  it('read_failed 回执带真实 reason、不冒充离线', () => {
    const r = outcomeToReceipt({ outcome: 'read_failed', noteId: 'n1', noteTitle: 'X', termsTried: 1, reason: '复检时目标已不在搜索结果中（页面重排/未导航到结果页）' });
    assert.match(r.message, /复检时目标已不在搜索结果中/, '应呈现真实原因');
    assert.doesNotMatch(r.message, /边端超时或离线/, '绝不再硬编码「边端超时或离线」');
  });
  it('未产出/失败一律 ok:false（不染绿）', () => {
    for (const o of ['not_started', 'no_terms', 'no_strong_candidate', 'compose_skipped', 'read_failed', 'post_failed'] as const) {
      assert.equal(outcomeToReceipt({ outcome: o, termsTried: 0 }).ok, false, `${o} 必须 ok:false`);
    }
  });
});

describe('CommentScheduler edge acquire failure', () => {
  it('排期同用的任务路径在 acquire timeout 后不下发搜索，结果卡诚实说明未开始', async () => {
    const cardDone = deferred<{ ok: boolean; title: string; message: string }>();
    let searchCommands = 0;
    const s = new CommentScheduler(
      baseDeps({
        pusher: {
          pushToEdges: (envelope: unknown) => {
            if ((envelope as Envelope).type === 'search.execute') searchCommands++;
            return 1;
          },
        },
        edgeTaskLeases: {
          withLease: async () => {
            throw new EdgeTaskLeaseError('acquire_timeout', 'edge task acquire timeout taskId=task-1 edge=e1');
          },
        },
        postResultCard: (_accountId, receipt) => { cardDone.resolve(receipt); },
      }),
    );

    const trigger = await s.triggerManual('acc-1');
    assert.equal(trigger.ok, true);
    const card = await cardDone.promise;
    assert.equal(searchCommands, 0);
    assert.equal(card.title, '按需评论未开始');
    assert.match(card.message, /未搜索、未选中笔记、未发布评论/);
    assert.doesNotMatch(card.message, /已选中笔记|发布未确认成功/);
  });

  // ── change honest-lease-failure-receipts ──
  // 这个判定曾是一张**逐码白名单**，漏过两次（browser_wake_failed、然后 edge_unhealthy），而 typecheck
  // 永远抓不到——往 code 联合类型里加成员是**变宽**、不是变窄。这几条断言是唯一的机械守卫，别删。

  it('edge_unhealthy（浏览器驱不动）→ not_started + 零命令下发 + 归还小时格，绝不谎称已选中', async () => {
    const cardDone = deferred<{ ok: boolean; title: string; message: string }>();
    const notStarted: Array<{ action: string; reason: string }> = [];
    let searchCommands = 0;
    const s = new CommentScheduler(
      baseDeps({
        pusher: {
          pushToEdges: (envelope: unknown) => {
            if ((envelope as Envelope).type === 'search.execute') searchCommands++;
            return 1;
          },
        },
        edgeTaskLeases: {
          withLease: async () => {
            throw new EdgeTaskLeaseError(
              'edge_unhealthy',
              'edge task rejected because browser control is unavailable taskId=task-1 edge=e1',
            );
          },
        },
        onScheduledTaskNotStarted: (_accountId, action, reason) => { notStarted.push({ action, reason }); },
        postResultCard: (_accountId, receipt) => { cardDone.resolve(receipt); },
      }),
    );

    // priority='automatic' = 排期路径；小时格回流闸只对它生效。
    const trigger = await s.triggerManual('acc-1', { priority: 'automatic' });
    assert.equal(trigger.ok, true);
    const card = await cardDone.promise;

    assert.equal(searchCommands, 0, '租约没拿到 ⇒ 一条业务命令都不该下发');
    assert.equal(card.title, '按需评论未开始');
    assert.match(card.message, /未搜索、未选中笔记、未发布评论/);
    assert.doesNotMatch(card.message, /已选中笔记|发布未确认成功/, '零命令下发，绝不谎称笔记已选中 / 评论可能已发出');
    // 归因分档：驱不动浏览器 ≠ 掉线。说成离线会让运维去查一个根本没断的连接。
    assert.match(card.message, /浏览器控制面不可用/);
    assert.doesNotMatch(card.message, /离线/);
    // 小时格必须退回去——否则这一小时的排期名额零动作白烧、且不重试。
    assert.deepEqual(notStarted, [{ action: 'comment', reason: 'edge_unhealthy' }]);
  });

  it('自动 not_started 已由排期器接管 → 中间重试不逐次发结果卡', async () => {
    const handled = deferred<void>();
    let resultCards = 0;
    const s = new CommentScheduler(
      baseDeps({
        edgeTaskLeases: {
          withLease: async () => {
            throw new EdgeTaskLeaseError(
              'browser_wake_failed',
              'edge task rejected because the parked browser could not be woken taskId=task-1 edge=e1',
            );
          },
        },
        onScheduledTaskNotStarted: () => {
          handled.resolve();
          return true;
        },
        postResultCard: () => { resultCards++; },
      }),
    );

    const trigger = await s.triggerManual('acc-1', { priority: 'automatic' });
    assert.equal(trigger.ok, true);
    await handled.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resultCards, 0, '中间未开始由小时格重试/放弃卡统一通知，不得每分钟刷卡');
  });

  it('release_timeout → 绝不判 not_started（work 已跑过、评论可能已真发出；归还小时格会诱发重复评论）', async () => {
    const cardDone = deferred<{ title: string; message: string }>();
    const notStarted: string[] = [];
    const s = new CommentScheduler(
      baseDeps({
        edgeTaskLeases: {
          withLease: async () => {
            throw new EdgeTaskLeaseError('release_timeout', 'edge task release timed out taskId=task-1 edge=e1');
          },
        },
        onScheduledTaskNotStarted: (_a, action) => { notStarted.push(action); },
        postResultCard: (_accountId, receipt) => { cardDone.resolve(receipt); },
      }),
    );

    await s.triggerManual('acc-1', { priority: 'automatic' });
    const card = await cardDone.promise;
    assert.notEqual(card.title, '按需评论未开始', 'release_timeout 发生在 work 之后，绝不是「未开始」');
    assert.deepEqual(notStarted, [], '绝不归还小时格——重试会造成重复评论');
  });

  it('browser_wake_failed 的回执标明可恢复（与「驱不动」分档说）', () => {
    const r = outcomeToReceipt({
      outcome: 'not_started',
      termsTried: 0,
      reason: '该账号浏览器处于待机、且未能在唤醒死线内起来（可恢复，稍后自动重试）',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /可恢复/);
    assert.doesNotMatch(r.message, /已选中笔记|发布未确认成功/);
  });
});

// ── change manual-comment-force-flag：/comment --force 放开「强相关 + 每笔记去重」两道软筛选（仅手动路径），仍守人审/安全校验 ──
describe('CommentScheduler /comment --force (manual-comment-force-flag)', () => {
  // 甄选角色判「无强相关」（pickIndex=null）；其余角色照常。
  function llmNoStrong() {
    return {
      complete: async (_p: string, opts?: { role?: string }): Promise<string> => {
        switch (opts?.role) {
          case 'browse:comment_search_term_generator': return '{"terms":["RAG 实战"],"source":"curated"}';
          case 'browse:comment_target_picker': return '{"pickIndex":null,"stronglyRelevantIndexes":[],"reason":"无强相关"}';
          case 'browse:comment_composer': return '{"text":"这套检索链路很实在"}';
          default: return '{}';
        }
      },
    };
  }

  it('XHS 无 --force + 无强相关候选 → no_strong_candidate、不评（默认路径零回归）', async () => {
    const bus = new EventBus();
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string }>();
    const s = new CommentScheduler(baseDeps({
      resolveConnection: () => ({ bus, edgeId: 'e1' }),
      pusher: fakeEdge(bus),
      llmFor: () => llmNoStrong(),
      dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (n) => { recorded.push(n); } }),
      postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level }); },
    }));
    await s.triggerManual('acc-1'); // 无 force
    const card = await cardDone.promise;
    assert.equal(card.ok, false, '无强相关候选 → 默认不评');
    assert.equal(card.level, 'warning');
    assert.deepEqual(recorded, [], '没发评论、没记去重');
  });

  it('XHS --force + 无强相关候选 → 兜底选收藏最高的一篇并发布；触发回执标注 --force', async () => {
    const bus = new EventBus();
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean; level: string }>();
    const s = new CommentScheduler(baseDeps({
      resolveConnection: () => ({ bus, edgeId: 'e1' }),
      pusher: fakeEdge(bus),
      llmFor: () => llmNoStrong(),
      dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (n) => { recorded.push(n); } }),
      postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level }); },
    }));
    const receipt = await s.triggerManual('acc-1', { force: true });
    assert.match(receipt.message, /--force/, '触发回执标注本次为 --force');
    const card = await cardDone.promise;
    assert.equal(card.ok, true, '--force 兜底选收藏最高的一篇 → 评了（不再 no_strong_candidate）');
    assert.equal(card.level, 'success');
    assert.deepEqual(recorded, ['n1'], '发布成功后仍记一笔去重');
  });

  it('XHS --force 但人审未通过 → 不发（force 只绕相关性/去重，绝不绕人审）', async () => {
    const bus = new EventBus();
    const recorded: string[] = [];
    const cardDone = deferred<{ ok: boolean }>();
    const s = new CommentScheduler(baseDeps({
      resolveConnection: () => ({ bus, edgeId: 'e1' }),
      pusher: fakeEdge(bus),
      llmFor: () => llmNoStrong(),
      dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async (n) => { recorded.push(n); } }),
      approval: { timeoutMs: 50, request: async () => {}, isApproved: async () => false }, // 人审未通过
      postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok }); },
    }));
    await s.triggerManual('acc-1', { force: true });
    const card = await cardDone.promise;
    assert.equal(card.ok, false, 'force 下人审未通过仍不发');
    assert.deepEqual(recorded, [], '没发、没记去重（人是刹车）');
  });

  it('XHS --force 放开去重 → 已评过的笔记也能再评（默认路径会被去重挡下）', async () => {
    // dedup 命中（已评过 n1）；picker 默认强相关（复用 baseDeps 的 fakeLlm）。
    // 无 force：n1 在甄选前被去重滤掉 → 无候选 → no_strong_candidate、不评。
    {
      const bus = new EventBus();
      const recorded: string[] = [];
      const cardDone = deferred<{ ok: boolean }>();
      const s = new CommentScheduler(baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        dedupFor: () => ({ hasInteracted: async () => true, recordInteraction: async (n) => { recorded.push(n); } }),
        postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok }); },
      }));
      await s.triggerManual('acc-1'); // 无 force
      const card = await cardDone.promise;
      assert.equal(card.ok, false, '默认路径：已评过被去重挡下、不评');
      assert.deepEqual(recorded, [], '没再评');
    }
    // force：放开去重 → n1 仍入候选、被选中、再评成功。
    {
      const bus = new EventBus();
      const recorded: string[] = [];
      const cardDone = deferred<{ ok: boolean; level: string }>();
      const s = new CommentScheduler(baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        dedupFor: () => ({ hasInteracted: async () => true, recordInteraction: async (n) => { recorded.push(n); } }),
        postResultCard: (_a, r) => { cardDone.resolve({ ok: r.ok, level: r.level }); },
      }));
      await s.triggerManual('acc-1', { force: true });
      const card = await cardDone.promise;
      assert.equal(card.ok, true, '--force 放开去重 → 已评过的也能再评');
      assert.equal(card.level, 'success');
      assert.deepEqual(recorded, ['n1'], '再评后仍记一笔去重（记账不变）');
    }
  });
});

// ── facebook-scheduled-comment 2.2/2.3：runFacebookTargetedTask 影子先行编排（纯云，物理不发） ──
describe('CommentScheduler runFacebookTargetedTask (facebook shadow-first)', () => {
  type Audit = import('@automation/comment-agent/facebook-comment-audit-store.js').FacebookCommentAuditRow;
  function fbDeps(over: Partial<CommentSchedulerDeps> & {
    keywords?: string[]; containers?: string[]; auto?: boolean; shadow?: boolean;
    commentMode?: 'generated' | 'template'; commentTemplates?: string[];
    compose?: string | null; canComment?: boolean;
  } = {}): { deps: CommentSchedulerDeps; audits: Audit[]; posted: string[] } {
    const audits: Audit[] = [];
    const posted: string[] = [];
    const bus = new EventBus();
    const deps = baseDeps({
      getPlatform: () => 'facebook',
      // 记录真发出去的 edge 命令 + 按类型 emit 上报（读了再写：影子也要搜+开帖读上下文，故需 emit page.cards/note.detail）。
      pusher: {
        pushToEdges: (env: unknown) => {
          const e = env as { type: string; payload?: Record<string, unknown> };
          posted.push(e.type);
          if (e.type === 'search.execute') {
            bus.emit('page.cards.arrived', { cards: [{ index: 0, noteId: 'https://fb.com/g/1/posts/9' }], ts: 0 } as never);
          } else if (e.type === 'note.open') {
            const payload = e.payload as { url?: string; selection?: string };
            bus.emit('note.detail.arrived', {
              detail: {
                noteId: payload.selection === 'first_commentable_group_post'
                  ? 'https://www.facebook.com/groups/1/posts/9'
                  : payload.url,
                content: '',
                comments: ['原评论：手冲咖啡真香'],
              },
              ts: 0,
            } as never);
          } else if (e.type === 'interaction.comment') {
            bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
          }
          return 1;
        },
      },
      resolveConnection: () => ({ bus, edgeId: 'e-fb' }),
      stepTimeoutMs: 60,
      random: () => 0,
      facebookConfigFor: () => ({
        enabled: (over.commentMode ?? 'generated') === 'generated' || (over.commentTemplates ?? []).length > 0,
        keywords: over.keywords ?? ['咖啡'],
        containers: (over.containers ?? ['g1']).map((u) => ({ url: u })),
        commentMode: over.commentMode ?? 'generated',
        commentTemplates: over.commentTemplates ?? [],
      }),
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: ((over.commentMode ?? 'generated') === 'generated' || (over.commentTemplates ?? []).length > 0)
          && (over.containers ?? ['g1']).length > 0,
        keywords: over.keywords ?? ['咖啡'],
        containers: (over.containers ?? ['g1']).map((u) => ({ url: u })),
        commentMode: over.commentMode ?? 'generated',
        commentTemplates: over.commentTemplates ?? [],
      }),
      facebookCompose: async () => (over.compose === undefined ? '这家手冲咖啡很不错' : over.compose),
      facebookCanComment: async () => over.canComment ?? true,
      facebookAudit: (row) => audits.push(row),
      ...over,
    });
    return { deps, audits, posted };
  }
  const tick = () => new Promise((r) => setTimeout(r, 15));

  it('旧 FB 自动/影子环境值不再静默关闭账号评论链', async () => {
    const previousAuto = process.env.AIDCP_FB_COMMENT_AUTO;
    const previousShadow = process.env.AIDCP_FB_COMMENT_SHADOW;
    process.env.AIDCP_FB_COMMENT_AUTO = 'false';
    process.env.AIDCP_FB_COMMENT_SHADOW = 'false';
    try {
      const { deps, audits, posted } = fbDeps();
      const r = await new CommentScheduler(deps).triggerManual('fb-1');
      assert.equal(r.ok, true);
      await tick();
      assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
      assert.equal(audits.at(-1)?.outcome, 'commented');
    } finally {
      if (previousAuto === undefined) delete process.env.AIDCP_FB_COMMENT_AUTO;
      else process.env.AIDCP_FB_COMMENT_AUTO = previousAuto;
      if (previousShadow === undefined) delete process.env.AIDCP_FB_COMMENT_SHADOW;
      else process.env.AIDCP_FB_COMMENT_SHADOW = previousShadow;
    }
  });

  it('无 eligible joined group → fail-closed 审计 no_targets，浏览前即停、不发', async () => {
    const { deps, audits, posted } = fbDeps({ containers: [] });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'no_targets');
    assert.deepEqual(posted, []);
  });

  it('校验器拒（含链接）→ 审计 compose_skipped（只拒不修），绝不提交', async () => {
    const { deps, audits, posted } = fbDeps({ compose: '好文 https://spam.example 推荐' });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'contains_url');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('撰写为空 → compose_skipped(empty_compose)，绝不提交', async () => {
    const { deps, audits, posted } = fbDeps({ compose: null });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'empty_compose');
    assert.ok(!posted.includes('interaction.comment'));
  });

  // 注：该 quota_denied 测试**不带** manualOverride → 模型的是「自动排期评论」路径（ContentScheduler 的 priority:automatic 调用），
  // 此路径由 RiskController 单一配额闸控制。飞书手动 /comment 由 server.ts 显式带 manualOverride:true。
  it('真发路径 canDo 拒 → quota_denied，不发（自动路径：无 manualOverride）', async () => {
    const { deps, audits, posted } = fbDeps({ canComment: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'canDo');
    assert.deepEqual(posted, []);
  });

  // 回归：自动排期评论调用形态（ContentScheduler 传 priority:'automatic'、绝不带 manualOverride，见 server.ts）→ 配额闸照旧生效。
  // 钉死不变量「只有飞书手动出口带 override」：若哪天 auto caller 误带了旗标，此断言会红。
  it('自动调用形态（priority:automatic 无 manualOverride）→ canDo 拒仍 quota_denied，不发', async () => {
    const { deps, audits, posted } = fbDeps({ canComment: false });
    await new CommentScheduler(deps).triggerManual('fb-1', { priority: 'automatic' });
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'canDo');
    assert.deepEqual(posted, [], '自动路径无 override → 配额被拒即不下发');
  });

  it('未注入 FB deps → 维持诚实拒绝（零回归）', async () => {
    const deps = baseDeps({ getPlatform: () => 'facebook' }); // 不注入 facebookConfigFor
    const r = await new CommentScheduler(deps).triggerManual('fb-1');
    assert.equal(r.ok, false);
    assert.match(r.message, /尚未接入|待实装/);
  });
});

// ── facebook-scheduled-comment 真发接线（task 4.x）：容器搜索 → 开帖 → 提交 + 服务器确认 ──
describe('CommentScheduler runFacebookTargetedTask (facebook real send)', () => {
  type Audit = import('@automation/comment-agent/facebook-comment-audit-store.js').FacebookCommentAuditRow;
  const PERMALINK = 'https://www.facebook.com/groups/1/posts/2';

  /** FB 真发流水线的假边端：按命令类型 emit 对应上报到同一私有总线；可配搜索失败/开帖失败/提交结果/候选集。 */
  function fbFlowDeps(cfg: {
    keywords?: string[];
    candidates?: string[];
    searchFail?: string;
    openOk?: boolean;
    openReason?: string;
    submit?: { ok: boolean; reason?: string };
    seen?: string[];
    coverageContainers?: string[];
    coverageRelaxed?: boolean;
    commentMode?: 'generated' | 'template';
    commentTemplates?: string[];
    regionalTemplates?: string[];
    regionalFailure?: 'missing_group_region' | 'regional_template_missing';
    /** 连接在 trigger 通过后掉线：resolveConnection 首次（trigger 闸）返回连接、其后（真发内）返回 null。 */
    dropAfterTrigger?: boolean;
    /** 边缘回传的真实群名（undefined=默认 PR 群名，null=不回传）。 */
    containerName?: string | null;
    /** 开帖回读的帖子正文/他人评论（读了再写：喂给撰写器）。 */
    postText?: string;
    comments?: string[];
    /** 空关键词首帖可返回 canonical permalink 或 Edge 同页 targetRef。 */
    firstPostTarget?: string;
  } = {}): {
    deps: CommentSchedulerDeps;
    audits: Audit[];
    posted: string[];
    envelopes: Envelope[];
    dedupChecked: string[];
    dedupRecorded: string[];
    resolvedNames: Array<{ url: string; name: string }>;
    composeArgs: Array<{ keyword: string; container: string; postText?: string; comments?: string[] }>;
    regionResolutionCalls: string[];
  } {
    const audits: Audit[] = [];
    const posted: string[] = [];
    const envelopes: Envelope[] = [];
    const dedupChecked: string[] = [];
    const dedupRecorded: string[] = [];
    const resolvedNames: Array<{ url: string; name: string }> = [];
    const composeArgs: Array<{ keyword: string; container: string; postText?: string; comments?: string[] }> = [];
    const regionResolutionCalls: string[] = [];
    const seen = new Set(cfg.seen ?? []);
    const bus = new EventBus();
    const candidates = cfg.candidates ?? [PERMALINK];
    let resolveCalls = 0;
    const pusher = {
      pushToEdges: (envelope: unknown): number => {
        const env = envelope as Envelope;
        envelopes.push(env);
        posted.push(env.type);
        if (env.type === 'search.execute') {
          if (cfg.searchFail) {
            bus.emit('action.completed', { action: 'search', ok: false, reason: cfg.searchFail, ts: 0 } as never);
          } else {
            bus.emit('page.cards.arrived', {
              cards: candidates.map((p, i) => ({ index: i, noteId: p })),
              ...(cfg.containerName === undefined ? { containerName: 'Puerto Rico Y Sus Encantos e Historia' } : cfg.containerName ? { containerName: cfg.containerName } : {}),
              ts: 0,
            } as never);
          }
        } else if (env.type === 'note.open') {
          const payload = env.payload as { url?: string; selection?: string };
          const url = payload.selection === 'first_commentable_group_post'
            ? cfg.firstPostTarget ?? PERMALINK
            : payload.url;
          if (cfg.openOk === false) {
            bus.emit('action.completed', { action: 'open_note', ok: false, reason: cfg.openReason ?? 'editor_not_found', ts: 0 } as never);
          } else {
            bus.emit('note.detail.arrived', {
              detail: {
                noteId: url,
                title: '',
                content: cfg.postText ?? '',
                likeCount: 0,
                collectCount: 0,
                ...(cfg.comments ? { comments: cfg.comments } : {}),
              },
              ts: 0,
            } as never);
          }
        } else if (env.type === 'interaction.comment') {
          const s = cfg.submit ?? { ok: true };
          bus.emit('action.completed', { action: 'comment', ok: s.ok, ...(s.reason ? { reason: s.reason } : {}), ts: 0 } as never);
        }
        return 1;
      },
    };
    const deps = baseDeps({
      getPlatform: () => 'facebook',
      resolveConnection: () => {
        resolveCalls += 1;
        // dropAfterTrigger：首调（triggerManual 在线闸）给连接，其后（真发内 re-resolve）返回 null。
        if (cfg.dropAfterTrigger && resolveCalls > 1) return null;
        return { bus, edgeId: 'e-fb' };
      },
      pusher,
      stepTimeoutMs: 60, // 有界超时；任何未 emit 的等待 60ms 后诚实超时（不 28s 挂死测试）
      random: () => 0,
      dedupFor: () => ({
        hasInteracted: async (noteId: string) => {
          dedupChecked.push(noteId);
          return seen.has(noteId);
        },
        recordInteraction: async (noteId: string) => {
          dedupRecorded.push(noteId);
          seen.add(noteId);
        },
      }),
      facebookConfigFor: () => ({
        enabled: true,
        keywords: cfg.keywords ?? ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/legacy-config' }],
        commentMode: cfg.commentMode ?? 'generated',
        commentTemplates: cfg.commentTemplates ?? [],
      }),
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: (cfg.coverageContainers ?? ['https://www.facebook.com/groups/1']).length > 0,
        keywords: cfg.keywords ?? ['咖啡'],
        containers: (cfg.coverageContainers ?? ['https://www.facebook.com/groups/1']).map((url) => ({ url })),
        commentMode: cfg.commentMode ?? 'generated',
        commentTemplates: cfg.commentTemplates ?? [],
        ...(cfg.coverageRelaxed ? { relaxed: true } : {}),
      }),
      facebookRegionCommentTemplatesForGroup: async (groupUrl) => {
        regionResolutionCalls.push(groupUrl);
        if (cfg.regionalFailure) return { ok: false, reason: cfg.regionalFailure };
        return {
          ok: true,
          region: '河南区域',
          commentTemplates: cfg.regionalTemplates ?? ['这家区域咖啡很不错'],
        };
      },
      facebookResolveContainerName: async (_acct: string, url: string, name: string) => {
        resolvedNames.push({ url, name });
      },
      facebookCompose: async (_a: string, ctx: { keyword: string; container: string; postText?: string; comments?: string[] }) => {
        composeArgs.push(ctx);
        return '这家手冲咖啡很不错';
      },
      facebookCanComment: async () => true,
      facebookAudit: (row) => audits.push(row),
    });
    return {
      deps,
      audits,
      posted,
      envelopes,
      dedupChecked,
      dedupRecorded,
      resolvedNames,
      composeArgs,
      regionResolutionCalls,
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 120));

  it('happy path：搜索→开帖→提交确认 → commented，三命令依次下发，提交前打去重标记', async () => {
    const { deps, audits, posted, dedupRecorded, resolvedNames } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    // §5.4 防重复真发：提交派发前已打 attempted 去重标记（与成功计数解耦）。
    assert.deepEqual(dedupRecorded, [PERMALINK]);
    // 群名自动回填：边缘回传真名 → 调 resolveContainerName（url→真名）；审计用群名、不用 id。
    assert.deepEqual(resolvedNames, [{ url: 'https://www.facebook.com/groups/1', name: 'Puerto Rico Y Sus Encantos e Historia' }]);
    assert.equal(audits.at(-1)?.container, 'Puerto Rico Y Sus Encantos e Historia');
  });

  it('空关键词：直接取群内首帖→评论，不发 search.execute、不回退搜索', async () => {
    const { deps, audits, posted, envelopes, dedupRecorded, composeArgs } = fbFlowDeps({
      keywords: [],
      submit: { ok: true },
      postText: '群内首帖正文',
      comments: ['首帖评论'],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['note.open', 'interaction.comment']);
    const open = envelopes.find((env) => env.type === 'note.open');
    assert.equal(open?.payload.selection, 'first_commentable_group_post');
    assert.equal(open?.payload.container, 'https://www.facebook.com/groups/1');
    assert.equal(open?.payload.url, undefined);
    assert.deepEqual(dedupRecorded, [PERMALINK]);
    assert.equal(composeArgs[0].keyword, '');
    assert.equal(composeArgs[0].postText, '群内首帖正文');
    assert.deepEqual(composeArgs[0].comments, ['首帖评论']);
  });

  it('空关键词 permalinkless 首帖：targetRef 贯穿去重、审批和提交', async () => {
    const targetRef = `aidcp:facebook-group-feed-post:v1:${'c3'.repeat(32)}`;
    const { deps, audits, posted, envelopes, dedupRecorded } = fbFlowDeps({
      keywords: [],
      firstPostTarget: targetRef,
      submit: { ok: true },
      postText: '群内没有 permalink 的首帖正文',
    });
    const approvals: string[] = [];
    await new CommentScheduler({
      ...deps,
      approval: {
        request: async (request) => { approvals.push(request.noteId); },
        isApproved: async () => true,
        timeoutMs: 20,
        pollMs: 1,
      },
    }).triggerManual('fb-1');
    await tick();

    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['note.open', 'interaction.comment']);
    assert.deepEqual(approvals, [targetRef]);
    assert.equal(envelopes.find((env) => env.type === 'interaction.comment')?.payload.noteId, targetRef);
    assert.deepEqual(dedupRecorded, [targetRef]);
  });

  it('consumption mode pins one historical group, ignores configured keywords, and requires both exact-target hooks before submit', async () => {
    const { deps, posted, envelopes } = fbFlowDeps({
      keywords: ['must-not-search'],
      submit: { ok: true },
      postText: 'historical group first post',
    });
    const phases: string[] = [];
    let genericCoverageWrites = 0;
    const result = await new CommentScheduler({
      ...deps,
      facebookCoverageOnCommented: async () => {
        genericCoverageWrites += 1;
      },
    }).triggerForMode('fb-1', {
      source: 'consumption',
      groupUrl: 'https://www.facebook.com/groups/historical-1',
      selection: 'first_commentable_group_post',
      actionGate: () => ({ allowed: true }),
      onTargetSelected: (target) => {
        phases.push('target');
        assert.deepEqual(posted, ['note.open']);
        assert.deepEqual(target, {
          accountId: 'fb-1',
          groupUrl: 'https://www.facebook.com/groups/historical-1',
          contentKey: '2',
          contentUrl: PERMALINK,
          selection: 'first_commentable_group_post',
        });
      },
      onBeforeSubmit: (target) => {
        phases.push('dispatch');
        assert.equal(target.contentUrl, PERMALINK);
        assert.deepEqual(posted, ['note.open']);
      },
    });

    assert.equal(result.triggered, true);
    if (!result.triggered) return;
    assert.equal(result.result.outcome, 'commented');
    assert.deepEqual(phases, ['target', 'dispatch']);
    assert.deepEqual(posted, ['note.open', 'interaction.comment']);
    assert.equal(envelopes.some((env) => env.type === 'search.execute'), false);
    const open = envelopes.find((env) => env.type === 'note.open');
    assert.equal(open?.payload.selection, 'first_commentable_group_post');
    assert.equal(open?.payload.container, 'https://www.facebook.com/groups/historical-1');
    assert.equal(open?.payload.joinFirst, undefined);
    assert.equal(
      genericCoverageWrites,
      0,
      'consumption coordinator owns the awaited membership cooldown write',
    );
  });

  it('consumption mode fails closed when the bound first commentable item is already deduped', async () => {
    const {
      deps,
      posted,
      envelopes,
      dedupChecked,
      dedupRecorded,
      composeArgs,
    } = fbFlowDeps({
      keywords: ['must-not-search'],
      seen: [PERMALINK],
      submit: { ok: true },
    });
    let selected = 0;
    let beforeSubmit = 0;
    const result = await new CommentScheduler(deps).triggerForMode('fb-1', {
      source: 'consumption',
      groupUrl: 'https://www.facebook.com/groups/historical-dedup',
      selection: 'first_commentable_group_post',
      actionGate: () => ({ allowed: true }),
      onTargetSelected: (target) => {
        selected += 1;
        assert.equal(target.contentUrl, PERMALINK);
      },
      onBeforeSubmit: () => {
        beforeSubmit += 1;
      },
    });

    assert.equal(result.triggered, true);
    if (!result.triggered) return;
    assert.equal(result.result.outcome, 'no_strong_candidate');
    assert.equal(result.result.reason, 'all_deduped');
    assert.equal(selected, 1, 'the exact first item is bound before its dedupe gate runs');
    assert.equal(beforeSubmit, 0);
    assert.deepEqual(dedupChecked, [PERMALINK]);
    assert.deepEqual(posted, ['note.open']);
    assert.equal(envelopes.some((env) => env.type === 'interaction.comment'), false);
    assert.deepEqual(composeArgs, [], 'dedupe rejection must stop before composition');
    assert.deepEqual(dedupRecorded, [], 'a read-side dedupe hit must not write another marker');
  });

  it('consumption mode before-submit veto performs zero comment writes for a page-scoped exact targetRef', async () => {
    const targetRef = `aidcp:facebook-group-feed-post:v1:${'d4'.repeat(32)}`;
    const { deps, posted, envelopes } = fbFlowDeps({
      keywords: ['must-not-search'],
      firstPostTarget: targetRef,
      submit: { ok: true },
    });
    let selected = '';
    const result = await new CommentScheduler(deps).triggerForMode('fb-1', {
      source: 'consumption',
      groupUrl: 'https://www.facebook.com/groups/historical-2',
      selection: 'first_commentable_group_post',
      actionGate: () => ({ allowed: true }),
      onTargetSelected: (target) => {
        selected = target.contentKey;
        assert.equal(target.contentUrl, targetRef);
      },
      onBeforeSubmit: () => false,
    });

    assert.equal(result.triggered, true);
    if (!result.triggered) return;
    assert.equal(selected, targetRef);
    assert.equal(result.result.outcome, 'submit_failed');
    assert.equal(
      result.result.reason,
      'dispatch_suppressed:consumption_before_submit_rejected',
    );
    assert.deepEqual(posted, ['note.open']);
    assert.equal(envelopes.some((env) => env.type === 'interaction.comment'), false);
    assert.equal(envelopes.some((env) => env.type === 'search.execute'), false);
  });

  it('consumption mode re-reads the final risk gate after target selection and sends zero submit commands when it closes', async () => {
    const { deps, posted } = fbFlowDeps({
      keywords: ['must-not-search'],
      submit: { ok: true },
    });
    let targetSelected = false;
    let beforeSubmit = false;
    const result = await new CommentScheduler(deps).triggerForMode('fb-1', {
      source: 'consumption',
      groupUrl: 'https://www.facebook.com/groups/historical-risk',
      selection: 'first_commentable_group_post',
      actionGate: () => ({ allowed: false, reason: 'quota:day' }),
      onTargetSelected: () => {
        targetSelected = true;
      },
      onBeforeSubmit: () => {
        beforeSubmit = true;
      },
    });

    assert.equal(result.triggered, true);
    if (!result.triggered) return;
    assert.equal(targetSelected, true);
    assert.equal(beforeSubmit, false, 'risk gate must run before durable dispatch CAS');
    assert.equal(result.result.outcome, 'quota_denied');
    assert.equal(result.result.reason, 'quota:day');
    assert.deepEqual(posted, ['note.open']);
  });

  it('空关键词首帖已评过：不顺延第二帖、不搜索、不提交', async () => {
    const { deps, audits, posted, dedupRecorded } = fbFlowDeps({
      keywords: [],
      seen: [PERMALINK],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'no_strong_candidate');
    assert.equal(audits.at(-1)?.reason, 'all_deduped');
    assert.deepEqual(posted, ['note.open']);
    assert.deepEqual(dedupRecorded, []);
  });

  // ── change facebook-manual-comment-keepopen-lease：keep-open 租约贯穿人审、三命令透传 taskId ──
  it('keep-open 租约包住 search→open→submit（kind=comment_prepare 单次），三命令都带 lease taskId', async () => {
    const base = fbFlowDeps({ submit: { ok: true } });
    const leaseReqs: Array<{ kind: string; priority: string; leaseMs?: number }> = [];
    const deps: CommentSchedulerDeps = {
      ...base.deps,
      edgeTaskLeases: {
        withLease: async (request, work) => {
          leaseReqs.push({ kind: request.kind, priority: request.priority, leaseMs: request.leaseMs });
          return work({ taskId: 'fb-task-1', edgeId: request.edgeId, kind: request.kind, priority: request.priority });
        },
      },
    };
    await new CommentScheduler(deps).triggerManual('fb-1', { manualOverride: true });
    await tick();
    assert.equal(base.audits.at(-1)?.outcome, 'commented');
    // 全段只申请一次 comment_prepare 租约（不是每步各申请）
    assert.deepEqual(leaseReqs.map((r) => r.kind), ['comment_prepare']);
    // 手动操作员命令 → human priority
    assert.equal(leaseReqs[0].priority, 'human');
    // leaseMs 必须严格 > 撰写(~180s LLM 天花板) + 人审(90s)：否则边端 idle 计时在 note.open→comment 的纯云窗内过期、
    // 解冻自治浏览把页面滚走、已授权评论提交被挡（对抗复核 wf_933f178c）。
    assert.ok((leaseReqs[0].leaseMs ?? 0) > 180_000 + 90_000, `keep-open leaseMs 必须严格覆盖撰写+人审最坏耗时，实际=${leaseReqs[0].leaseMs}`);
    // 三条命令都带 lease taskId（否则边端持租约期把评论自己的命令也挡死 → 自锁）
    for (const t of ['search.execute', 'note.open', 'interaction.comment']) {
      const env = base.envelopes.find((e) => e.type === t);
      assert.ok(env, `应下发 ${t}`);
      assert.equal((env!.payload as { taskId?: string }).taskId, 'fb-task-1', `${t} 必须带 lease taskId`);
    }
  });

  it('自动路径（无 manualOverride）→ 租约 priority=automatic', async () => {
    const base = fbFlowDeps({ submit: { ok: true } });
    const priorities: string[] = [];
    const deps: CommentSchedulerDeps = {
      ...base.deps,
      edgeTaskLeases: {
        withLease: async (request, work) => {
          priorities.push(request.priority);
          return work({ taskId: 'fb-task-2', edgeId: request.edgeId, kind: request.kind, priority: request.priority });
        },
      },
    };
    await new CommentScheduler(deps).triggerManual('fb-1'); // 无 manualOverride
    await tick();
    assert.deepEqual(priorities, ['automatic']);
  });

  it('租约 acquire 超时 → 诚实非提交（不 commented、不下发搜索、不打去重），绝不静默假成功', async () => {
    const base = fbFlowDeps({ submit: { ok: true } });
    let searchCommands = 0;
    const deps: CommentSchedulerDeps = {
      ...base.deps,
      pusher: { pushToEdges: (env: unknown) => { if ((env as Envelope).type === 'search.execute') searchCommands++; return 1; } },
      edgeTaskLeases: {
        withLease: async () => { throw new EdgeTaskLeaseError('acquire_timeout', 'edge task acquire timeout taskId=t edge=e-fb'); },
      },
    };
    await new CommentScheduler(deps).triggerManual('fb-1', { manualOverride: true });
    await tick();
    assert.equal(searchCommands, 0, '拿不到租约 → 不下发搜索');
    assert.notEqual(base.audits.at(-1)?.outcome, 'commented');
    assert.equal(base.dedupRecorded.length, 0, '未提交 → 不打去重（可重试）');
  });

  // ── Feature A：所有 FB 评论按结构化账号/来源策略审批，环境变量不能放宽 ──
  it('Feature A 默认开：非联系评论也需人审——审批口未接线 → 不提交（compose_skipped/approval_rejected_or_timeout），绝不裸发', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, approval: undefined }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'approval_rejected_or_timeout');
    assert.ok(!posted.includes('interaction.comment'), '未接线人审 → 绝不提交评论');
  });

  it('旧 AIDCP_FB_COMMENT_REVIEW_ALL=false 不能关闭人审', async () => {
    const previous = process.env.AIDCP_FB_COMMENT_REVIEW_ALL;
    process.env.AIDCP_FB_COMMENT_REVIEW_ALL = 'false';
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    try {
      await new CommentScheduler({ ...deps, approval: undefined }).triggerManual('fb-1');
      await tick();
      assert.equal(audits.at(-1)?.reason, 'approval_rejected_or_timeout');
      assert.deepEqual(posted, ['search.execute', 'note.open']);
    } finally {
      if (previous === undefined) delete process.env.AIDCP_FB_COMMENT_REVIEW_ALL;
      else process.env.AIDCP_FB_COMMENT_REVIEW_ALL = previous;
    }
  });

  it('Feature A 红线：manualOverride 只绕配额、绝不绕人审——无 approval 仍不提交', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, approval: undefined }).triggerManual('fb-1', { manualOverride: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'approval_rejected_or_timeout');
    assert.ok(!posted.includes('interaction.comment'), 'manualOverride 不绕人审 → 无 approval 时绝不提交');
  });

  it('账号全局免审覆盖飞书手工 /comment：旁路通知、无按钮审批、仍走真实提交确认', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    const notices: any[] = [];
    let reviewCalled = false;
    await new CommentScheduler({
      ...deps,
      approval: { request: async () => { reviewCalled = true; }, isApproved: async () => false },
      resolveApprovalMode: async (_accountId, sourceMode) => {
        assert.equal(sourceMode, 'review');
        return 'auto_approve';
      },
      autoApproveNotify: async (input) => { notices.push(input); },
    }).triggerManual('fb-1', { manualOverride: true, originChatId: 'oc_command' });
    await tick();
    assert.equal(reviewCalled, false);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].originChatId, 'oc_command');
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.ok(posted.includes('interaction.comment'));
  });

  it('账号全局免审覆盖飞书手工 /comment：通知失败仍提交，不回退按钮审批', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    let reviewCalled = false;
    await new CommentScheduler({
      ...deps,
      approval: { request: async () => { reviewCalled = true; }, isApproved: async () => false },
      resolveApprovalMode: async () => 'auto_approve',
      autoApproveNotify: async () => { throw new Error('chat unavailable'); },
    }).triggerManual('fb-1', { manualOverride: true, originChatId: 'oc_command' });
    await tick();
    assert.equal(reviewCalled, false);
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.ok(posted.includes('interaction.comment'));
  });

  // ── change manual-comment-force-flag：FB --force 跳过 weak_relevance（仍守内容安全校验 + 人审 + 放开每帖去重） ──
  it('FB 无 --force + 零重叠草稿 → weak_relevance、不发（默认路径零回归）', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookCompose: async () => '天气不错今天' }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'weak_relevance', '零重叠 → 默认路径判 weak_relevance');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('FB --force → 跳过 weak_relevance：零重叠草稿也过相关性闸，经人审后真发 commented', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookCompose: async () => '天气不错今天' }).triggerManual('fb-1', { force: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented', '--force 跳过 weak_relevance → 过相关性闸、人审通过后真发');
    assert.ok(posted.includes('interaction.comment'));
  });

  it('FB --force 不放开内容安全校验 → 含链接草稿仍 compose_skipped/contains_url，绝不发', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookCompose: async () => '好文 https://spam.example 推荐' }).triggerManual('fb-1', { force: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'contains_url', 'force 只放开相关性，链接安全校验照拦');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('FB --force 放开每帖去重 → 已评过的帖也能再评（默认路径 all_deduped 不评）', async () => {
    // 无 force：唯一候选已评过 → all_deduped、不评。
    {
      const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true }, seen: [PERMALINK] });
      await new CommentScheduler(deps).triggerManual('fb-1');
      await tick();
      assert.equal(audits.at(-1)?.outcome, 'no_strong_candidate');
      assert.equal(audits.at(-1)?.reason, 'all_deduped');
      assert.ok(!posted.includes('interaction.comment'));
    }
    // force：放开去重 → 取第一个候选、再评成功。
    {
      const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true }, seen: [PERMALINK] });
      await new CommentScheduler(deps).triggerManual('fb-1', { force: true });
      await tick();
      assert.equal(audits.at(-1)?.outcome, 'commented', '--force 放开去重 → 已评过的帖再评');
      assert.ok(posted.includes('interaction.comment'));
    }
  });

  it('Feature A：非联系人审卡文本 = 纯正文、无尾部换行 / 无联系方式', async () => {
    const { deps, audits } = fbFlowDeps({ submit: { ok: true } });
    const cards: string[] = [];
    await new CommentScheduler({
      ...deps,
      approval: { request: async (r) => { cards.push(r.text); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(cards[0], '这家手冲咖啡很不错');
  });

  it('joined-group coverage：账号启用但无 eligible joined group → no_targets，绝不回退配置容器', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({
      ...deps,
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: false,
        keywords: ['咖啡'],
        containers: [],
        commentMode: 'generated',
        commentTemplates: [],
      }),
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'no_targets');
    assert.deepEqual(posted, []);
  });

  it('joined-group coverage：从 ledger 容器搜索，成功后回写 coverage cursor', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({ submit: { ok: true } });
    const marked: Array<{ accountId: string; groupUrl: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: true,
        keywords: ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/joined-1' }],
        commentMode: 'generated',
        commentTemplates: [],
      }),
      facebookCoverageOnCommented: async (accountId, groupUrl) => {
        marked.push({ accountId, groupUrl });
      },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(envelopes.find((e) => e.type === 'search.execute')?.payload.container, 'https://www.facebook.com/groups/joined-1');
    assert.deepEqual(marked, [{ accountId: 'fb-1', groupUrl: 'https://www.facebook.com/groups/joined-1' }]);
  });

  it('放开时限兜底：coverage relaxed=true → 人审卡标题标注「未满足冷却/预热」交人把关', async () => {
    const { deps, audits } = fbFlowDeps({ submit: { ok: true } });
    const titles: string[] = [];
    await new CommentScheduler({
      ...deps,
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: true,
        keywords: ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/joined-1' }],
        commentMode: 'generated',
        commentTemplates: [],
        relaxed: true,
      }),
      approval: { request: async (r) => { titles.push(r.title ?? ""); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.match(titles[0]!, /未满足冷却\/预热/);
    assert.match(titles[0]!, /放开时限选群/);
  });

  it('放开时限兜底：coverage relaxed 缺省 → 人审卡标题不带警示（零回归）', async () => {
    const { deps, audits } = fbFlowDeps({ submit: { ok: true } });
    const titles: string[] = [];
    await new CommentScheduler({
      ...deps,
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: true,
        keywords: ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/joined-1' }],
        commentMode: 'generated',
        commentTemplates: [],
      }),
      approval: { request: async (r) => { titles.push(r.title ?? ""); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.ok(!/未满足冷却/.test(titles[0]!), '非 relaxed 不应带警示');
  });

  it('放开时限兜底：relaxed pick 仍受 RiskController 约束——拒绝时不发人审卡', async () => {
    const { deps, audits } = fbFlowDeps({ submit: { ok: true } });
    const titles: string[] = [];
    await new CommentScheduler({
      ...deps,
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: true,
        keywords: ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/joined-1' }],
        commentMode: 'generated',
        commentTemplates: [],
        relaxed: true,
      }),
      facebookCanComment: async () => false,
      approval: { request: async (r) => { titles.push(r.title ?? ""); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'quota_denied');
    assert.equal(audits.at(-1)?.reason, 'canDo');
    assert.deepEqual(titles, []);
  });

  it('FB contact comment：正文先过无人值守校验，联系方式只在人审后以 groupChatCode 下发', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({ submit: { ok: true } });
    const approvals: Array<{ noteId: string; text: string }> = [];
    await new CommentScheduler({
      ...deps,
      getContactInfo: async () => 'LINE ID: abc123',
      approval: {
        request: async (r) => {
          approvals.push({ noteId: r.noteId, text: r.text });
        },
        isApproved: async () => true,
        timeoutMs: 20,
        pollMs: 1,
      },
    }).triggerManual('fb-1', { injectContact: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(approvals[0].noteId, PERMALINK);
    assert.equal(approvals[0].text, '这家手冲咖啡很不错\nLINE ID: abc123');
    const submit = envelopes.find((e) => e.type === 'interaction.comment');
    assert.equal(submit?.payload.text, '这家手冲咖啡很不错');
    assert.equal(submit?.payload.groupChatCode, 'LINE ID: abc123');
  });

  it('模板模式：选账号模板作为正文，跳过 facebookCompose，仍走人审和提交', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['这家手冲咖啡很不错'],
    });
    let composeCalled = false;
    const approvals: string[] = [];
    await new CommentScheduler({
      ...deps,
      facebookCompose: async () => {
        composeCalled = true;
        return '模型正文不应使用';
      },
      approval: { request: async (r) => { approvals.push(r.text); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(composeCalled, false);
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(approvals[0], '这家手冲咖啡很不错');
    assert.equal(envelopes.find((e) => e.type === 'interaction.comment')?.payload.text, '这家手冲咖啡很不错');
  });

  it('显式生成模式保持权威，不读取区域通用模板', async () => {
    const { deps, audits, regionResolutionCalls } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'generated',
      commentTemplates: [],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(regionResolutionCalls, []);
  });

  it('模板模式：账号无模板 → 按已选群区域使用通用模板，仍走人审和提交', async () => {
    const { deps, audits, envelopes, regionResolutionCalls } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: [],
      regionalTemplates: ['这家区域咖啡很不错'],
    });
    const approvals: string[] = [];
    await new CommentScheduler({
      ...deps,
      approval: {
        request: async (request) => { approvals.push(request.text); },
        isApproved: async () => true,
        timeoutMs: 20,
        pollMs: 1,
      },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(regionResolutionCalls, ['https://www.facebook.com/groups/1']);
    assert.deepEqual(approvals, ['这家区域咖啡很不错']);
    assert.equal(
      envelopes.find((e) => e.type === 'interaction.comment')?.payload.text,
      '这家区域咖啡很不错',
    );
  });

  for (const reason of ['missing_group_region', 'regional_template_missing'] as const) {
    it(`模板模式：账号无模板且区域解析为 ${reason} → 诚实停止，不搜索不提交`, async () => {
      const { deps, audits, posted } = fbFlowDeps({
        submit: { ok: true },
        commentMode: 'template',
        commentTemplates: [],
        regionalFailure: reason,
      });
      await new CommentScheduler(deps).triggerManual('fb-1');
      await tick();
      assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
      assert.equal(audits.at(-1)?.reason, reason);
      assert.deepEqual(posted, []);
    });
  }

  it('模板模式：模板正文含联系方式照发（运营手写、内容归其负责）', async () => {
    // change facebook-comment-template-blocks：内容政策闸是给无人值守生成文设的——作者是模型、没有能负责的人。
    // 模板的作者是运营本人。2026-07-28 真机：自带电话的招聘模板恒判 contains_contact、整段广告永远发不出去。
    // 用户定案：模板内容不再由系统审查，联系方式与正文并存由人工保证。生成式路径五条内容闸一条不放（见下条）。
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['LINE ID: abc123'],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.ok(posted.includes('interaction.comment'));
  });

  it('生成模式：正文含联系方式仍 contains_contact，绝不靠 contact lane 救回', async () => {
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'generated',
    });
    await new CommentScheduler({
      ...deps,
      facebookCompose: async () => 'LINE ID: abc123',
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'contains_contact');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('模板联系评论：模板正文与账号联系方式分离，人审后以 groupChatCode 下发', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['这家手冲咖啡很不错'],
    });
    const approvals: string[] = [];
    await new CommentScheduler({
      ...deps,
      getContactInfo: async () => 'LINE ID: abc123',
      approval: { request: async (r) => { approvals.push(r.text); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1', { injectContact: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(approvals[0], '这家手冲咖啡很不错\nLINE ID: abc123');
    const submit = envelopes.find((e) => e.type === 'interaction.comment');
    assert.equal(submit?.payload.text, '这家手冲咖啡很不错');
    assert.equal(submit?.payload.groupChatCode, 'LINE ID: abc123');
  });

  it('读了再写：撰写发生在开帖之后，且吃到帖子正文 + 他人评论', async () => {
    const { deps, composeArgs, posted } = fbFlowDeps({
      submit: { ok: true },
      postText: 'Foto de Rio Piedras en los años 50',
      comments: ['Y en esta época están en su máximo esplendor', 'Qué recuerdos'],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    // 撰写只发生一次，且在开帖（note.open）之后（命令序列证明顺序）。
    assert.equal(composeArgs.length, 1);
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    // 撰写器吃到了帖子正文 + 他人评论（读了再写）。
    assert.equal(composeArgs[0].postText, 'Foto de Rio Piedras en los años 50');
    assert.deepEqual(composeArgs[0].comments, ['Y en esta época están en su máximo esplendor', 'Qué recuerdos']);
    assert.equal(composeArgs[0].keyword, '咖啡');
  });

  it('边缘未回传群名 → 不回填、审计退回 url（绝不编造名称）', async () => {
    const { deps, audits, resolvedNames } = fbFlowDeps({ submit: { ok: true }, containerName: null });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(resolvedNames, []);
    assert.equal(audits.at(-1)?.container, 'https://www.facebook.com/groups/1');
  });

  it('提交后无法服务器确认 → verification_ambiguous，但去重标记仍已打（防重复真发）', async () => {
    const { deps, audits, dedupRecorded } = fbFlowDeps({ submit: { ok: false, reason: 'verification_ambiguous' } });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'verification_ambiguous');
    assert.deepEqual(dedupRecorded, [PERMALINK], '即便确认失败，也已标记以防重复真评同一目标');
  });

  it('提交硬失败（如权限门/找不到评论框）→ 不打去重标记，可重试', async () => {
    const { deps, audits, dedupRecorded } = fbFlowDeps({ submit: { ok: false, reason: 'permission_gated' } });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'submit_failed');
    assert.equal(audits.at(-1)?.reason, 'permission_gated');
    // 硬失败没真点提交 → 无重复真发风险 → 不打标记（同一目标可重试）。
    assert.deepEqual(dedupRecorded, []);
  });

  it('搜索遇登录失效 → login_required，不开帖不提交、不打去重', async () => {
    const { deps, audits, posted, dedupRecorded } = fbFlowDeps({ searchFail: 'login_required' });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'login_required');
    assert.deepEqual(posted, ['search.execute']);
    assert.deepEqual(dedupRecorded, []);
  });

  it('容器内无候选 → no_strong_candidate', async () => {
    const { deps, audits, posted } = fbFlowDeps({ candidates: [] });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'no_strong_candidate');
    assert.deepEqual(posted, ['search.execute']);
  });

  it('唯一候选已评过（dedup 命中）→ no_strong_candidate(all_deduped)，绝不重复开帖/提交', async () => {
    const { deps, audits, posted, dedupRecorded } = fbFlowDeps({ seen: [PERMALINK] });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'no_strong_candidate');
    assert.equal(audits.at(-1)?.reason, 'all_deduped');
    assert.deepEqual(posted, ['search.execute']);
    assert.deepEqual(dedupRecorded, [], '已评过的目标不再重复标记/提交');
  });

  it('开帖失败（评论框催不出）→ no_strong_candidate，未提交、未打去重', async () => {
    const { deps, audits, posted, dedupRecorded } = fbFlowDeps({ openOk: false, openReason: 'editor_not_found' });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'no_strong_candidate');
    assert.deepEqual(posted, ['search.execute', 'note.open']);
    assert.deepEqual(dedupRecorded, [], '开帖失败在提交去重标记之前，不占标记');
  });

  it('trigger 后连接掉线 → submit_failed(edge_offline)，绝不下发任何命令', async () => {
    const { deps, audits, posted } = fbFlowDeps({ dropAfterTrigger: true });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'submit_failed');
    assert.equal(audits.at(-1)?.reason, 'edge_offline');
    assert.deepEqual(posted, []);
  });

  // ── change facebook-manual-join-comment：/comment --join 先加群、加入成功后在刚加入的群里评论 ──

  it('加群评论：joined → 在刚加入的群里评论（search 容器 pin 到该群，非配置容器）+ 合并成功卡', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-x';
    const { deps, audits, posted, envelopes } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ ok: boolean; level: string; title: string; message: string; source?: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r, source) => {
        cards.push({ ok: r.ok, level: r.level, title: r.title, message: r.message, source });
      },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.equal(envelopes.find((e) => e.type === 'search.execute')?.payload.container, JOINED);
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    assert.equal(cards.at(-1)?.ok, true);
    assert.equal(cards.at(-1)?.level, 'success');
    assert.match(cards.at(-1)!.title, /加群 \+ 评论成功/);
    assert.equal(cards.at(-1)?.source, undefined, '手动加群评论保持既有 /comment 默认来源');
  });

  it('规则批次加群评论结果卡标注 Facebook 规则模式，不冒充手动 /comment', async () => {
    const { deps } = fbFlowDeps({ submit: { ok: true }, commentMode: 'template', commentTemplates: ['欢迎交流'] });
    const sources: Array<string | undefined> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({
        triggered: true,
        outcome: 'joined',
        groupUrl: 'https://www.facebook.com/groups/rule-source',
      }),
      postResultCard: (_accountId, _receipt, source) => { sources.push(source); },
    }).triggerManual('fb-1', {
      joinFirst: true,
      source: 'facebook_rule_batch',
    });
    await tick();
    assert.equal(sources.at(-1), 'Facebook 规则模式');
  });

  it('规则批次即时闸在加群前失效 → 不加群、不评论，并回传 risk_suppressed 终态', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    let joinCalls = 0;
    const results: Array<{ outcome: string; joinOutcome?: string; reason?: string }> = [];
    const receipt = await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => {
        joinCalls += 1;
        return { triggered: true, outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/blocked' };
      },
    }).triggerManual('fb-1', {
      joinFirst: true,
      actionGate: (action) => action === 'join_group'
        ? { allowed: false, reason: 'slow_start_active' }
        : { allowed: true },
      onResult: (result) => { results.push(result); },
    });
    assert.equal(receipt.ok, true);
    await tick();
    assert.equal(joinCalls, 0);
    assert.deepEqual(posted, []);
    assert.deepEqual(results, [{
      outcome: 'no_targets',
      joinOutcome: 'risk_suppressed',
      reason: 'slow_start_active',
    }]);
  });

  it('规则批次已确认加群后评论闸失效 → 保留 joined，评论 risk_suppressed 且不下发评论', async () => {
    const JOINED = 'https://www.facebook.com/groups/rule-joined';
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    const results: Array<{ outcome: string; joinOutcome?: string; reason?: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
    }).triggerManual('fb-1', {
      joinFirst: true,
      actionGate: (action) => action === 'comment'
        ? { allowed: false, reason: 'comment_quota_exhausted' }
        : { allowed: true },
      onResult: (result) => { results.push(result); },
    });
    await tick();
    assert.deepEqual(posted, []);
    assert.deepEqual(results, [{
      outcome: 'quota_denied',
      reason: 'comment_quota_exhausted',
      joinOutcome: 'joined',
      groupUrl: JOINED,
    }]);
  });

  it('规则批次审批完成后再次现读闸；冷启动接管时不提交已批准评论', async () => {
    const JOINED = 'https://www.facebook.com/groups/rule-approval';
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    let commentGateCalls = 0;
    const results: Array<{ outcome: string; joinOutcome?: string; reason?: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
    }).triggerManual('fb-1', {
      joinFirst: true,
      actionGate: (action) => {
        if (action === 'join_group') return { allowed: true };
        commentGateCalls += 1;
        return commentGateCalls === 1
          ? { allowed: true }
          : { allowed: false, reason: 'slow_start_active' };
      },
      onResult: (result) => { results.push(result); },
    });
    await tick();
    assert.deepEqual(posted, ['search.execute', 'note.open'], '审批前可定位，但最终闸失败后不得提交评论');
    assert.equal(commentGateCalls, 2);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, 'quota_denied');
    assert.equal(results[0]?.reason, 'slow_start_active');
    assert.equal(results[0]?.joinOutcome, 'joined');
    assert.equal((results[0] as { groupUrl?: string }).groupUrl, JOINED);
  });

  // ── Feature B（change facebook-comment-review-and-targeted-join）：/comment --join=<url> 加入指定群再评论 ──
  it('Feature B：--join=<url> → 路由到 facebookJoinSpecificGroup（非 New），容器 pin 到该指定群', async () => {
    const URL = 'https://www.facebook.com/groups/901700573618044';
    const { deps, audits, envelopes } = fbFlowDeps({ submit: { ok: true } });
    let specificArg: string | undefined;
    let newCalled = 0;
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => { newCalled++; return { triggered: true, outcome: 'joined', groupUrl: 'other' }; },
      facebookJoinSpecificGroup: async (_a, url) => { specificArg = url; return { triggered: true, outcome: 'joined', groupUrl: url }; },
    }).triggerManual('fb-1', { joinFirst: true, joinGroupUrl: URL });
    await tick();
    assert.equal(specificArg, URL, '加入的是指定群 url');
    assert.equal(newCalled, 0, '绝不回落到「下一个库内群」');
    assert.equal(envelopes.find((e) => e.type === 'search.execute')?.payload.container, URL);
    assert.equal(audits.at(-1)?.outcome, 'commented');
  });

  it('Feature B：--join=<url> 已是成员（already_member）→ 直接在该群评论', async () => {
    const URL = 'https://www.facebook.com/groups/901700573618044';
    const { deps, audits, envelopes } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({
      ...deps,
      facebookJoinSpecificGroup: async (_a, url) => ({ triggered: true, outcome: 'already_member', groupUrl: url }),
    }).triggerManual('fb-1', { joinFirst: true, joinGroupUrl: URL });
    await tick();
    assert.equal(envelopes.find((e) => e.type === 'search.execute')?.payload.container, URL);
    assert.equal(audits.at(-1)?.outcome, 'commented');
  });

  it('Feature B 红线：--join=<url> 但 facebookJoinSpecificGroup 未接线 → 诚实拒，绝不回落 New、不评论', async () => {
    const URL = 'https://www.facebook.com/groups/901700573618044';
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    let newCalled = 0;
    const r = await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => { newCalled++; return { triggered: true, outcome: 'joined', groupUrl: 'other' }; },
      facebookJoinSpecificGroup: undefined,
    }).triggerManual('fb-1', { joinFirst: true, joinGroupUrl: URL });
    await tick();
    assert.equal(r.ok, false);
    assert.match(r.message, /未接线/);
    assert.equal(newCalled, 0, '未接线时绝不改加其它群');
    assert.deepEqual(posted, [], '不评论');
  });

  it('Feature B：--join=<url> owned_by_other_account → 诚实黄卡、不评论', async () => {
    const URL = 'https://www.facebook.com/groups/901700573618044';
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ ok: boolean; title: string; message: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinSpecificGroup: async () => ({ triggered: false, reason: 'owned_by_other_account' }),
      postResultCard: (_a, r) => { cards.push({ ok: r.ok, title: r.title, message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true, joinGroupUrl: URL });
    await tick();
    assert.equal(cards.at(-1)?.ok, false);
    assert.match(cards.at(-1)!.message, /其他账号/);
    assert.deepEqual(posted, []);
  });

  // ── change manual-comment-bypass-quota：飞书手动 /comment（server.ts 带 manualOverride:true）跳过评论侧配额闸 ──

  it('手动 override：评论 canDo（风控状态/速率）拒也照发 → commented（change manual-comment-bypass-quota）', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookCanComment: async () => false }).triggerManual('fb-1', { manualOverride: true });
    await tick();
    assert.ok(!audits.some((a) => a.outcome === 'quota_denied'), '手动命令绝不因风控/速率配额被拒');
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
  });

  it('普通 /comment 不再被旧 AIDCP_FB_COMMENT_AUTO=false 静默 no-op', async () => {
    const previous = process.env.AIDCP_FB_COMMENT_AUTO;
    process.env.AIDCP_FB_COMMENT_AUTO = 'false';
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    try {
      await new CommentScheduler(deps).triggerManual('fb-1', { manualOverride: true });
      await tick();
      assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    } finally {
      if (previous === undefined) delete process.env.AIDCP_FB_COMMENT_AUTO;
      else process.env.AIDCP_FB_COMMENT_AUTO = previous;
    }
  });

  it('手动 --join：manual 旗标透传加群调度器 + 群内评论侧亦跳过配额（整条链一致，change manual-comment-bypass-quota）', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-manual';
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    let joinOpts: { manual?: boolean } | undefined;
    await new CommentScheduler({
      ...deps,
      facebookCanComment: async () => false, // 评论配额拒 → 验证加群后群内评论侧也被 override 放行
      facebookJoinNewGroup: async (_a, opts) => {
        joinOpts = opts;
        return { triggered: true, outcome: 'joined', groupUrl: JOINED };
      },
    }).triggerManual('fb-1', { joinFirst: true, manualOverride: true });
    await tick();
    assert.equal(joinOpts?.manual, true, '加群调度器收到 manual:true（加群侧亦跳过会话额度/风控配额）');
    assert.equal(audits.at(-1)?.outcome, 'commented', '加群成功后群内评论亦跳过评论配额闸');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
  });

  it('加群评论按人工授权真发并仍过校验/确认', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-y';
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ level: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r) => { cards.push({ level: r.level }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    assert.equal(cards.at(-1)?.level, 'success');
  });

  it('普通 /comment（无 --join）按结构化审批策略运行', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
  });

  it('加群评论：非会员结局（gated_skip）→ 不评论、诚实黄卡、不下发任何评论命令', async () => {
    const { deps, posted, audits } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ ok: boolean; level: string; title: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'gated_skip', groupUrl: 'https://www.facebook.com/groups/gated' }),
      postResultCard: (_a, r) => { cards.push({ ok: r.ok, level: r.level, title: r.title }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.deepEqual(posted, [], '没加入该群 → 绝不评论');
    assert.equal(audits.length, 0, '评论路径根本没跑 → 无评论审计');
    assert.equal(cards.at(-1)?.ok, false);
    assert.equal(cards.at(-1)?.level, 'warning');
    assert.match(cards.at(-1)!.title, /未加入该群/);
  });

  it('加群评论：nav_error → 直接提示打开群页失败，不误报无目标且绝不评论', async () => {
    const { deps, posted, audits } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ ok: boolean; level: string; title: string; message: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'nav_error', groupUrl: 'https://www.facebook.com/groups/nav-failed' }),
      postResultCard: (_a, r) => { cards.push({ ok: r.ok, level: r.level, title: r.title, message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.deepEqual(posted, [], '群页打开失败 → 绝不进入评论链');
    assert.equal(audits.length, 0, '评论路径未启动 → 无评论审计');
    assert.equal(cards.at(-1)?.ok, false);
    assert.equal(cards.at(-1)?.level, 'error');
    assert.match(cards.at(-1)!.title, /加群失败/);
    assert.match(cards.at(-1)!.message, /打开群页失败/);
    assert.doesNotMatch(cards.at(-1)!.message, /没有可加入的新群目标/);
  });

  it('加群评论：账号配置未开启（disabled）→ 不评论、诚实卡指向账号配置', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ message: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: false, reason: 'disabled' }),
      postResultCard: (_a, r) => { cards.push({ message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.deepEqual(posted, []);
    assert.match(cards.at(-1)!.message, /账号自动加群配置未开启/);
  });

  it('加群评论 --contact：正文过无人值守校验、联系方式经人审以 groupChatCode 下发、合并卡标「带联系方式」', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-c';
    const { deps, envelopes } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ level: string; message: string }> = [];
    const approvals: Array<{ text: string }> = [];
    await new CommentScheduler({
      ...deps,
      getContactInfo: async () => 'LINE ID: abc123',
      approval: { request: async (r) => { approvals.push({ text: r.text }); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r) => { cards.push({ level: r.level, message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true, injectContact: true });
    await tick();
    assert.equal(approvals[0].text, '这家手冲咖啡很不错\nLINE ID: abc123');
    const submit = envelopes.find((e) => e.type === 'interaction.comment');
    assert.equal(submit?.payload.groupChatCode, 'LINE ID: abc123');
    assert.equal(cards.at(-1)?.level, 'success');
    assert.match(cards.at(-1)!.message, /带联系方式/);
  });

  it('加群评论 --contact 缺联系方式 → fail-closed，不加群不评论（绝不静默降级）', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    let joinCalled = 0;
    const r = await new CommentScheduler({
      ...deps,
      getContactInfo: async () => null,
      facebookJoinNewGroup: async () => { joinCalled++; return { triggered: true, outcome: 'joined', groupUrl: 'x' }; },
    }).triggerManual('fb-1', { joinFirst: true, injectContact: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /联系方式/);
    assert.equal(joinCalled, 0, '联系方式闸在加群之前 → 缺联系方式绝不加群');
    assert.deepEqual(posted, []);
  });

  it('加群评论：非 Facebook 账号 → 诚实拒（仅支持 Facebook），不调加群、不评论', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    let joinCalled = 0;
    const r = await new CommentScheduler({
      ...deps,
      getPlatform: () => 'xiaohongshu',
      facebookJoinNewGroup: async () => { joinCalled++; return { triggered: false }; },
    }).triggerManual('fb-1', { joinFirst: true });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.match(r.message, /仅支持 Facebook/);
    assert.equal(joinCalled, 0);
    assert.deepEqual(posted, []);
  });

  it('加群评论：评论阶段意外抛出（如配额读崩）→ 真加群后仍回一张诚实卡（绝不静默丢 closure）', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-e';
    const { deps } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ ok: boolean; level: string; title: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookCanComment: async () => { throw new Error('PG down'); }, // 评论阶段抛出
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r) => { cards.push({ ok: r.ok, level: r.level, title: r.title }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.equal(cards.length, 1, '真加群后必须有 closure 卡，绝不静默丢');
    assert.equal(cards[0].ok, false);
    assert.equal(cards[0].level, 'warning');
    assert.match(cards[0].title, /已加群，但未评论/);
  });

  it('加群评论单飞：任务在跑时同账号第二条 /comment 被诚实拒（不并发双驱边端）', async () => {
    const { deps } = fbFlowDeps({ submit: { ok: true } });
    const gate = deferred();
    const s = new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => { await gate.promise; return { triggered: true, outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/j' }; },
      postResultCard: () => {},
    });
    const first = await s.triggerManual('fb-1', { joinFirst: true });
    assert.equal(first.ok, true);
    const second = await s.triggerManual('fb-1');
    assert.equal(second.ok, false);
    assert.match(second.message, /已有评论任务在跑/);
    gate.resolve();
    await tick();
  });

  // ── change facebook-rule-mode-without-persona：评论触发口的人设闸按来源 + 有效正文方案分流 ──
  const JOINED_GROUP = 'https://www.facebook.com/groups/joined-rule';

  it('规则批次 + 模板正文 + 未绑人设 → 放行，且正文照走校验/人审/提交确认（全程不读人设）', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['这家手冲咖啡很不错'],
    });
    const approvals: string[] = [];
    let composeCalled = 0;
    let soulReads = 0;
    const receipt = await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      getSoul: () => { soulReads += 1; throw new Error('no_persona'); },
      facebookCompose: async () => { composeCalled += 1; return '模型正文不应使用'; },
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      approval: { request: async (r) => { approvals.push(r.text); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    assert.equal(receipt.ok, true, '规则批次的模板正文不因未绑人设被拒');
    await tick();
    assert.equal(composeCalled, 0, '模板链路绝不调用生成器');
    assert.equal(soulReads, 0, '模板链路一次都不读人设');
    assert.deepEqual(approvals, ['这家手冲咖啡很不错'], '仍走审批策略');
    assert.equal(audits.at(-1)?.outcome, 'commented', '仍以平台确认为准记真实终态');
    assert.equal(envelopes.find((e) => e.type === 'interaction.comment')?.payload.text, '这家手冲咖啡很不错');
  });

  it('规则批次 + 未显式选择正文方案（默认模板）+ 未绑人设 → 放行并用区域通用模板', async () => {
    const { deps, audits, regionResolutionCalls } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template', // effectiveConfigFor 对「未显式选择」返回的就是 template
      commentTemplates: [],
      regionalTemplates: ['这家区域咖啡很不错'],
    });
    const receipt = await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    assert.equal(receipt.ok, true);
    await tick();
    assert.deepEqual(regionResolutionCalls, [JOINED_GROUP]);
    assert.equal(audits.at(-1)?.outcome, 'commented');
  });

  it('规则批次 + 模板方案但区域模板缺失 → 仍按既有具名停止收敛，绝不回落生成器或任意默认文本', async () => {
    for (const reason of ['missing_group_region', 'regional_template_missing'] as const) {
      const { deps, audits, posted } = fbFlowDeps({
        submit: { ok: true },
        commentMode: 'template',
        commentTemplates: [],
        regionalFailure: reason,
      });
      let composeCalled = 0;
      await new CommentScheduler({
        ...deps,
        personaBinding: () => 'unbound',
        facebookCompose: async () => { composeCalled += 1; return '不该被用到'; },
        facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
        postResultCard: () => {},
      }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
      await tick();
      assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
      assert.equal(audits.at(-1)?.reason, reason);
      assert.equal(composeCalled, 0);
      assert.ok(!posted.includes('interaction.comment'));
    }
  });

  it('规则批次 + 模板正文超长 → 结构校验先拒，绝不提交、绝不报评论成功', async () => {
    // change facebook-comment-template-blocks：内容政策闸（链接/联系方式/@/垃圾短语/相关性）只管无人值守
    // 生成文；运营手写模板不再受审（用户 2026-07-28 定案）。结构闸对模板照旧——这里改用超长正文，
    // 守住本条本来要守的不变量「校验先拒、绝不提交、绝不报成功」。超长是物理约束而非政策：
    // 边端拟人逐字输入跑在有界的平台步预算里，超长正文的结局是打字超时而不是评论发出去。
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['招'.repeat(501)],
    });
    await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'too_long');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('规则批次 + 模板正文带链接/联系方式 → 照发（运营手写、内容归其负责）', async () => {
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['来看看 https://spam.example/promo 电话 0335 610 868'],
    });
    await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.ok(posted.includes('interaction.comment'));
  });

  it('规则批次 + 模板正文 + --contact → 联系方式仍与正文分离注入，人审见合体、提交走 groupChatCode', async () => {
    const { deps, audits, envelopes } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['这家手冲咖啡很不错'],
    });
    const approvals: string[] = [];
    await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      getContactInfo: async () => 'LINE ID: abc123',
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      approval: { request: async (r) => { approvals.push(r.text); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, injectContact: true, source: 'facebook_rule_batch' });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.equal(approvals[0], '这家手冲咖啡很不错\nLINE ID: abc123');
    const submit = envelopes.find((e) => e.type === 'interaction.comment');
    assert.equal(submit?.payload.text, '这家手冲咖啡很不错');
    assert.equal(submit?.payload.groupChatCode, 'LINE ID: abc123');
  });

  it('规则批次 + 显式生成方案 + 未绑人设 → 逐字保持既有拒绝行为，不接管边端、不调生成器', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true }, commentMode: 'generated' });
    let composeCalled = 0;
    let joinCalled = 0;
    const receipt = await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      facebookCompose: async () => { composeCalled += 1; return '不该被用到'; },
      facebookJoinNewGroup: async () => { joinCalled += 1; return { triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }; },
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    assert.equal(receipt.ok, false);
    assert.match(receipt.message, /未绑定人设/);
    await tick();
    assert.equal(composeCalled, 0);
    assert.equal(joinCalled, 0);
    assert.deepEqual(posted, []);
  });

  it('规则批次 + 模板方案：配置在飞行途中被改成显式生成 → 评论段以具名原因收敛，绝不调生成器', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true }, commentMode: 'template', commentTemplates: ['这家手冲咖啡很不错'] });
    let composeCalled = 0;
    let reads = 0;
    const receipt = await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      // 触发口读到 template（放行），真发前再读已变成显式 generated。
      facebookConfigFor: () => {
        reads += 1;
        return {
          enabled: true,
          keywords: ['咖啡'],
          containers: [],
          commentMode: reads === 1 ? 'template' : 'generated',
          commentTemplates: ['这家手冲咖啡很不错'],
        };
      },
      facebookCompose: async () => { composeCalled += 1; return '不该被用到'; },
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED_GROUP }),
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    assert.equal(receipt.ok, true, '触发口按当时的权威读值放行');
    await tick();
    assert.equal(composeCalled, 0, '真发前的方案硬闸挡住生成器');
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'comment_body_scheme_generated');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('例外不外溢：同一账号经飞书手工 /comment（无来源标记）触发，未绑人设仍诚实拒绝', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true }, commentMode: 'template', commentTemplates: ['这家手冲咖啡很不错'] });
    const s = new CommentScheduler({ ...deps, personaBinding: () => 'unbound', postResultCard: () => {} });
    const manual = await s.triggerManual('fb-rule');
    assert.equal(manual.ok, false);
    assert.match(manual.message, /未绑定人设/);
    const manualJoin = await s.triggerManual('fb-rule', { joinFirst: true });
    assert.equal(manualJoin.ok, false);
    assert.match(manualJoin.message, /未绑定人设/);
    // 排期 / 精选定向来源（triggerTargeted）同样不受例外影响。
    const targeted = await s.triggerTargeted('fb-rule', { noteId: 'n1', title: 't' });
    assert.equal(targeted.ok, false);
    assert.equal(targeted.reason, 'needs_persona');
    await tick();
    assert.deepEqual(posted, []);
  });

  it('规则批次但 FB 配置入口未接线 → 方案不可解析，人设闸 fail-closed 照旧拒绝', async () => {
    const { deps } = fbFlowDeps({ submit: { ok: true }, commentMode: 'template' });
    const receipt = await new CommentScheduler({
      ...deps,
      personaBinding: () => 'unbound',
      facebookConfigFor: undefined,
      postResultCard: () => {},
    }).triggerManual('fb-rule', { joinFirst: true, source: 'facebook_rule_batch' });
    assert.equal(receipt.ok, false);
    assert.match(receipt.message, /未绑定人设/);
  });
});

// ── change facebook-manual-join-comment：加群/评论结果卡绝不显裸群 id/URL（回执按群名，见 facebook-scheduled-comment 约定）──
describe('join-comment 结果卡不泄露裸群 id/URL', () => {
  const RAW = 'https://www.facebook.com/groups/1234567890';
  it('humanGroupLabel：裸 URL/群链接/缺失 → 中性占位；真名 → 原样', () => {
    assert.equal(humanGroupLabel(RAW), '目标群');
    assert.equal(humanGroupLabel('https://www.facebook.com/groups/abc?x=1'), '目标群');
    assert.equal(humanGroupLabel(''), '目标群');
    assert.equal(humanGroupLabel(undefined), '目标群');
    assert.equal(humanGroupLabel('Puerto Rico Y Sus Encantos'), 'Puerto Rico Y Sus Encantos');
  });
  it('joinOnlyReceipt（非会员结局）：即便 join 只带裸 groupUrl，卡文案也不含裸链接', () => {
    for (const outcome of ['gated_skip', 'pending', 'ambiguous_skip', 'no_button', 'nav_error', 'join_failed']) {
      const r = joinOnlyReceipt({ triggered: true, outcome, groupUrl: RAW });
      assert.ok(!r.message.includes(RAW), `${outcome} 卡不应含裸群 URL`);
      assert.ok(!r.message.includes('/groups/'), `${outcome} 卡不应含群 id 片段`);
      assert.equal(r.ok, false);
    }
  });
  it('joinCommentReceipt：评论侧容器仍是裸 URL（真名未回填）时 → 占位，不泄露 id', () => {
    const r = joinCommentReceipt({ outcome: 'joined', groupUrl: RAW }, { outcome: 'no_strong_candidate', container: RAW }, false);
    assert.ok(!r.message.includes(RAW));
    assert.ok(!r.message.includes('/groups/'));
    assert.match(r.message, /目标群/);
    assert.equal(r.level, 'warning'); // 加了群没评上 = 黄，绝不染绿
  });
  it('joinCommentReceipt：评论成功且已回填真名 → 卡用真名、绿', () => {
    const r = joinCommentReceipt({ outcome: 'joined' }, { outcome: 'commented', container: 'Café Lovers PR' }, true);
    assert.match(r.message, /Café Lovers PR/);
    assert.match(r.message, /带联系方式/);
    assert.equal(r.level, 'success');
  });
  it('joinCommentReceipt：评论已提交但无法确认上墙 → 黄卡明确已评论、未确认发布结果', () => {
    const r = joinCommentReceipt(
      { outcome: 'joined' },
      { outcome: 'verification_ambiguous', container: 'PR Café' },
      false,
    );
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warning');
    assert.equal(r.title, '已加群，已评论，未确认发布结果');
    assert.match(r.message, /PR Café/);
    assert.match(r.message, /评论已提交/);
    assert.match(r.message, /尚未确认是否上墙/);
    assert.doesNotMatch(r.message, /服务器已确认/);
  });
  it('joinCommentReceipt：提交前失败仍说未评论，不误用已提交文案', () => {
    const r = joinCommentReceipt(
      { outcome: 'joined' },
      { outcome: 'no_strong_candidate', reason: 'editor_not_found', container: 'PR Café' },
      false,
    );
    assert.equal(r.title, '已加群，但未评论');
    assert.doesNotMatch(r.title, /已评论/);
    assert.doesNotMatch(r.message, /评论已提交/);
    assert.match(r.message, /评论入口未就绪或不可用/);
  });

  // change facebook-comment-participation-gate：群参与审批入群闸 = 未上墙、待管理员批准（诚实、非绿、非去重）。
  it('commentOutcomeReason：pending_group_approval → 「待管理员批准、未上墙」人话', () => {
    const msg = commentOutcomeReason({ outcome: 'pending_group_approval' });
    assert.match(msg, /管理员批准/);
    assert.match(msg, /未上墙/);
  });
  it('commentOutcomeReason：首帖打开失败保留具体阶段，不再统一误报为未找到帖子', () => {
    const cases = [
      ['timeout', /读取超时/],
      ['no_candidates', /有界下滚探测后仍未找到/],
      ['editor_not_found', /评论入口未就绪或不可用/],
      ['ambiguous_target', /帖子边界或评论入口不唯一/],
      ['target_context_mismatch', /帖子身份或上下文无法唯一确认/],
      ['all_deduped', /已评论过/],
      ['invalid_target', /目标无效/],
      ['open_failed', /打开失败/],
    ] as const;
    for (const [reason, expected] of cases) {
      const message = commentOutcomeReason({ outcome: 'no_strong_candidate', reason });
      assert.match(message, expected);
      assert.doesNotMatch(message, /群内未找到合适的可评论帖子/);
    }
  });
  it('joinCommentReceipt：评论撞群参与审批闸 → 黄卡（绝不染绿），说明待管理员批准', () => {
    const r = joinCommentReceipt({ outcome: 'joined' }, { outcome: 'pending_group_approval', container: 'PR Café' }, false);
    assert.equal(r.level, 'warning');
    assert.equal(r.ok, false);
    assert.match(r.message, /管理员批准/);
    assert.match(r.message, /PR Café/);
  });

  // change facebook-comment-lifecycle-verify：平台已拒绝 = 确定未上墙、终局（诚实、非绿、非去重、留人工）。
  it('commentOutcomeReason：comment_rejected → 「已拒绝、未上墙、需人工」人话（不与 ambiguous 同文案）', () => {
    const msg = commentOutcomeReason({ outcome: 'comment_rejected' });
    assert.match(msg, /拒绝/);
    assert.match(msg, /未上墙/);
    assert.equal(/无法确认/.test(msg), false, '被拒是确定的，绝不能说成「无法确认」（那读作可能已发出）');
  });
  it('joinCommentReceipt：评论被平台拒绝 → 黄卡（绝不染绿）', () => {
    const r = joinCommentReceipt({ outcome: 'joined' }, { outcome: 'comment_rejected', container: 'PR Café' }, false);
    assert.equal(r.level, 'warning');
    assert.equal(r.ok, false);
    assert.match(r.message, /拒绝/);
    assert.match(r.message, /PR Café/);
  });
  it('🔴 comment_rejected 绝不进 reallySubmitted 去重白名单（被拒没上墙，去重=白烧目标帖）', () => {
    // 与 comment-scheduler.ts 的 `submit.ok || submit.reason === 'verification_ambiguous'` 同源。
    const reallySubmitted = (submit: { ok: boolean; reason?: string }) =>
      submit.ok || submit.reason === 'verification_ambiguous';
    assert.equal(reallySubmitted({ ok: false, reason: 'comment_rejected' }), false, '被拒 → 不打去重、目标帖可留人工');
    // 既有两档语义不变（回归）。
    assert.equal(reallySubmitted({ ok: true }), true);
    assert.equal(reallySubmitted({ ok: false, reason: 'verification_ambiguous' }), true);
    assert.equal(reallySubmitted({ ok: false, reason: 'pending_group_approval' }), false);
  });
});

/**
 * 精选样本读不到 ≠ 精选库是空的（change split-cloud-automation-production-runtime，task 0.6f 吞点②）。
 *
 * 原写法 `selectCurated(...).catch(() => [])` 把「连不上内容域 / 超时 / 对面报错」统统压成
 * 「查过了，一条精选素材都没有」，然后拿零样本照常生成搜索词、照常评论，全程零报错。
 * 降级保留（评论命令不该被精选库拖死），但它必须是**看着具名原因**作的决定。
 */
describe('精选样本读失败：降级可以，冒充「查过了是空的」不行', () => {
  it('精选样本召回抛出 → 任务照跑，但留下带具名 reason 的告警', async () => {
    const bus = new EventBus();
    const warns: string[] = [];
    const cardDone = deferred();
    const s = new CommentScheduler(
      baseDeps({
        resolveConnection: () => ({ bus, edgeId: 'e1' }),
        pusher: fakeEdge(bus),
        curatedSelection: {
          selectSamplesForSearchTerms: async () => {
            throw new ContentPortError('unreachable', 'curated-selection.selectSamplesForSearchTerms');
          },
        },
        approval: { request: async () => {}, isApproved: async () => true },
        postResultCard: () => { cardDone.resolve(); },
        logger: { log: () => {}, warn: (m: string) => { warns.push(m); } },
      }),
    );
    const r = await s.triggerManual('acc-1');
    assert.equal(r.ok, true, '精选样本读不到不该拖死评论命令');
    await cardDone.promise;
    const named = warns.filter((w) => w.includes('reason=unreachable'));
    assert.equal(named.length, 1, '读失败必须以具名原因说出来');
    assert.match(named[0], /未.*确认精选库为空/, '日志必须点明这不是「查过了是空的」');
  });
});
