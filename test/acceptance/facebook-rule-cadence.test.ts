/**
 * AC-FBRULE-* — Facebook 规则模式两级节奏的红线用例（change facebook-rule-mode-two-tier-cadence）。
 *
 * 规则模式此前在验收层**零覆盖**，而它同时踩着三条本仓红线：
 *   ① 「MUST NOT 静默假成功」——以及它的镜像形态「假失败」：只点赞的轮次如果借用失败态表达
 *      「本轮按节奏不做」，运营看到的是一半轮次都在报错；
 *   ② 单飞与活锁——只点赞的轮次不终结，账号的浏览计数会被永久卡死；
 *   ③ DEV/OL 隔离——运行时事实必须按 execution_target 分区。
 *
 * 这些用例只吃纯函数、内存中的调度器与磁盘上的迁移文本——不连库、不起服务、不碰网络。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  FACEBOOK_RULE_DEFINITION_ID,
  FACEBOOK_RULE_DEFINITION_VERSION,
  FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
  FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
  FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS,
  FACEBOOK_RULE_LEGACY_DEFINITION_ID,
  FACEBOOK_RULE_VIEW_THRESHOLD,
  facebookRuleRoundIncludesJoin,
} from '../../src/kernel/facebook-rule-mode-types.js';

const migration = (name: string) =>
  readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

test('AC-FBRULE-01 新运行时定义号稳定且不再编码节奏', () => {
  assert.equal(FACEBOOK_RULE_RUNTIME_DEFINITION_ID, 'facebook_rule_cadence');
  assert.doesNotMatch(FACEBOOK_RULE_RUNTIME_DEFINITION_ID, /5|2|every/);
  assert.ok(FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION > FACEBOOK_RULE_DEFINITION_VERSION);
  // 旧配置定义保留只为迁移与回滚读取，不再作为新运行时 cadence identity。
  assert.match(
    FACEBOOK_RULE_DEFINITION_ID,
    new RegExp(`_${FACEBOOK_RULE_VIEW_THRESHOLD}_like_1_join_contact_every_${FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS}$`),
  );
  assert.notEqual(FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_LEGACY_DEFINITION_ID);
});

test('AC-FBRULE-02 二级节奏按轮次序号推进，不按成功点赞数', () => {
  // 只数成功点赞的话，点赞日配额 / 冷却一耗尽，加群与联系评论会静默全停——
  // 界面上看不出任何异常，正是「静默假成功」的形态。
  const cycle = [1, 2, 3, 4, 5, 6].map((sequence) =>
    facebookRuleRoundIncludesJoin(sequence),
  );
  assert.deepEqual(cycle, [false, true, false, true, false, true]);
  // 非法输入不得被当成「该加群」。
  assert.equal(facebookRuleRoundIncludesJoin(0), false);
  assert.equal(facebookRuleRoundIncludesJoin(-2), false);
  assert.equal(facebookRuleRoundIncludesJoin(Number.NaN), false);
});

test('AC-FBRULE-03 加群频率不因节奏拆分而升高', () => {
  // 拆节奏的前提是「点赞更密、入群不更密」。这条守住那个前提：
  // 每 threshold 条浏览一轮、每 joinEveryN 轮一次加群 ⇒ 每 10 条浏览恰好 1 次加群，与旧单轴节奏逐位相等。
  const viewsPerJoin = FACEBOOK_RULE_VIEW_THRESHOLD * FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS;
  assert.equal(viewsPerJoin, 10, `加群频率变了：现在每 ${viewsPerJoin} 条浏览一次，旧节奏是每 10 条一次`);
});

test('AC-FBRULE-04 只点赞的轮次终结为 not_scheduled、释放单飞、且不覆盖点赞阻断原因', async () => {
  // 三条红线合一：
  //   假失败——借用 not_started / structural_skip 会让一半轮次在后台显示成「本该做却没做成」；
  //   活锁——轮次不终结 ⇒ 活跃轮次指针不清 ⇒ 确认浏览在写去重账本之前被短路 ⇒ 账号彻底停摆；
  //   诚实原因——blocker 三阶段共用一列，终结时补写任何值都会抹掉点赞为什么被抑制。
  const { RoleDispatcher } = await import('../../src/orchestrator/role-dispatcher.js');
  const patches: Array<Record<string, unknown>> = [];
  let joinCalls = 0;
  const likeOnlySequence = 1;
  assert.equal(facebookRuleRoundIncludesJoin(likeOnlySequence), false);

  const dispatcher = new RoleDispatcher({
    soul: {
      identity: { name: 'AC', role: 'operator', background: 'ac', tone: 'neutral' },
      interests: { primary: [], secondary: [], seed_keywords: [] },
    },
    llm: { complete: async () => '{"verdict":"skip"}' },
    sendCommand: () => {},
    accountPlatform: 'facebook',
    facebookRuleModeDecision: () => ({
      mode: 'facebook_rule',
      blocker: null,
      policyRevision: 7,
      rulePolicy: { viewsPerLike: 5, joinEveryNRounds: 2 },
      consumptionPolicy: {
        viewsPerLike: 5,
        confirmedLikesPerJoin: 2,
        confirmedJoinsPerComment: 2,
      },
    }),
    applyFacebookRuleView: async () => ({
      kind: 'batch_created',
      batch: {
        batchId: '00000000-0000-4000-8000-0000000000ac',
        policyRevision: 7,
        policySnapshot: { viewsPerLike: 5, joinEveryNRounds: 2 },
        sequence: likeOnlySequence,
        includesJoin: facebookRuleRoundIncludesJoin(likeOnlySequence),
        triggerContentKey: 'post-5',
        likeState: 'pending',
        joinState: 'pending',
        commentState: 'pending',
        terminal: false,
        blocker: null,
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
    }),
    updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
    explainInteract: () => ({ allowed: false, reason: 'daily_like_quota' }),
    explainRuleJoin: () => ({ allowed: true }),
    triggerFacebookRuleJoinContact: async () => {
      joinCalls += 1;
      return { started: false, reason: 'must_not_be_called' };
    },
  });
  dispatcher.setCurrentAccountId('fb-ac');
  dispatcher.setup();
  dispatcher.startSession();
  dispatcher.bus.emit('facebook.rule.view.confirmed', {
    accountId: 'fb-ac',
    noteId: 'https://www.facebook.com/posts/post-5',
    sourceDedupeKey: 'ac-receipt',
    source: 'detail',
    occurredAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  dispatcher.endSession();

  assert.equal(joinCalls, 0, '周期第 1 位 MUST NOT 触发加群联系评论');
  const terminal = patches.find((patch) => patch.terminal === true);
  assert.ok(terminal, '只点赞的轮次 MUST 终结——不终结即活锁，账号浏览计数永久停摆');
  assert.equal(terminal!.joinState, 'not_scheduled');
  assert.equal(terminal!.commentState, 'not_scheduled');
  assert.equal(
    Object.prototype.hasOwnProperty.call(terminal!, 'blocker'),
    false,
    '终结 MUST NOT 触碰 blocker——该列三阶段共用，补写会抹掉点赞的抑制原因',
  );
  assert.ok(
    patches.some((patch) => patch.likeState === 'risk_suppressed' && patch.blocker === 'daily_like_quota'),
    '点赞抑制原因必须先被如实写入',
  );
});

test('AC-FBRULE-05 运行时三张表按 execution_target 分区，配置表不参与该分区', async () => {
  const [runtime0093, config0092] = await Promise.all([
    migration('0093_facebook_rule_mode_runtime.sql'),
    migration('0092_facebook_rule_mode_config.sql'),
  ]);
  for (const table of ['facebook_rule_progress', 'facebook_rule_view_fact', 'facebook_rule_batch']) {
    const block = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?\\n\\);`).exec(runtime0093)?.[0];
    assert.ok(block, `${table} 建表语句未找到`);
    assert.match(
      block!,
      /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev', 'ol'\)\)/,
      `${table} MUST 带 execution_target（DEV/OL 共库，持久运行事实必须分区）`,
    );
  }
  // 配置表**没有** execution_target 是已知事实，不是遗漏：它是 dev/ol 共享的账号级开关。
  // 钉在这里是为了让将来任何「让两侧节奏不同」的想法先撞上这条注释，而不是撞上线上事故。
  assert.doesNotMatch(config0092, /execution_target/);
});

test('AC-FBRULE-06 节奏迁移只放宽不收缩，且旧定义仍可写（回滚无需反向迁移）', async () => {
  for (const name of ['0094_facebook_rule_two_tier_config.sql', '0095_facebook_rule_two_tier_runtime.sql']) {
    const raw = await migration(name);
    const sql = raw.replace(/--.*$/gm, ''); // 注释里逐字写着不该用的写法，不剥会自伤
    assert.match(raw, /aidcp:kind=expand/);
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i);
    assert.match(
      sql,
      new RegExp(FACEBOOK_RULE_LEGACY_DEFINITION_ID),
      '放宽后的 CHECK MUST 仍接受旧定义——否则回滚到旧代码会当场 23514',
    );
    assert.match(sql, new RegExp(FACEBOOK_RULE_DEFINITION_ID));
  }
});

test('AC-FBRULE-07 policy revision 迁移允许稳定定义与 1..100 浏览计数', async () => {
  const raw = await migration('0101_facebook_rule_policy_revision_runtime.sql');
  assert.match(raw, /facebook_rule_cadence/);
  assert.match(raw, /policy_revision/);
  assert.match(raw, /policy_snapshot/);
  assert.match(raw, /view_count BETWEEN 0 AND 99/);
  assert.match(raw, /policy_superseded/);
});
