/**
 * 验收用例 AC-PROTO-* — 边-云协议契约一致性（云端侧）
 *
 * 守护点：aidcp-cloud/src/comm/protocol.ts 与 aidcp-edge/src/comm/protocol.ts 必须是同一份契约。
 *   本测试用 `Record<MessageType, true>` 穷举全部消息类型——若任一端增删/改名 MessageType
 *   而未同步，该端 `npm run typecheck` 立即失败（缺 key 或多 key）；运行时再校验版本号、
 *   消息总数与信封往返。边缘有一份内容完全一致的对照测试
 *   （aidcp-edge/test/acceptance/protocol-contract.test.ts）。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  makeEnvelope,
  isEnvelope,
  parseEnvelope,
  type MessageType,
  type WelcomePayload,
  type PacingSnapshotPayload,
  type SessionEndPayload,
  type SearchExecutePayload,
  type NoteOpenPayload,
  type InteractionCommentPayload,
  type InteractionFollowPayload,
  type PersonaGeneratePayload,
  type PersonaGenerateResultPayload,
  type PersonaPersistResultPayload,
  type UiSnapshotPayload,
  type EdgeTaskReleasedPayload,
  type PublishCommandResultPayload,
  type PublishApprovalActionPayload,
  type CaptchaAssistClickPayload,
  type CaptchaAssistClickResultPayload,
  type CaptchaAssistTypeReportPayload,
  type PageCardsPayload,
} from '../../src/comm/protocol.js';

/**
 * 全部消息类型的权威穷举（与边缘逐字一致）。
 * 增删消息类型时：① 改 protocol.ts ② 同步本对象 ③ 同步边缘对照测试。
 */
const ALL_MESSAGE_TYPES: Record<MessageType, true> = {
  hello: true, welcome: true,
  'ui.snapshot': true,
  'plan.request': true, 'plan.response': true,
  'select.request': true, 'select.response': true,
  'anchor.get': true, 'anchor.get.result': true, 'anchor.report': true,
  'action.result': true,
  'note.content': true, 'note.ack': true,
  'browse.next': true, 'browse.scroll': true, 'note.open': true, 'note.close': true,
  'search.execute': true, 'session.end': true,
  'session.budget.request': true, 'session.budget': true,
  'risk.canDo': true, 'risk.canDo.result': true, 'risk.record': true, 'risk.record.result': true,
  'risk.captcha_detected': true, 'risk.captcha_cleared': true,
  'captcha.assist.capture': true, 'captcha.assist.snapshot': true,
  'captcha.assist.click': true, 'captcha.assist.click_result': true,
  'edge.task.acquire': true, 'edge.task.acquired': true,
  'edge.task.release': true, 'edge.task.released': true,
  'publish.approval_request': true, 'publish.approval_action': true, 'publish.approval_action.result': true,
  'publish.draft_image_remove': true, 'publish.draft_image_remove.result': true,
  'publish.request': true, 'publish.result': true,
  'publish.command': true, 'publish.command.result': true,
  'page.scroll': true, 'feed.refresh': true, 'pacing.update': true, 'interaction.like': true, 'interaction.collect': true, 'interaction.follow': true,
  'interaction.comment': true, 'interaction.like_comment': true,
  'group.join': true,
  'navigation.back': true, 'note.browse_images': true, 'note.scroll_comments': true, 'profile.open': true,
  'identity.read_current': true, 'identity.read_self_profile': true,
  'page.cards': true, 'note.detail': true, 'profile.detail': true, 'identity.observed': true, 'action.completed': true,
  'notification.open': true, 'notification.browse_comments': true, 'notification.browse_likes': true,
  'notification.browse_follows': true, 'notification.back_home': true,
  'notification.detected': true, 'notification.home': true, 'notification.items': true,
  'persona.generate': true, 'persona.generate.result': true,
  'persona.persist': true, 'persona.persist.result': true,
  'interaction.auth.status': true, 'interaction.sync.batch': true, 'interaction.sync.ack': true,
  'interaction.reply.result': true, 'interaction.reply.result.ack': true,
  'interaction.reply.reconcile': true, 'interaction.reply.reconcile.result': true,
  'interaction.sync.request': true,
  'interaction.reply.send': true, 'interaction.auth.reopen': true,
  'interaction.browser.control': true,
  'interaction.runtime.controls': true,
  'interaction.offboard.command': true, 'interaction.offboard.result': true, 'interaction.offboard.ack': true,
  error: true, ping: true, pong: true,
};
const ALL_TYPES = Object.keys(ALL_MESSAGE_TYPES) as MessageType[];

