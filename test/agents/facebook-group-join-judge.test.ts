import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookGroupJoinJudge } from '../../src/agents/facebook-group-join-judge.js';
import type { FacebookGroupJoinAuditRow } from '../../src/comment-agent/facebook-group-store.js';

test('FacebookGroupJoinJudge pre-click skips already-member and gated observations without LLM', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{}'; } },
  });

  const member = await judge.evaluatePreClick({ mainCtaText: 'Joined', membershipSignals: ['Member of this group'] });
  assert.equal(member.verdict, 'already_member');

  const gated = await judge.evaluatePreClick({ mainCtaText: 'Join group', modalText: 'Answer membership questions before approval' });
  assert.equal(gated.verdict, 'gated_skip');
  assert.equal(calls, 0);
});

test('pending-label-audit: 中文「取消请求」文本兜底 pre-click 判 gated_skip，不依赖 pendingRequest boolean', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{}'; } },
  });

  for (const label of ['取消请求', '取消加入请求', '取消申请', '已发送请求']) {
    const r = await judge.evaluatePreClick({ mainCtaText: label, pendingRequest: false });
    assert.equal(r.verdict, 'gated_skip', `expected gated_skip for "${label}"`);
    assert.equal(r.reason, 'gated_or_questionnaire_signal');
  }
  assert.equal(calls, 0);
});

test('pending-label-audit: 中文「取消请求」文本兜底 post-click 判 pending_gated，不依赖 pendingRequest boolean', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{}'; } },
  });

  const r = await judge.evaluatePostClick({ mainCtaText: '取消请求', pendingRequest: false });
  assert.equal(r.verdict, 'pending_gated');
  assert.equal(r.reason, 'pending_or_questionnaire_signal');
  assert.equal(calls, 0);
});

test('pending-label-audit: 裸「取消」不触发 pending/gated 确定性判定', async () => {
  const judge = new FacebookGroupJoinJudge();

  const pre = await judge.evaluatePreClick({ mainCtaText: '取消', pendingRequest: false });
  assert.equal(pre.verdict, 'ambiguous_skip');

  const post = await judge.evaluatePostClick({ mainCtaText: '取消', pendingRequest: false });
  assert.equal(post.verdict, 'failed');
});

test('FacebookGroupJoinJudge fails closed on low-confidence model instant_join (no clear join CTA → LLM)', async () => {
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => '{"verdict":"instant_join","confidence":0.4,"reason":"unclear"}' },
  });

  // 无清晰加入 CTA（"View" 非加入词）→ 不走确定性 instant_join → 交 LLM → 低置信 → fail-closed。
  const result = await judge.evaluatePreClick({ mainCtaText: 'View', headerText: 'Public group' });
  assert.equal(result.verdict, 'ambiguous_skip');
  assert.match(result.reason, /fail_closed/);
});

test('FacebookGroupJoinJudge: clear Join CTA → deterministic instant_join, ignores documentReady=loading, no LLM', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{"verdict":"ambiguous_skip","confidence":0.9,"reason":"loading"}'; } },
  });
  // 真机回归:清晰「加入小组」+ documentReady='loading'（诊断字段）→ 应确定性 instant_join,不问 LLM、不被 loading 影响。
  const r = await judge.evaluatePreClick({
    mainCtaText: '加入小组',
    mainCtaAria: '加入小组',
    headerText: 'Tuyển Dụng Hà Nam 公开小组',
    // @ts-expect-error 诊断字段（边缘上报，云端类型未声明）——刻意验证它不影响判定
    documentReady: 'loading',
  });
  assert.equal(r.verdict, 'instant_join');
  assert.equal(r.reason, 'clear_join_cta');
  assert.equal(calls, 0, 'clear join CTA 不问 LLM（不受 loading 诊断字段左右）');
});

test('FacebookGroupJoinJudge records audit rows without affecting verdict', async () => {
  const rows: FacebookGroupJoinAuditRow[] = [];
  const judge = new FacebookGroupJoinJudge({
    accountId: 'fb-1',
    audit: (row) => rows.push(row),
  });

  const result = await judge.evaluatePostClick({
    groupUrl: 'https://www.facebook.com/groups/group-a',
    membershipSignals: ['You are now a member'],
  });

  assert.equal(result.verdict, 'joined');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'fb-1');
  assert.equal(rows[0].outcome, 'joined');
  assert.equal(rows[0].verdict, 'joined');
});

