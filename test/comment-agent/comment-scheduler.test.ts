/**
 * CommentScheduler 单测（change comment-search-command，最终装配）。
 * 覆盖：边端离线→红、已在跑→黄、触发成功→绿、happy path 端到端跑通（接管/恢复成对 + 结果卡片 success）、
 * outcomeToReceipt 各结果 → level 映射（失败/未产出绝不染绿）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentScheduler, outcomeToReceipt, humanGroupLabel, joinOnlyReceipt, joinCommentReceipt } from '../../src/comment-agent/comment-scheduler.js';
import { EdgeTaskLeaseError } from '../../src/comm/edge-task-lease-client.js';
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
    edgeTaskLeases: {
      withLease: async (request, work) => work({ taskId: `task-${request.kind}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority }),
    },
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
  type Audit = import('../../src/comment-agent/facebook-comment-audit-store.js').FacebookCommentAuditRow;
  function fbDeps(over: Partial<CommentSchedulerDeps> & {
    keywords?: string[]; containers?: string[]; auto?: boolean; shadow?: boolean;
    commentMode?: 'generated' | 'template'; commentTemplates?: string[];
    compose?: string | null; canComment?: boolean; cap?: number; done?: number;
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
            bus.emit('note.detail.arrived', { detail: { noteId: (e.payload as { url?: string }).url, content: '', comments: ['原评论：手冲咖啡真香'] }, ts: 0 } as never);
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
        enabled: (over.keywords ?? ['咖啡']).length > 0 && ((over.commentMode ?? 'generated') === 'generated' || (over.commentTemplates ?? []).length > 0),
        keywords: over.keywords ?? ['咖啡'],
        containers: (over.containers ?? ['g1']).map((u) => ({ url: u })),
        commentMode: over.commentMode ?? 'generated',
        commentTemplates: over.commentTemplates ?? [],
      }),
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: (over.keywords ?? ['咖啡']).length > 0 && (over.containers ?? ['g1']).length > 0,
        keywords: over.keywords ?? ['咖啡'],
        containers: (over.containers ?? ['g1']).map((u) => ({ url: u })),
        commentMode: over.commentMode ?? 'generated',
        commentTemplates: over.commentTemplates ?? [],
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

  it('影子模式：只读浏览（搜+开帖）+撰写+校验通过 → 审计 shadow_ok，但绝不下发提交命令', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true });
    const r = await new CommentScheduler(deps).triggerManual('fb-1');
    assert.equal(r.ok, true);
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'shadow_ok');
    assert.equal(audits.at(-1)?.shadow, true);
    // 读了再写：影子会搜+开帖（只读），但绝不下发 interaction.comment（不提交）。
    assert.deepEqual(posted, ['search.execute', 'note.open']);
    assert.ok(!posted.includes('interaction.comment'), '影子绝不下发提交命令');
  });

  it('无 eligible joined group → fail-closed 审计 no_targets，浏览前即停、不发', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true, containers: [] });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'no_targets');
    assert.deepEqual(posted, []);
  });

  it('校验器拒（含链接）→ 审计 compose_skipped（只拒不修），绝不提交', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true, compose: '好文 https://spam.example 推荐' });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'contains_url');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('撰写为空 → compose_skipped(empty_compose)，绝不提交', async () => {
    const { deps, audits, posted } = fbDeps({ shadow: true, compose: null });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'empty_compose');
    assert.ok(!posted.includes('interaction.comment'));
  });

  it('kill switch 全关（auto=false, shadow=false）→ 静默不跑、无审计、不发', async () => {
    const { deps, audits, posted } = fbDeps({ auto: false, shadow: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.deepEqual(audits, []);
    assert.deepEqual(posted, []);
  });

  // 注：以下两个 quota_denied 测试**不带** manualOverride → 模型的是「自动排期评论」路径（ContentScheduler 的 priority:automatic 调用），
  // 此路径配额闸照旧。飞书手动 /comment 由 server.ts 显式带 manualOverride:true（见下方 change manual-comment-bypass-quota 用例）。
  it('真发路径 canDo 拒 → quota_denied，不发（自动路径：无 manualOverride）', async () => {
    const { deps, audits, posted } = fbDeps({ auto: true, shadow: false, canComment: false });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'canDo');
    assert.deepEqual(posted, []);
  });

  it('真发路径日上限满 → quota_denied(daily_cap)（自动路径：无 manualOverride）', async () => {
    const { deps, audits } = fbDeps({ auto: true, shadow: false, cap: 2, done: 2 });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits[0].outcome, 'quota_denied');
    assert.equal(audits[0].reason, 'daily_cap');
  });

  // 回归：自动排期评论调用形态（ContentScheduler 传 priority:'automatic'、绝不带 manualOverride，见 server.ts）→ 配额闸照旧生效。
  // 钉死不变量「只有飞书手动出口带 override」：若哪天 auto caller 误带了旗标，此断言会红。
  it('自动调用形态（priority:automatic 无 manualOverride）→ canDo 拒仍 quota_denied，不发', async () => {
    const { deps, audits, posted } = fbDeps({ auto: true, shadow: false, canComment: false });
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
  type Audit = import('../../src/comment-agent/facebook-comment-audit-store.js').FacebookCommentAuditRow;
  const PERMALINK = 'https://www.facebook.com/groups/1/posts/2';

  /** FB 真发流水线的假边端：按命令类型 emit 对应上报到同一私有总线；可配搜索失败/开帖失败/提交结果/候选集。 */
  function fbFlowDeps(cfg: {
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
    /** 连接在 trigger 通过后掉线：resolveConnection 首次（trigger 闸）返回连接、其后（真发内）返回 null。 */
    dropAfterTrigger?: boolean;
    /** 边缘回传的真实群名（undefined=默认 PR 群名，null=不回传）。 */
    containerName?: string | null;
    /** 开帖回读的帖子正文/他人评论（读了再写：喂给撰写器）。 */
    postText?: string;
    comments?: string[];
  } = {}): {
    deps: CommentSchedulerDeps;
    audits: Audit[];
    posted: string[];
    envelopes: Envelope[];
    dedupRecorded: string[];
    resolvedNames: Array<{ url: string; name: string }>;
    composeArgs: Array<{ keyword: string; container: string; postText?: string; comments?: string[] }>;
  } {
    const audits: Audit[] = [];
    const posted: string[] = [];
    const envelopes: Envelope[] = [];
    const dedupRecorded: string[] = [];
    const resolvedNames: Array<{ url: string; name: string }> = [];
    const composeArgs: Array<{ keyword: string; container: string; postText?: string; comments?: string[] }> = [];
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
          const url = (env.payload as { url?: string }).url;
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
        hasInteracted: async (noteId: string) => seen.has(noteId),
        recordInteraction: async (noteId: string) => {
          dedupRecorded.push(noteId);
          seen.add(noteId);
        },
      }),
      facebookConfigFor: () => ({
        enabled: true,
        keywords: ['咖啡'],
        containers: [{ url: 'https://www.facebook.com/groups/legacy-config' }],
        commentMode: cfg.commentMode ?? 'generated',
        commentTemplates: cfg.commentTemplates ?? [],
      }),
      facebookCoverageConfigFor: () => ({
        coverageEnabled: true,
        enabled: (cfg.coverageContainers ?? ['https://www.facebook.com/groups/1']).length > 0,
        keywords: ['咖啡'],
        containers: (cfg.coverageContainers ?? ['https://www.facebook.com/groups/1']).map((url) => ({ url })),
        commentMode: cfg.commentMode ?? 'generated',
        commentTemplates: cfg.commentTemplates ?? [],
        ...(cfg.coverageRelaxed ? { relaxed: true } : {}),
      }),
      facebookAutoEnabled: () => true,
      facebookShadow: () => false,
      facebookResolveContainerName: async (_acct: string, url: string, name: string) => {
        resolvedNames.push({ url, name });
      },
      facebookCompose: async (_a: string, ctx: { keyword: string; container: string; postText?: string; comments?: string[] }) => {
        composeArgs.push(ctx);
        return '这家手冲咖啡很不错';
      },
      facebookCanComment: async () => true,
      facebookDailyCap: () => 5,
      facebookCommentedToday: async () => 0,
      facebookAudit: (row) => audits.push(row),
    });
    return { deps, audits, posted, envelopes, dedupRecorded, resolvedNames, composeArgs };
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

  // ── change facebook-manual-comment-keepopen-lease：keep-open 租约贯穿人审、三命令透传 taskId ──
  it('keep-open 租约包住 search→open→submit（kind=comment_prepare 单次），三命令都带 lease taskId', async () => {
    const base = fbFlowDeps({ submit: { ok: true } });
    const leaseReqs: Array<{ kind: string; priority: string }> = [];
    const deps: CommentSchedulerDeps = {
      ...base.deps,
      edgeTaskLeases: {
        withLease: async (request, work) => {
          leaseReqs.push({ kind: request.kind, priority: request.priority });
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

  // ── Feature A（change facebook-comment-review-and-targeted-join）：所有 FB 评论走飞书人审（默认开、可 env 关） ──
  it('Feature A 默认开：非联系评论也需人审——审批口未接线 → 不提交（compose_skipped/approval_rejected_or_timeout），绝不裸发', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, approval: undefined }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'approval_rejected_or_timeout');
    assert.ok(!posted.includes('interaction.comment'), '未接线人审 → 绝不提交评论');
  });

  it('Feature A 逃生门：AIDCP_FB_COMMENT_REVIEW_ALL=false → 非联系评论校验后直发、无人审、commented', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, approval: undefined, facebookCommentReviewAll: () => false }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
  });

  it('Feature A 红线：manualOverride 只绕配额、绝不绕人审——无 approval 仍不提交', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, approval: undefined }).triggerManual('fb-1', { manualOverride: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'approval_rejected_or_timeout');
    assert.ok(!posted.includes('interaction.comment'), 'manualOverride 不绕人审 → 无 approval 时绝不提交');
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

  it('放开时限兜底：relaxed pick 仍受日上限约束——超额 → quota_denied、不发人审卡（只放开单群时限、不放开账号日量）', async () => {
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
      facebookDailyCap: () => 2,
      facebookCommentedToday: async () => 5,
      approval: { request: async (r) => { titles.push(r.title ?? ""); }, isApproved: async () => true, timeoutMs: 20, pollMs: 1 },
    }).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'quota_denied');
    assert.equal(audits.at(-1)?.reason, 'daily_cap');
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

  it('模板模式：无模板 → compose_skipped(empty_template)，不搜索不提交', async () => {
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: [],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'compose_skipped');
    assert.equal(audits.at(-1)?.reason, 'empty_template');
    assert.deepEqual(posted, []);
  });

  it('模板模式：模板正文含联系方式 → contains_contact，绝不靠 contact lane 救回', async () => {
    const { deps, audits, posted } = fbFlowDeps({
      submit: { ok: true },
      commentMode: 'template',
      commentTemplates: ['LINE ID: abc123'],
    });
    await new CommentScheduler(deps).triggerManual('fb-1');
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

  it('提交硬失败（如权限门/找不到评论框）→ 不打去重标记，可重试、不白占当日上限', async () => {
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
    const cards: Array<{ ok: boolean; level: string; title: string; message: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r) => { cards.push({ ok: r.ok, level: r.level, title: r.title, message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.equal(envelopes.find((e) => e.type === 'search.execute')?.payload.container, JOINED);
    assert.equal(audits.at(-1)?.outcome, 'commented');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    assert.equal(cards.at(-1)?.ok, true);
    assert.equal(cards.at(-1)?.level, 'success');
    assert.match(cards.at(-1)!.title, /加群 \+ 评论成功/);
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

  it('手动 override：评论日上限满也照发 → commented（change manual-comment-bypass-quota）', async () => {
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookDailyCap: () => 2, facebookCommentedToday: async () => 5 }).triggerManual('fb-1', {
      manualOverride: true,
    });
    await tick();
    assert.ok(!audits.some((a) => a.outcome === 'quota_denied'), '手动命令绝不因评论日上限被拒');
    assert.equal(audits.at(-1)?.outcome, 'commented');
    // 钉住真下发命令序列（不只信审计标签）：证明日上限旁路走到了真提交，绝非「假成功审计」。
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
  });

  it('手动 override 不越权 kill switch：普通 /comment + manualOverride 但 AIDCP_FB_COMMENT_AUTO 关 → 仍静默 no-op（红线：override 只绕配额、不绕 kill switch）', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookAutoEnabled: () => false, facebookShadow: () => false }).triggerManual('fb-1', {
      manualOverride: true,
    });
    await tick();
    assert.deepEqual(posted, [], 'manualOverride 绕的是配额闸；kill switch 关时普通 FB 评论仍不跑（红线保留）');
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

  it('加群评论 override 强制真发：kill switch AIDCP_FB_COMMENT_AUTO 关也评论（人工授权），仍过校验/确认', async () => {
    const JOINED = 'https://www.facebook.com/groups/joined-y';
    const { deps, audits, posted } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ level: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookAutoEnabled: () => false, // 无人值守 kill switch 关
      facebookShadow: () => false,
      facebookJoinNewGroup: async () => ({ triggered: true, outcome: 'joined', groupUrl: JOINED }),
      postResultCard: (_a, r) => { cards.push({ level: r.level }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.equal(audits.at(-1)?.outcome, 'commented', 'override 人工授权路径不受无人值守 kill switch 影响');
    assert.deepEqual(posted, ['search.execute', 'note.open', 'interaction.comment']);
    assert.equal(cards.at(-1)?.level, 'success');
  });

  it('bypass 是范围内的：普通 /comment（无 --join）在 kill switch 关时仍静默 no-op', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    await new CommentScheduler({ ...deps, facebookAutoEnabled: () => false, facebookShadow: () => false }).triggerManual('fb-1');
    await tick();
    assert.deepEqual(posted, [], 'kill switch 关 → 普通 FB 评论不跑（只有 --join 的 pin 容器路径放宽）');
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

  it('加群评论：加群未开启（disabled）→ 不评论、诚实卡指向 AIDCP_FB_GROUP_JOIN_AUTO', async () => {
    const { deps, posted } = fbFlowDeps({ submit: { ok: true } });
    const cards: Array<{ message: string }> = [];
    await new CommentScheduler({
      ...deps,
      facebookJoinNewGroup: async () => ({ triggered: false, reason: 'disabled' }),
      postResultCard: (_a, r) => { cards.push({ message: r.message }); },
    }).triggerManual('fb-1', { joinFirst: true });
    await tick();
    assert.deepEqual(posted, []);
    assert.match(cards.at(-1)!.message, /AIDCP_FB_GROUP_JOIN_AUTO/);
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
});
