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
  'publish.approval_request': true, 'publish.request': true, 'publish.result': true,
  'publish.command': true, 'publish.command.result': true,
  'page.scroll': true, 'interaction.like': true, 'interaction.collect': true, 'interaction.follow': true,
  'interaction.comment': true, 'interaction.like_comment': true,
  'navigation.back': true, 'note.browse_images': true, 'note.scroll_comments': true, 'profile.open': true,
  'page.cards': true, 'note.detail': true, 'profile.detail': true, 'action.completed': true,
  'notification.open': true, 'notification.browse_comments': true, 'notification.browse_likes': true,
  'notification.browse_follows': true, 'notification.back_home': true,
  'notification.detected': true, 'notification.home': true, 'notification.items': true,
  error: true, ping: true, pong: true,
};
const ALL_TYPES = Object.keys(ALL_MESSAGE_TYPES) as MessageType[];

describe('AC-PROTO 协议契约一致性（cloud）', () => {
  it('AC-PROTO-01 协议版本为 2', () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });

  it('AC-PROTO-02 消息类型总数为 57（增删消息须同步两端 + 本断言）', () => {
    assert.equal(ALL_TYPES.length, 57);
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
});