test('P0-2: 非英中群本地语成员标签走确定性 already_member/joined，不问 LLM、不误判 instant_join', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{}'; } },
  });
  // 越南语「Đã tham gia」(已加入) 含「tham gia」(加入) 子串——旧 EN/ZH 精确 hasMemberSignal 漏判 → 落 hasJoinCta 误判 instant_join。
  const pre = await judge.evaluatePreClick({ mainCtaText: 'Đã tham gia' });
  assert.equal(pre.verdict, 'already_member');
  // 西语「Salir del grupo」(退出小组) = 已是成员：post-click 确定性判 joined。
  const post = await judge.evaluatePostClick({ mainCtaText: 'Salir del grupo' });
  assert.equal(post.verdict, 'joined');
  assert.equal(calls, 0); // 全走确定性、未问模型
});

test('P1-6: 多语 Join CTA 走确定性 instant_join、不问 LLM（judge 词表与边缘对齐，drift guard）', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({ llm: { complete: async () => { calls++; return '{}'; } } });
  for (const label of [
    'Join group', '加入小组', 'Tham gia nhóm', 'Entrar no grupo', 'เข้าร่วมกลุ่ม',
    'Вступить в группу', 'Sertai kumpulan', 'انضمام', 'Únete al grupo',
  ]) {
    const r = await judge.evaluatePreClick({ mainCtaText: label });
    assert.equal(r.verdict, 'instant_join', `expected instant_join for "${label}"`);
  }
  assert.equal(calls, 0); // 全走确定性、未问模型（词表漂移会让某语种回落 LLM → 本断言失败）
});

// ── change facebook-join-structural-verify（L3）：结构后置校验，承重=语言无关「跃迁」；消灭「重复加群」──
test('L3: post-click 跃迁（点前无 composer→点后有、无可见加入 CTA、词表未命中语种）→ 确定性 joined，不问 LLM', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({ llm: { complete: async () => { calls++; return '{}'; } } });
  const pre = { mainCtaText: 'Tham gia nhóm', composerPresent: false, joinCtaPresent: true }; // 点前非成员：无 composer、加入 CTA 在
  const post = { mainCtaText: 'Đăng bài', composerPresent: true, joinCtaPresent: false }; // 点后 composer 出现=跃迁
  const r = await judge.evaluatePostClick(post, pre);
  assert.equal(r.verdict, 'joined');
  assert.equal(r.reason, 'structural_join_transition');
  assert.equal(calls, 0); // 结构确定性、未问模型
});

test('L3 红线: post-click 点前已有 composer（非成员公开组、无跃迁）→ 绝不结构 joined（防 fail-open false-positive）', async () => {
  const judge = new FacebookGroupJoinJudge(); // 无 LLM → 落 fail-closed failed
  const pre = { mainCtaText: '参加', composerPresent: true, joinCtaPresent: false }; // 点前公开组已渲染 composer；未覆盖语种致 joinCtaPresent=false
  const post = { mainCtaText: '参加', composerPresent: true, joinCtaPresent: false };
  const r = await judge.evaluatePostClick(post, pre);
  assert.notEqual(r.verdict, 'joined'); // 点前已有 composer → structuralJoinConfirmed=false，绝不据 fail-open joinCtaPresent 假成功
  assert.equal(r.verdict, 'failed');
});

test('L3: post-click composer 在但加入 CTA 仍可见（非成员）→ 绝不结构 joined（不假成功）', async () => {
  const judge = new FacebookGroupJoinJudge();
  const r = await judge.evaluatePostClick(
    { mainCtaText: 'Tham gia nhóm', composerPresent: true, joinCtaPresent: true },
    { composerPresent: false, joinCtaPresent: true },
  );
  assert.notEqual(r.verdict, 'joined'); // joinCtaPresent=true → 绝不假成功
  assert.equal(r.verdict, 'failed');
});

test('L3: post-click pending 且渲染 composer 跃迁 → pending_gated（pending 先于结构 joined）', async () => {
  const judge = new FacebookGroupJoinJudge();
  const r = await judge.evaluatePostClick(
    { pendingRequest: true, composerPresent: true, joinCtaPresent: false },
    { composerPresent: false, joinCtaPresent: true },
  );
  assert.equal(r.verdict, 'pending_gated'); // pending 判据先于结构 joined
});

test('L3 红线: pre-click 有 composer 也绝不据结构判 already_member（无点击不 markJoined）', async () => {
  const judge = new FacebookGroupJoinJudge(); // 无 LLM → 落 fail-closed ambiguous_skip
  const pre = await judge.evaluatePreClick({ mainCtaText: '参加', composerPresent: true, joinCtaPresent: false });
  assert.notEqual(pre.verdict, 'already_member'); // 已删除 pre-click 结构 already_member（防没点击就 markJoined 污染账本）
  assert.equal(pre.verdict, 'ambiguous_skip');
});
