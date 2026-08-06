import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '@automation/comm/handler.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { makeEnvelope } from '@automation/comm/protocol.js';
import { EventBus } from '@automation/event-bus/index.js';
import { SimplePlanner } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/qwen.js';

/**
 * 加群配额计「真的抵达平台的动作」而非「确认加入」（change fb-join-quota-counts-attempts）。
 *
 * 本文件只断言**记账闸的 emit 决策**——这是判据真正所在的地方。真正的 +1 在
 * `interaction.occurred` 的订阅者里（server.ts 引导期接线，单测无缝可进），
 * 「日计数真的 +1」由真机验收坐实（tasks 6.4 / backlog 簇 90）。
 */

const noopCache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;

const llm: LlmClient = { complete: async () => '0' };

function makeHandler(eventBus: EventBus) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: noopCache,
    eventBus,
    clock: () => 1000,
  });
}

function capture(eventBus: EventBus) {
  const got: { accountId?: string; action: string; targetId?: string }[] = [];
  eventBus.on('interaction.occurred', (e) => {
    got.push(e);
  });
  return got;
}

const session = (): EdgeSession => ({ sessionId: 's', accountId: 'acc-fb' });

/** 送一条 action.completed 进闸，返回本次记账 emit 出来的 interaction.occurred。 */
async function feed(payload: { action: string; ok: boolean; reason?: string; clicked?: boolean }) {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  await makeHandler(eventBus).handle(makeEnvelope('action.completed', 'a', 1, payload), session());
  return got;
}

test('点击后待管理员审批（ok:false, clicked:true）→ 计入配额', async () => {
  const got = await feed({ action: 'join_group', ok: false, reason: 'pending', clicked: true });
  assert.equal(got.length, 1, 'FB 已收到本次入群申请 —— 平台观察到的动作，MUST 计入风控预算');
  assert.equal(got[0].action, 'join_group');
  assert.equal(got[0].accountId, 'acc-fb');
});

test('点击后待审批 MUST NOT 进展示账本（不带 targetId ⇒ interaction_feed 天然挡在外）', async () => {
  const got = await feed({ action: 'join_group', ok: false, reason: 'pending', clicked: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].targetId, undefined, '计了配额 ≠ 加群成功：绝不进展示账本、绝不报成已加入');
});

test('点击**前**就发现已在待审批（clicked:false）→ 不计（与上面 reason 逐字相同、结果相反）', async () => {
  const got = await feed({ action: 'join_group', ok: false, reason: 'pending', clicked: false });
  assert.equal(got.length, 0, '本次没对 FB 做任何动作 —— 判据是 clicked，绝不是 reason');
});

test('已是成员（clicked:false）→ 不计', async () => {
  const got = await feed({ action: 'join_group', ok: false, reason: 'already_member', clicked: false });
  assert.equal(got.length, 0);
});

test('影子模式只观测（observation_only）→ 不计，即便回执谎称点过', async () => {
  const silent = await feed({ action: 'join_group', ok: false, reason: 'observation_only', clicked: false });
  assert.equal(silent.length, 0);
  // 防御性：影子模式恒 clicked:false 是**云端上游两处 if(shadow) 守着的不变量**，边缘对影子模式一无所知、
  // 无法自行拒绝点击。万一将来某条云端路径漏掉守卫，排除表仍须兜住。
  const lying = await feed({ action: 'join_group', ok: false, reason: 'observation_only', clicked: true });
  assert.equal(lying.length, 0);
});

test('点击后确认加入（ok:true, clicked:true）→ 计（今天的行为，逐位不变）', async () => {
  const got = await feed({ action: 'join_group', ok: true, reason: 'joined', clicked: true });
  assert.equal(got.length, 1);
});

test('回执不带 clicked → 不计（clicked 是可选字段，缺失 ≠ 点过；宁可少计不可假计）', async () => {
  const got = await feed({ action: 'join_group', ok: true, reason: 'joined' });
  assert.equal(got.length, 0);
});

test('边缘协议名 group.join 归一后同样按 clicked 判（不因动作名口径漏判）', async () => {
  const got = await feed({ action: 'group.join', ok: false, reason: 'pending', clicked: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].action, 'join_group', '云端角色关联键是 join_group，不是协议消息名');
});

test('导航/登录在点击前失败（clicked:false）→ 不计（没抵达平台）', async () => {
  for (const reason of ['login_required', 'nav_error', 'no_button', 'timeout']) {
    const got = await feed({ action: 'join_group', ok: false, reason, clicked: false });
    assert.equal(got.length, 0, `${reason} 未点击 ⇒ 不计`);
  }
});

test('零回归绊线：其余五个动作失败时仍不计（ok 这一轴 MUST NOT 被顺手删掉）', async () => {
  for (const action of ['like', 'collect', 'follow', 'comment', 'comment_like']) {
    const got = await feed({ action, ok: false, reason: 'blocked_by_captcha' });
    assert.equal(got.length, 0, `${action} 失败绝不能被记成真互动 —— 「绝不静默假成功」红线`);
  }
});

test('零回归绊线：其余五个动作成功时照常计', async () => {
  for (const action of ['like', 'collect', 'follow', 'comment', 'comment_like']) {
    const got = await feed({ action, ok: true });
    assert.equal(got.length, 1, `${action} 成功仍须计数`);
  }
});

test('零回归：already_followed 是良性 no-op，仍不计', async () => {
  const got = await feed({ action: 'follow', ok: true, reason: 'already_followed' });
  assert.equal(got.length, 0);
});