describe('AC-PROTO 协议契约一致性（cloud）', () => {
  it('AC-PROTO-01 协议版本为 2', () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });

  it('AC-PROTO-02 消息类型总数为 94（增删消息须同步冻结契约 + 本断言）', () => {
    assert.equal(ALL_TYPES.length, 94);
  });

  it('AC-PROTO-03 每个消息类型都能构造合法信封且版本一致', () => {
    for (const type of ALL_TYPES) {
      const env = makeEnvelope(type, `id-${type}`, 1700000000000, {} as never);
      assert.equal(env.type, type);
      assert.equal(env.v, PROTOCOL_VERSION);
      assert.ok(isEnvelope(env), `${type} 应为合法信封`);
    }
  });

  it('AC-PROTO-04 信封 JSON 往返保持等价', () => {
    const env = makeEnvelope('interaction.like', 'rt-1', 1700000000000, { noteId: 'n1', reason: 'r' });
    const back = parseEnvelope(JSON.stringify(env));
    assert.deepEqual(back, env);
  });

  it('AC-PROTO-04B interaction.follow 兼容旧载荷，并保留 Reel noteId', () => {
    const legacy: InteractionFollowPayload = { authorId: 'author-1' };
    const reel: InteractionFollowPayload = {
      authorId: 'author-1',
      noteId: 'https://www.facebook.com/reel/111',
      thinkMs: 1200,
    };
    assert.equal(legacy.noteId, undefined);
    const env = makeEnvelope('interaction.follow', 'follow-1', 1700000000000, reel);
    assert.deepEqual(parseEnvelope(JSON.stringify(env)), env);
    assert.equal((env.payload as InteractionFollowPayload).noteId, reel.noteId);
  });

  it('AC-PROTO-05 坏帧解析返回 null（坏 JSON / 缺字段）', () => {
    assert.equal(parseEnvelope('not json'), null);
    assert.equal(parseEnvelope('{"v":2}'), null);
  });

  it('AC-PROTO-06 welcome.pacing 快照结构化往返：每字段存活（防 payload 静默漂移）', () => {
    // typecheck 的 Record<MessageType> 与 AC-PROTO-02 计数均抓不到 payload 字段漂移，
    // 故对 WelcomePayload.pacing 逐字段断言；样例填满全字段、两端逐字一致。
    const pacing: PacingSnapshotPayload = {
      tempo: 1.3,
      opFloorsMs: {
        action: { minMs: 1500, maxMs: 4000 },
        scroll: { minMs: 500, maxMs: 1500 },
        card_gap: { minMs: 3000, maxMs: 7000 },
        detail_dwell: { minMs: 2500, maxMs: 5000 },
        feed_card_read: { minMs: 450, maxMs: 7000 },
        content_glance: { minMs: 2500, maxMs: 90000 },
        content_read: { minMs: 2500, maxMs: 90000 },
      },
    };
    const welcome: WelcomePayload = { sessionId: 's-1', serverVersion: 'v-test', pacing };
    const env = makeEnvelope('welcome', 'w-1', 1700000000000, welcome);
    const back = parseEnvelope(JSON.stringify(env));
    assert.deepEqual(back, env);
    const p = (back!.payload as WelcomePayload).pacing;
    assert.ok(p, 'pacing 应往返存活');
    assert.equal(p!.tempo, 1.3);
    assert.deepEqual(p!.opFloorsMs.action, { minMs: 1500, maxMs: 4000 });
    assert.deepEqual(p!.opFloorsMs.scroll, { minMs: 500, maxMs: 1500 });
    assert.deepEqual(p!.opFloorsMs.card_gap, { minMs: 3000, maxMs: 7000 });
    assert.deepEqual(p!.opFloorsMs.detail_dwell, { minMs: 2500, maxMs: 5000 });
    assert.deepEqual(p!.opFloorsMs.feed_card_read, { minMs: 450, maxMs: 7000 });
    assert.deepEqual(p!.opFloorsMs.content_glance, { minMs: 2500, maxMs: 90000 });
    assert.deepEqual(p!.opFloorsMs.content_read, { minMs: 2500, maxMs: 90000 });
  });

  it('AC-PROTO-07 session.end 自动续场等待时间往返存活', () => {
    const payload: SessionEndPayload = { reason: 'timeout', autoResumeInMs: 60_000 };
    const env = makeEnvelope('session.end', 'end-1', 1700000000000, payload);
    const back = parseEnvelope(JSON.stringify(env));
    assert.deepEqual((back!.payload as SessionEndPayload).autoResumeInMs, 60_000);
  });

  it('AC-PROTO-08 Facebook 定向评论可选载荷字段往返存活（container / url / selection，防两端静默漂移）', () => {
    // change facebook-scheduled-comment 给 search.execute 加 container?、note.open 加 url?；
    // change facebook-join-contact-first-post 再给 note.open 加 selection?/container?（复用消息、零新增类型）。
    // 两份 protocol.ts 须逐字镜像这两个字段；typecheck 的 MessageType 穷举抓不到可选字段漂移，故此往返断言兜底。
    const search: SearchExecutePayload = {
      keyword: '咖啡',
      container: 'https://www.facebook.com/groups/123456',
      activityId: 'search-activity-1',
      purpose: 'task_targeting',
      scope: 'container',
    };
    const searchBack = parseEnvelope(JSON.stringify(makeEnvelope('search.execute', 's-1', 1700000000000, search)));
    assert.equal((searchBack!.payload as SearchExecutePayload).container, 'https://www.facebook.com/groups/123456');
    assert.equal((searchBack!.payload as SearchExecutePayload).activityId, 'search-activity-1');
    assert.equal((searchBack!.payload as SearchExecutePayload).purpose, 'task_targeting');
    assert.equal((searchBack!.payload as SearchExecutePayload).scope, 'container');

    const open: NoteOpenPayload = { url: 'https://www.facebook.com/groups/123456/posts/999' };
    const openBack = parseEnvelope(JSON.stringify(makeEnvelope('note.open', 'o-1', 1700000000000, open)));
    assert.equal((openBack!.payload as NoteOpenPayload).url, 'https://www.facebook.com/groups/123456/posts/999');

    const firstOpen: NoteOpenPayload = {
      selection: 'first_commentable_group_post',
      container: 'https://www.facebook.com/groups/123456',
    };
    const firstOpenBack = parseEnvelope(JSON.stringify(makeEnvelope('note.open', 'o-2', 1700000000000, firstOpen)));
    assert.equal((firstOpenBack!.payload as NoteOpenPayload).selection, 'first_commentable_group_post');
    assert.equal((firstOpenBack!.payload as NoteOpenPayload).container, 'https://www.facebook.com/groups/123456');
  });

  it('AC-PROTO-08B comment --feed 快返字段往返存活（防两端静默漂移）', () => {
    const payload: InteractionCommentPayload = { noteId: 'n1', text: '评论正文', fastReturnToFeed: true };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('interaction.comment', 'c-feed', 1700000000000, payload)));
    assert.equal((back!.payload as InteractionCommentPayload).fastReturnToFeed, true);
  });

  it('AC-PROTO-09 persona 生成载荷可选字段往返存活（防两端静默漂移）', () => {
    // change edge-persona-keyword-generation 新增 persona.generate/persist 请求响应对（edge 发起、pending-id 回包）。
    // typecheck 的 MessageType 穷举抓不到可选字段（soulYaml/identitySummary/reason）漂移，故此往返断言兜底。
    const req: PersonaGeneratePayload = { accountId: 'acc-1', keywordSelections: ['美妆', '活泼'], writingLanguage: 'vi', idempotencyKey: 'idem-1' };
    const reqBack = parseEnvelope(JSON.stringify(makeEnvelope('persona.generate', 'g-1', 1700000000000, req)));
    assert.deepEqual((reqBack!.payload as PersonaGeneratePayload).keywordSelections, ['美妆', '活泼']);
    assert.equal((reqBack!.payload as PersonaGeneratePayload).idempotencyKey, 'idem-1');
    assert.equal((reqBack!.payload as PersonaGeneratePayload).writingLanguage, 'vi');

    const res: PersonaGenerateResultPayload = { ok: true, soulYaml: 'identity:\n  name: x', identitySummary: '美妆达人' };
    const resBack = parseEnvelope(JSON.stringify(makeEnvelope('persona.generate.result', 'g-1', 1700000000000, res)));
    assert.equal((resBack!.payload as PersonaGenerateResultPayload).soulYaml, 'identity:\n  name: x');
    assert.equal((resBack!.payload as PersonaGenerateResultPayload).identitySummary, '美妆达人');
  });

  it('AC-PROTO-10 ui.snapshot personaBound 可选字段往返存活（change persona-wizard-onboarding-fixes）', () => {
    // 加可选 personaBound（无新增 MessageType、计数随审批动作协议为 67）；typecheck 抓不到可选字段漂移，往返断言兜底。
    const snap: UiSnapshotPayload = { account: { id: 'acc-1' }, personaBound: true, personaWritingLanguage: 'vi' };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-1', 1700000000000, snap)));
    assert.equal((back!.payload as UiSnapshotPayload).personaBound, true);
    assert.equal((back!.payload as UiSnapshotPayload).personaWritingLanguage, 'vi');
  });

  it('AC-PROTO-11 ui.snapshot 稿件预览字段往返存活', () => {
    const snap: UiSnapshotPayload = {
      publishPreview: {
        recordId: 89,
        code: '#89',
        kind: 'rewrite',
        title: '洗稿标题',
        content: '洗稿正文',
        topics: ['生活'],
        images: ['https://cdn.example.com/1.jpg'],
        contentVersion: 0,
        updatedAt: 1730000000000,
      },
    };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-2', 1700000000000, snap)));
    assert.deepEqual((back!.payload as UiSnapshotPayload).publishPreview, snap.publishPreview);
  });

  it('AC-PROTO-12 ui.snapshot browserStandby 可选字段往返存活（change browser-cold-standby-next-action）', () => {
    const snap: UiSnapshotPayload = {
      browserStandby: {
        enabled: true,
        eligible: true,
        reason: 'view_quota:hour',
        waitMs: 1_800_000,
        wakeAt: 1700001800000,
        generatedAt: 1700000000000,
        source: 'risk',
        minWaitMs: 1_200_000,
        warmupMs: 90_000,
      },
    };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-1', 1700000000000, snap)));
    assert.deepEqual((back!.payload as UiSnapshotPayload).browserStandby, snap.browserStandby);
  });

  it('AC-PROTO-13 ui.snapshot submitted 表示页面已提交但链接待确认', () => {
    const snap: UiSnapshotPayload = { publish: { state: 'submitted', title: '待链接确认的帖子', code: '#89' } };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-3', 1700000000000, snap)));
    assert.deepEqual((back!.payload as UiSnapshotPayload).publish, snap.publish);
  });

  it('AC-PROTO-14 首作引导标记与首轮进度可以在协议中往返', () => {
    const result: PersonaPersistResultPayload = { ok: true, firstPostOnboarding: true };
    const resultBack = parseEnvelope(
      JSON.stringify(makeEnvelope('persona.persist.result', 's-4', 1700000000000, result)),
    );
    assert.equal((resultBack!.payload as PersonaPersistResultPayload).firstPostOnboarding, true);

    const snap: UiSnapshotPayload = {
      dailyUsage: {
        asOf: 1700000000000,
        totals: { view: 7 },
        firstPost: {
          state: 'generating',
          viewed: 7,
          target: 20,
          startedAt: 1700000000000,
          sourceId: 'note-1',
        },
      },
    };
    const snapBack = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-5', 1700000000000, snap)));
    assert.deepEqual((snapBack!.payload as UiSnapshotPayload).dailyUsage?.firstPost, snap.dailyUsage?.firstPost);
  });

  it('AC-PROTO-15 edge.task.released 抢占类原因字符串往返存活（裸值，typecheck 抓不到两端漂移）', () => {
    // 三个新增释放原因是裸联合字符串，两端 protocol.ts 各写一份、typecheck 不跨端校验
    // → 手写往返把值焊死；任一端漏改/拼错，该端本断言即红（change lease-strict-preemption 6.4）。
    for (const reason of ['preempted_by_task', 'window_busy', 'yield_timeout'] as const) {
      const payload: EdgeTaskReleasedPayload = { taskId: 't-14', reason };
      const back = parseEnvelope(JSON.stringify(makeEnvelope('edge.task.released', 'r-14', 1700000000000, payload)));
      assert.equal((back!.payload as EdgeTaskReleasedPayload).reason, reason);
    }
    // window_busy 专用剩余预算字段随包往返存活——「不让抢占者空等」的事实源。
    const busy: EdgeTaskReleasedPayload = { taskId: 't-14b', reason: 'window_busy', windowRemainingMs: 8_500 };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('edge.task.released', 'r-14b', 1700000000000, busy)));
    assert.equal((back!.payload as EdgeTaskReleasedPayload).windowRemainingMs, 8_500);
  });

  it('AC-PROTO-16 publish.command.result 已派发提交位往返存活（区分「已点未确认」与「压根没点」）', () => {
    // 已派发但未确认：ok=false 且 submitDispatched=true → 云端必须按「已提交待确认」处置、绝不烧 failed。
    const dispatched: PublishCommandResultPayload = { recordId: 1, seq: 2, kind: 'submit_publish', ok: false, submitDispatched: true };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('publish.command.result', 'p-15', 1700000000000, dispatched)));
    assert.equal((back!.payload as PublishCommandResultPayload).submitDispatched, true);
    // 压根没点：字段缺省 → undefined，往返后仍不出现（云端据此判提交前失败可安全重投）。
    const notDispatched: PublishCommandResultPayload = { recordId: 1, seq: 3, kind: 'submit_publish', ok: false };
    const back2 = parseEnvelope(JSON.stringify(makeEnvelope('publish.command.result', 'p-15b', 1700000000000, notDispatched)));
    assert.equal((back2!.payload as PublishCommandResultPayload).submitDispatched, undefined);
  });

  it('AC-PROTO-17 ui.snapshot dailyUsage.slowStart 往返存活（payload 字段漂移 typecheck 完全抓不到）', () => {
    // 两份 protocol.ts 的机械保障只覆盖 MessageType 穷举，**payload 可选字段漂移一个都抓不到
    // ——而且已经漏过**：inspirationSummary 只活在 edge 侧，cloud 全仓含 test 零命中，
    // 客户端在渲染一个云端从未发过的字段。故此处手写往返把 slowStart 的每个字段焊死：
    // 任一端漏改 / 拼错 / 少一个键，该端本断言即红。
    const active: UiSnapshotPayload = {
      dailyUsage: {
        asOf: 1700000000000,
        totals: { view: 7 },
        slowStart: { state: 'active', day: 3, totalDays: 7, since: 1699920000000, binding: true, eligible: true },
      },
    };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 'ss-1', 1700000000000, active)));
    assert.deepEqual((back!.payload as UiSnapshotPayload).dailyUsage?.slowStart, active.dailyUsage?.slowStart);

    // binding=false（勾了但当前档位已更严、一格没压）必须能如实往返——它是一个被明说的态，
    // 不是缺省。若它在传输中退化成 undefined，UI 会把「没压」渲染成「正在压低」。
    const notBinding: UiSnapshotPayload = {
      dailyUsage: {
        asOf: 1700000000000,
        totals: { view: 7 },
        slowStart: { state: 'active', day: 5, totalDays: 7, binding: false, eligible: true },
      },
    };
    const back2 = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 'ss-2', 1700000000000, notBinding)));
    assert.equal((back2!.payload as UiSnapshotPayload).dailyUsage?.slowStart?.binding, false);

    // 三个 ineligibleReason 是裸联合字符串，两端各写一份 → 逐个焊死。
    for (const reason of ['platform_unsupported', 'platform_unknown', 'globally_disabled'] as const) {
      const snap: UiSnapshotPayload = {
        dailyUsage: { asOf: 1700000000000, totals: {}, slowStart: { state: 'off', totalDays: 7, eligible: false, ineligibleReason: reason } },
      };
      const b = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 'ss-3', 1700000000000, snap)));
      assert.equal((b!.payload as UiSnapshotPayload).dailyUsage?.slowStart?.ineligibleReason, reason);
    }

    // 毕业态：day 缺省、state=graduated —— 必须显式告知而非静默消失。
    const graduated: UiSnapshotPayload = {
      dailyUsage: { asOf: 1700000000000, totals: {}, slowStart: { state: 'graduated', totalDays: 7, since: 1699315200000, eligible: true } },
    };
    const back3 = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 'ss-4', 1700000000000, graduated)));
    assert.deepEqual((back3!.payload as UiSnapshotPayload).dailyUsage?.slowStart, graduated.dailyUsage?.slowStart);

    // 字段整体缺省 = 未知（云端还没说）→ 往返后仍不出现；边缘据此整行不渲染，MUST NOT 当「关」。
    const absent: UiSnapshotPayload = { dailyUsage: { asOf: 1700000000000, totals: {} } };
    const back4 = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 'ss-5', 1700000000000, absent)));
    assert.equal((back4!.payload as UiSnapshotPayload).dailyUsage?.slowStart, undefined);
  });

  it('AC-PROTO-18 captcha assist 键入扩载荷逐字段往返存活（change captcha-assist-text-answer）', () => {
    // 与边缘 AC-PROTO-18 逐字一致（两份 protocol.ts 的 CaptchaAssistClick* 字段镜像守卫）。
    // 走「扩既有 click 载荷、不新增 MessageType」路线（design D1）：Record<MessageType> 穷举与计数断言都
    // 抓不到字段增删，任何「往既有 payload 加可选字段」的改动必须补这样一条逐字段往返断言。
    const click: CaptchaAssistClickPayload = {
      taskId: 'task-cap-1',
      incidentId: 'inc-1',
      snapshotId: 'snap-1',
      points: [{ x: 0.4, y: 0.6, label: 'field' }],
      requestedAt: 1700000000000,
      settleMs: 1500,
      text: 'AB3x',
      submit: 'enter',
    };
    const clickBack = parseEnvelope(JSON.stringify(makeEnvelope('captcha.assist.click', 'c-1', 1700000000000, click)));
    assert.deepEqual(clickBack!.payload, click);
    const cp = clickBack!.payload as CaptchaAssistClickPayload;
    assert.equal(cp.text, 'AB3x');
    assert.equal(cp.submit, 'enter');
    assert.deepEqual(cp.points, [{ x: 0.4, y: 0.6, label: 'field' }]);

    // 纯点击（无 text/submit）零回归：往返后这两字段仍缺省。
    const clickOnly: CaptchaAssistClickPayload = { incidentId: 'inc-2', snapshotId: 'snap-2', points: [{ x: 0.1, y: 0.2 }] };
    const clickOnlyBack = parseEnvelope(JSON.stringify(makeEnvelope('captcha.assist.click', 'c-2', 1700000000000, clickOnly)));
    assert.equal((clickOnlyBack!.payload as CaptchaAssistClickPayload).text, undefined);
    assert.equal((clickOnlyBack!.payload as CaptchaAssistClickPayload).submit, undefined);

    const typeReport: CaptchaAssistTypeReportPayload = {
      focus: 'editable',
      focusTag: 'INPUT',
      cleared: 'verified',
      typed: 4,
      verified: 'match',
      submitted: true,
    };
    const result: CaptchaAssistClickResultPayload = {
      incidentId: 'inc-1',
      snapshotId: 'snap-1',
      edgeId: 'edge-1',
      accountId: 'acc-1',
      status: 'cleared',
      reason: 'ok',
      checkedAt: 1700000000000,
      replayMode: 'synthetic',
      inputMode: 'click_type',
      typeReport,
    };
    const resultBack = parseEnvelope(JSON.stringify(makeEnvelope('captcha.assist.click_result', 'r-1', 1700000000000, result)));
    assert.deepEqual(resultBack!.payload, result);
    const rp = resultBack!.payload as CaptchaAssistClickResultPayload;
    assert.equal(rp.inputMode, 'click_type');
    assert.deepEqual(rp.typeReport, typeReport);

    // 新 status 值 no_target 往返存活（红线词汇，区分「点空了」与坐标越界）。
    const noTarget: CaptchaAssistClickResultPayload = {
      incidentId: 'inc-3',
      status: 'no_target',
      reason: 'focus_not_landed',
      checkedAt: 1700000000000,
      inputMode: 'click_type',
      typeReport: { focus: 'none', typed: 0, submitted: false },
    };
    const noTargetBack = parseEnvelope(JSON.stringify(makeEnvelope('captcha.assist.click_result', 'r-2', 1700000000000, noTarget)));
    assert.equal((noTargetBack!.payload as CaptchaAssistClickResultPayload).status, 'no_target');
    assert.deepEqual((noTargetBack!.payload as CaptchaAssistClickResultPayload).typeReport, { focus: 'none', typed: 0, submitted: false });
  });

  it('AC-PROTO-19 客户端批准的立即/定时发布计划逐字段往返存活', () => {
    const scheduled: PublishApprovalActionPayload = {
      requestId: 'publish-89',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: 1_784_383_200_000,
    };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('publish.approval_action', 'pa-1', 1700000000000, scheduled)));
    assert.deepEqual(back!.payload, scheduled);
    const payload = back!.payload as PublishApprovalActionPayload;
    assert.equal(payload.publishMode, 'scheduled');
    assert.equal(payload.publishTime, 1_784_383_200_000);

    const legacy: PublishApprovalActionPayload = { requestId: 'publish-89', approved: true, contentVersion: 3 };
    const legacyBack = parseEnvelope(JSON.stringify(makeEnvelope('publish.approval_action', 'pa-2', 1700000000000, legacy)));
    assert.equal((legacyBack!.payload as PublishApprovalActionPayload).publishMode, undefined);
    assert.equal((legacyBack!.payload as PublishApprovalActionPayload).publishTime, undefined);
  });

  it('AC-PROTO-20 page.cards 列表形态/空态可选字段往返存活，消息类型与 Surface 不扩展', () => {
    const payload: PageCardsPayload = { cards: [], listKind: 'feed', listState: 'empty', startupId: 'start-1' };
    const env = makeEnvelope('page.cards', 'pc-empty', 1700000000000, payload);
    assert.deepEqual(parseEnvelope(JSON.stringify(env))?.payload, payload);
  });

  it('AC-PROTO-20b page.cards 首页物理卡不可上报状态与文档 generation 往返存活', () => {
    const payload: PageCardsPayload = {
      cards: [],
      listKind: 'feed',
      listState: 'present_unreportable',
      startupId: 'start-1',
      documentGeneration: 'doc-1',
    };
    const env = makeEnvelope('page.cards', 'pc-unreportable', 1700000000000, payload);
    assert.deepEqual(parseEnvelope(JSON.stringify(env))?.payload, payload);
  });

  it('AC-PROTO-20c page.cards 身份分档往返存活；缺分档即平台链接（老边端零回归）', () => {
    const payload: PageCardsPayload = {
      cards: [
        {
          index: 0,
          title: '群组帖：零交互取不到任何平台地址',
          likeCount: 3,
          collectCount: 0,
          noteId: `aidcp:facebook-group-feed-post:v1:${'a1'.repeat(32)}`,
          noteIdKind: 'content_ref',
        },
        {
          index: 1,
          title: '主页帖：悬停时间戳换出永久链接',
          likeCount: 5,
          collectCount: 0,
          noteId: 'https://www.facebook.com/Alice/posts/pfbid1',
          noteIdKind: 'permalink',
        },
        // 老边端：不带分档字段 ⇒ 消费方一律按平台链接处理，行为逐位等于今天。
        {
          index: 2,
          title: '老边端上报的卡',
          likeCount: 1,
          collectCount: 0,
          noteId: 'https://www.facebook.com/Bob/posts/pfbid2',
        },
      ],
      listKind: 'feed',
      listState: 'ready',
    };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('page.cards', 'pc-kind', 1700000000000, payload)));
    assert.deepEqual(back?.payload, payload);
    const cards = (back!.payload as PageCardsPayload).cards;
    assert.equal(cards[0]!.noteIdKind, 'content_ref');
    assert.equal(cards[1]!.noteIdKind, 'permalink');
    assert.equal(cards[2]!.noteIdKind, undefined);
  });
});
