/**
 * change platform-browse-protocol (C1b) — 回执驱动迁移 / feed 自愈 / 审批期 idle 抑制 / no_target 重扫 的可测场景。
 *
 * 阶段 0（FB/XHS 两 surface 皆 detail）迁移结构性不可达 ⇒ 下方迁移用例临时把 FB read surface 置 'feed'
 * 模拟 C2 配置（before/after 恢复），验证迁移机制本身；零行为分支用真实平台（surface 相等）验证不触发。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { PlatformId } from '../../src/platform/index.js';
import { PLATFORM_REGISTRY } from '../../src/platform/registry.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'skip' };

// 接线态人审口桩：request 挂起（永不 resolve）⇒ gate 在 `await request` 处挂起、绝不自己 emit 终局，
// 由测试手动 emit comment.approved/skipped 控制审批终局；用于验证「真接线且真在等」时才抑制 idle。
const hangingApproval = {
  request: () => new Promise<void>(() => {}),
  isApproved: async () => false,
};

function setup(
  accountPlatform: PlatformId,
  opts?: {
    onApprovedNotDelivered?: (i: { noteId: string; reason?: string }) => void;
    commentApproval?: { request: (input: unknown) => Promise<void>; isApproved: (id: string) => Promise<boolean> };
  },
) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract: () => true,
    accountPlatform,
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
    ...(opts?.onApprovedNotDelivered ? { notifyApprovedNotDelivered: opts.onApprovedNotDelivered } : {}),
    ...(opts?.commentApproval ? { commentApproval: opts.commentApproval } : {}),
  });
  d.setup();
  d.startSession();
  return { bus, commands, d };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);

describe('C1b 回执驱动两步评论迁移（模拟 C2：FB read=feed / comment=detail）', () => {
  beforeEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'detail';
  });

  it('commentSurface≠readSurface ⇒ 先 open_note{purpose:navigate}，待落地才发 comment', () => {
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const afterApprove = commands.slice(base);
    assert.deepEqual(actionsOf(afterApprove), ['open_note'], '迁移第一步只发 open_note、尚未发 comment');
    assert.equal(afterApprove[0].params?.purpose, 'navigate', 'open_note 携 purpose=navigate');
    assert.ok(!actionsOf(afterApprove).includes('comment'), 'navigate 未落地前 MUST NOT 发 comment');

    // 第二步：navigate 落地确认（observation.surface='detail' + noteId 匹配）⇒ 才发 comment
    const beforeReceipt = commands.length;
    bus.emit('action.completed', { action: 'open_note', ok: true, observation: { surface: 'detail' }, noteId: 'note-42', ts: 0 });
    const afterReceipt = commands.slice(beforeReceipt);
    assert.deepEqual(actionsOf(afterReceipt), ['comment'], 'navigate 落地后恰好发一次 comment');
    assert.equal(afterReceipt[0].params?.noteId, 'note-42');
  });

  it('navigate 步失败 ⇒ 不发 comment + 显式回报操作员 + comment.done{ok:false}', () => {
    const reports: { noteId: string; reason?: string }[] = [];
    const done: { ok: boolean }[] = [];
    const { bus, commands } = setup('facebook', { onApprovedNotDelivered: (i) => { reports.push(i); } });
    bus.on('comment.done', (p) => { done.push({ ok: p.ok }); });
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const before = commands.length;
    bus.emit('action.completed', { action: 'open_note', ok: false, reason: 'nav_failed', ts: 0 });
    const after = commands.slice(before);
    assert.ok(!actionsOf(after).includes('comment'), 'navigate 失败 ⇒ 绝不在当前页发 comment（fail-closed）');
    assert.equal(reports.length, 1, '显式回报操作员一次');
    assert.equal(reports[0].noteId, 'note-42');
    assert.deepEqual(done, [{ ok: false }], 'emit comment.done{ok:false} 关闭评论支线');
  });

  it('navigate ok 但回执缺派生 noteId ⇒ fail-closed 判失败（绝不把已批准评论发到未证实目标）', () => {
    const reports: { noteId: string; reason?: string }[] = [];
    const { bus, commands } = setup('facebook', { onApprovedNotDelivered: (i) => { reports.push(i); } });
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const before = commands.length;
    // observation.surface=detail 但**无 noteId** ⇒ 未证实落地目标 ⇒ 不发 comment。
    bus.emit('action.completed', { action: 'open_note', ok: true, observation: { surface: 'detail' }, ts: 0 });
    const after = commands.slice(before);
    assert.ok(!actionsOf(after).includes('comment'), '缺派生 noteId ⇒ 不发 comment（spec 要求 detail-surface 且 noteId 匹配）');
    assert.equal(reports.length, 1, '缺 noteId 也走已批准未送达回报');
  });
});

describe('C1b 迁移阶段 0 零行为（真实平台 surface 相等 ⇒ 不迁移）', () => {
  it('xhs：comment.approved ⇒ 直接发 comment、无 open_note{navigate}', () => {
    const { bus, commands } = setup('xiaohongshu');
    const base = commands.length;
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const after = commands.slice(base);
    assert.ok(actionsOf(after).includes('comment'), 'xhs 直发 comment（零回归）');
    assert.ok(!actionsOf(after).includes('open_note'), 'surface 相等 ⇒ 结构性不迁移，不发 navigate open_note');
  });

  it('facebook（stage 0 read=detail）：comment.approved ⇒ 直接发 comment、无迁移', () => {
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const after = commands.slice(base);
    assert.ok(actionsOf(after).includes('comment'), 'FB 阶段 0 直发 comment（零回归）');
    assert.ok(!actionsOf(after).includes('open_note'), '阶段 0 两 surface 皆 detail ⇒ 不迁移');
  });
});

describe('C1b feed 自愈：feed_exhausted ⇒ 立即 refresh', () => {
  it('facebook：scroll 回执 reason=feed_exhausted ⇒ 映射 refresh（避免 idle 空转）', () => {
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 0 });
    const after = commands.slice(base);
    assert.ok(actionsOf(after).includes('refresh'), 'feed_exhausted ⇒ 立即 refresh 换新批');
  });
});

describe('C1b 审批在途抑制 idle nudge（不复用 pauseClock）', () => {
  it('接线态 xhs：真在等人审时 idle_nudge ⇒ 不滚动；审批终局后 ⇒ 恢复滚动', () => {
    // 接线态：comment.cleared → gate.onCleared 挂在 `await request`（不同步 skip）⇒ dispatcher 置 approvalInFlight。
    const { bus, commands } = setup('xiaohongshu', { commentApproval: hangingApproval });
    bus.emit('comment.cleared', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const beforeNudge = commands.length;
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, beforeNudge, '真审批在途 ⇒ idle_nudge 被抑制、不把账号滚离目标');
    // 审批终局（手动 emit comment.approved 清标志；同时发出 comment 指令）
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const beforeNudge2 = commands.length; // 已含 approved 触发的 comment 指令
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, beforeNudge2 + 1, '审批结束后 idle_nudge 恢复翻译成一次滚动');
    assert.equal(commands[commands.length - 1].action, 'scroll');
  });

  it('未接线态（默认）xhs：comment.cleared ⇒ gate 同步 skip、绝不卡死抑制，idle_nudge 照常滚动（Finding 1 回归修复）', () => {
    // 人审口未接线（默认支持配置）：CommentApprovalGate 在同一 emit 内同步 skip → comment.skipped。
    // 修复前 comment.cleared 无条件置 true 会被嵌套 skip 清后再置回 true「卡死」⇒ idle_nudge 永久被抑制。
    const { bus, commands } = setup('xiaohongshu'); // 无 commentApproval
    bus.emit('comment.cleared', { noteId: 'n', sourcePageType: 'feed', actions: ['like'], text: 't', ts: 0 });
    const before = commands.length;
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, before + 1, '未接线=从不真等人审 ⇒ 不抑制，idle_nudge 恢复滚动（防卡死回归）');
    assert.equal(commands[commands.length - 1].action, 'scroll');
  });
});

describe('C1b feed-surface no_target(stale) ⇒ 重扫换批（模拟 C2 read=feed）', () => {
  beforeEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'detail';
  });

  it('facebook feed-surface like no_target ⇒ 发 rescan 滚动', () => {
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'no_target', ts: 0 });
    const after = commands.slice(base);
    assert.ok(
      after.some((c) => c.action === 'scroll' && c.reason === 'rescan_after_stale_target'),
      'feed-surface no_target(stale) ⇒ 重扫换批重选',
    );
  });

  it('xhs 详情页 like no_target ⇒ 不重扫（readSurface=detail，不触发 feed 重扫分支）', () => {
    const { bus, commands } = setup('xiaohongshu');
    const base = commands.length;
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'no_target', ts: 0 });
    const after = commands.slice(base);
    assert.ok(
      !after.some((c) => c.action === 'scroll' && c.reason === 'rescan_after_stale_target'),
      'detail-surface ⇒ 不进 feed 重扫分支（零回归，like 仍在 noRecoverScroll 内不误滚详情页）',
    );
  });
});
