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
  type PersonaGeneratePayload,
  type PersonaGenerateResultPayload,
  type UiSnapshotPayload,
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
  'publish.request': true, 'publish.result': true,
  'publish.command': true, 'publish.command.result': true,
  'page.scroll': true, 'feed.refresh': true, 'pacing.update': true, 'interaction.like': true, 'interaction.collect': true, 'interaction.follow': true,
  'interaction.comment': true, 'interaction.like_comment': true,
  'group.join': true,
  'navigation.back': true, 'note.browse_images': true, 'note.scroll_comments': true, 'profile.open': true,
  'page.cards': true, 'note.detail': true, 'profile.detail': true, 'action.completed': true,
  'notification.open': true, 'notification.browse_comments': true, 'notification.browse_likes': true,
  'notification.browse_follows': true, 'notification.back_home': true,
  'notification.detected': true, 'notification.home': true, 'notification.items': true,
  'persona.generate': true, 'persona.generate.result': true,
  'persona.persist': true, 'persona.persist.result': true,
  error: true, ping: true, pong: true,
};
const ALL_TYPES = Object.keys(ALL_MESSAGE_TYPES) as MessageType[];

describe('AC-PROTO 协议契约一致性（cloud）', () => {
  it('AC-PROTO-01 协议版本为 2', () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });

  it('AC-PROTO-02 消息类型总数为 74（增删消息须同步两端 + 本断言）', () => {
    assert.equal(ALL_TYPES.length, 74);
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

  it('AC-PROTO-08 Facebook 定向评论可选载荷字段往返存活（container / url，防两端静默漂移）', () => {
    // change facebook-scheduled-comment 给 search.execute 加 container?、note.open 加 url?（复用消息、零新增类型）。
    // 两份 protocol.ts 须逐字镜像这两个字段；typecheck 的 MessageType 穷举抓不到可选字段漂移，故此往返断言兜底。
    const search: SearchExecutePayload = { keyword: '咖啡', container: 'https://www.facebook.com/groups/123456' };
    const searchBack = parseEnvelope(JSON.stringify(makeEnvelope('search.execute', 's-1', 1700000000000, search)));
    assert.equal((searchBack!.payload as SearchExecutePayload).container, 'https://www.facebook.com/groups/123456');

    const open: NoteOpenPayload = { url: 'https://www.facebook.com/groups/123456/posts/999' };
    const openBack = parseEnvelope(JSON.stringify(makeEnvelope('note.open', 'o-1', 1700000000000, open)));
    assert.equal((openBack!.payload as NoteOpenPayload).url, 'https://www.facebook.com/groups/123456/posts/999');
  });

  it('AC-PROTO-09 persona 生成载荷可选字段往返存活（防两端静默漂移）', () => {
    // change edge-persona-keyword-generation 新增 persona.generate/persist 请求响应对（edge 发起、pending-id 回包）。
    // typecheck 的 MessageType 穷举抓不到可选字段（soulYaml/identitySummary/reason）漂移，故此往返断言兜底。
    const req: PersonaGeneratePayload = { accountId: 'acc-1', keywordSelections: ['美妆', '活泼'], idempotencyKey: 'idem-1' };
    const reqBack = parseEnvelope(JSON.stringify(makeEnvelope('persona.generate', 'g-1', 1700000000000, req)));
    assert.deepEqual((reqBack!.payload as PersonaGeneratePayload).keywordSelections, ['美妆', '活泼']);
    assert.equal((reqBack!.payload as PersonaGeneratePayload).idempotencyKey, 'idem-1');

    const res: PersonaGenerateResultPayload = { ok: true, soulYaml: 'identity:\n  name: x', identitySummary: '美妆达人' };
    const resBack = parseEnvelope(JSON.stringify(makeEnvelope('persona.generate.result', 'g-1', 1700000000000, res)));
    assert.equal((resBack!.payload as PersonaGenerateResultPayload).soulYaml, 'identity:\n  name: x');
    assert.equal((resBack!.payload as PersonaGenerateResultPayload).identitySummary, '美妆达人');
  });

  it('AC-PROTO-10 ui.snapshot personaBound 可选字段往返存活（change persona-wizard-onboarding-fixes）', () => {
    // 加可选 personaBound（无新增 MessageType、计数随审批动作协议为 67）；typecheck 抓不到可选字段漂移，往返断言兜底。
    const snap: UiSnapshotPayload = { account: { id: 'acc-1' }, personaBound: true };
    const back = parseEnvelope(JSON.stringify(makeEnvelope('ui.snapshot', 's-1', 1700000000000, snap)));
    assert.equal((back!.payload as UiSnapshotPayload).personaBound, true);
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
});
