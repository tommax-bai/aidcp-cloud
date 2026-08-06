/**
 * change platform-browse-protocol (C1b) — 回执驱动迁移 / feed 自愈 / 审批期 idle 抑制 / no_target 重扫 的可测场景。
 *
 * 阶段 0（FB/XHS 两 surface 皆 detail）迁移结构性不可达 ⇒ 下方迁移用例临时把 FB read surface 置 'feed'
 * 模拟 C2 配置（before/after 恢复），验证迁移机制本身；零行为分支用真实平台（surface 相等）验证不触发。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '@automation/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import type { PlatformId, Surface } from '@automation/platform/index.js';
import { PLATFORM_REGISTRY } from '@automation/platform/registry.js';
import { EventBus } from '@automation/event-bus/index.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

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
    // 边缘是否声明 inline_targeting（就地读/赞版本偏斜闸，change facebook-feed-inline-browse）。
    // 默认 false = 老边端/今天：即便 registry read_content='feed'，effectiveReadSurface 仍回落 detail。
    inlineTargeting?: boolean;
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
    ...(opts?.inlineTargeting ? { hasInlineTargeting: () => true } : {}),
    ...(opts?.onApprovedNotDelivered ? { notifyApprovedNotDelivered: opts.onApprovedNotDelivered } : {}),
    ...(opts?.commentApproval ? { commentApproval: opts.commentApproval } : {}),
  });
  d.setup();
  d.startSession();
  return { bus, commands, d };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);

describe('C1b 回执驱动两步评论迁移（模拟 C2：FB read=feed / comment=detail）', () => {
  // 存原值再翻（robust to C2 把 registry 默认翻到 feed：afterEach 恢复原值、绝不硬写 detail 污染共享单例）。
  let originalReadSurface: Surface;
  beforeEach(() => {
    originalReadSurface = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = originalReadSurface;
  });

  it('commentSurface≠readSurface ⇒ 先 open_note{purpose:navigate}，待落地才发 comment', () => {
    const { bus, commands } = setup('facebook', { inlineTargeting: true });
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

  // change fb-comment-migration-hold：迁移在途窗口内并发 browse 命令 MUST 被扣住。否则 page.scroll 落到边缘
  // 会经 ensureFeed 看到当前 surface 是详情/群帖固定链、把浏览器整页拽回首页 ⇒ 迁移拿不到详情、已批准评论被丢。
  it('迁移在途 ⇒ 并发 page.scroll 被扣住（钉在待迁移帖），迁移 open_note{navigate} 与后续 comment 仍放行', () => {
    const { bus, commands, d } = setup('facebook', { inlineTargeting: true });
    const send = d as unknown as { sendScrollCommand(reason: string, floorMs?: number): boolean };

    // 第一步：comment.approved ⇒ 置 pendingMigration + 下发迁移 open_note{navigate}（评论支线命令，豁免自身暂停）。
    const base = commands.length;
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const afterApprove = commands.slice(base);
    assert.deepEqual(actionsOf(afterApprove), ['open_note'], '迁移第一步下发 open_note{navigate}');
    assert.equal(afterApprove[0].params?.purpose, 'navigate', '迁移 open_note 携 purpose=navigate（评论支线命令放行）');

    // 迁移在途窗口内：并发的 browse 滚动 MUST 被扣住（返回 false、绝不下发到边缘）。
    const beforeScroll = commands.length;
    const scrollSent = send.sendScrollCommand('idle_nudge');
    assert.equal(scrollSent, false, 'pendingMigration 在途 ⇒ 并发 scroll 被扣住（sendCommand 返回 false）');
    assert.equal(commands.length, beforeScroll, '被扣住的 scroll 绝不下发到边缘（commands 无新增）');

    // 第二步：navigate 落地 ⇒ 清 pendingMigration、后续 comment 放行（评论支线命令豁免；此刻闸已解除亦放行）。
    const beforeReceipt = commands.length;
    bus.emit('action.completed', { action: 'open_note', ok: true, observation: { surface: 'detail' }, noteId: 'note-42', ts: 0 });
    const afterReceipt = commands.slice(beforeReceipt);
    assert.deepEqual(actionsOf(afterReceipt), ['comment'], 'navigate 落地后 comment 放行下发（迁移窗口内未被 scroll 拽回首页）');
    assert.equal(afterReceipt[0].params?.noteId, 'note-42');
  });

  it('navigate 步失败 ⇒ 不发 comment + 显式回报操作员 + comment.done{ok:false}', () => {
    const reports: { noteId: string; reason?: string }[] = [];
    const done: { ok: boolean }[] = [];
    const { bus, commands } = setup('facebook', { inlineTargeting: true, onApprovedNotDelivered: (i) => { reports.push(i); } });
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
    const { bus, commands } = setup('facebook', { inlineTargeting: true, onApprovedNotDelivered: (i) => { reports.push(i); } });
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

  it('facebook 未声明 inline_targeting（老边端/阶段 0）：read 回落 detail ⇒ 直接发 comment、无迁移', () => {
    // 不传 inlineTargeting ⇒ effectiveReadSurface 回落 detail（无论 registry 是 detail 还是已翻 feed）。
    // 版本偏斜闸：未重打包的边缘逐位等今天，绝不被迁移撕成两步。
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const after = commands.slice(base);
    assert.ok(actionsOf(after).includes('comment'), 'FB 老边端直发 comment（零回归）');
    assert.ok(!actionsOf(after).includes('open_note'), '老边端 read=detail ⇒ 不迁移');
  });
});

describe('C1b feed 自愈：Facebook 到底切 Reels，其他平台保持 refresh', () => {
  it('facebook：scroll 回执 reason=feed_exhausted ⇒ 统一重驱到 Reels', () => {
    const { bus, commands } = setup('facebook');
    const base = commands.length;
    bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 0 });
    const after = commands.slice(base);
    assert.equal(after.filter(
      (command) => command.action === 'scroll'
        && command.reason === 'resume_redrive'
        && command.params?.targetSurface === 'reels',
    ).length, 1);
    assert.ok(!actionsOf(after).includes('refresh'), 'Facebook feed_exhausted 不再刷新同一普通 Feed');
  });

  it('xiaohongshu：scroll 回执 reason=feed_exhausted ⇒ 仍映射 refresh', () => {
    const { bus, commands } = setup('xiaohongshu');
    const base = commands.length;
    bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 0 });
    const after = commands.slice(base);
    assert.ok(actionsOf(after).includes('refresh'), '非 Facebook 保持立即 refresh 换新批');
    assert.equal(after.some(
      (command) => command.reason === 'resume_redrive'
        && command.params?.targetSurface === 'reels',
    ), false);
  });
});

describe('C1b 评论支线在途抑制 idle nudge（change comment-approval-target-hold：起点前移至 comment.appraised）', () => {
  it('评论支线在途（撰写窗起、早于 comment.cleared）idle_nudge ⇒ 不滚动；终局后 ⇒ 恢复滚动', () => {
    // 起点前移到 comment.appraised（确立要评）：覆盖撰写 / 去 AI 味 / 审批全程，撰写窗不再裸奔。
    const { bus, commands, d } = setup('xiaohongshu', { commentApproval: hangingApproval });
    d.updateNoteData({ noteId: 'note-42', title: 't', content: '正文正文', likeCount: 500, collectCount: 0 });
    bus.emit('comment.appraised', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    const beforeNudge = commands.length;
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, beforeNudge, '评论支线在途 ⇒ idle_nudge 被抑制、不把账号滚离目标');
    // 审批终局（approved 先清在途标志再发 comment 指令）
    bus.emit('comment.approved', { noteId: 'note-42', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: 0 });
    const beforeNudge2 = commands.length; // 已含 approved 触发的 comment 指令
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, beforeNudge2 + 1, '审批结束后 idle_nudge 恢复翻译成一次滚动');
    assert.equal(commands[commands.length - 1].action, 'scroll');
  });

  it('comment.appraised 的 noteId 与 currentNote 不符（composer 会同步 !note skip）⇒ 不置在途、idle_nudge 照常滚动（防卡死）', () => {
    // 起点前移后的防卡死守卫：只在 currentNote 命中时置位（= composer 走 await、不同步 skip）。
    // 不命中 ⇒ composer 同步 emit comment.skipped 先于本处理器；若无条件置真则永久抑制卡死浏览。
    const { bus, commands, d } = setup('xiaohongshu');
    d.updateNoteData({ noteId: 'note-42', title: 't', content: '正文正文', likeCount: 500, collectCount: 0 });
    bus.emit('comment.appraised', { noteId: 'OTHER', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    const before = commands.length;
    bus.emit('session.idle_nudge', { reason: 'idle', ts: 0 });
    assert.equal(commands.length, before + 1, '未进入在途暂停态 ⇒ idle_nudge 照常滚动（防卡死回归）');
    assert.equal(commands[commands.length - 1].action, 'scroll');
  });
});

describe('C1b feed-surface no_target(stale) ⇒ 重扫换批（模拟 C2 read=feed）', () => {
  let originalReadSurface: Surface;
  beforeEach(() => {
    originalReadSurface = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = originalReadSurface;
  });

  it('facebook feed-surface like no_target ⇒ 发 rescan 滚动', () => {
    const { bus, commands } = setup('facebook', { inlineTargeting: true });
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

// change facebook-feed-inline-browse（C2 就地读云端接线）：content.valuable ⇒ open_note 是否携 surface:'feed'。
// 这是「开关打开」的命令脊柱——effectiveReadSurface==='feed'（registry 翻转 + 边缘声明 inline_targeting）才带
// surface，让边缘就地展开读；否则省略字段 ⇒ 边缘走 detail（逐位等今天）。含版本偏斜闸与 XHS 零回归两反例。
describe('C2 就地读接线：content.valuable ⇒ open_note surface（版本偏斜闸）', () => {
  let originalReadSurface: Surface;
  beforeEach(() => {
    originalReadSurface = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  });
  afterEach(() => {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = originalReadSurface;
  });

  const emitValuable = (bus: EventBus) =>
    bus.emit('content.valuable', {
      index: 0,
      noteId: 'note-1',
      title: 't',
      reason: '内容相关',
      confidence: 0.9,
      sourcePageType: 'feed',
      ts: 0,
    });
  const openNoteOf = (commands: EdgeCommand[], base: number) =>
    commands.slice(base).find((c) => c.action === 'open_note');

  it('registry feed + 边缘声明 inline_targeting ⇒ open_note 携 surface:feed（就地读）', () => {
    const { bus, commands } = setup('facebook', { inlineTargeting: true });
    const base = commands.length;
    emitValuable(bus);
    const open = openNoteOf(commands, base);
    assert.ok(open, 'open_note 已发');
    assert.equal(open!.params?.surface, 'feed', '就地读 ⇒ 携 surface:feed');
  });

  it('registry feed 但边缘未声明 inline_targeting（老边端）⇒ open_note 省略 surface（=今天 detail）', () => {
    const { bus, commands } = setup('facebook'); // 无 inlineTargeting
    const base = commands.length;
    emitValuable(bus);
    const open = openNoteOf(commands, base);
    assert.ok(open, 'open_note 已发');
    assert.equal(open!.params?.surface, undefined, '老边端 ⇒ 无 surface 字段（版本偏斜闸回落 detail、逐位不变）');
  });

  it('xhs（registry detail）+ 边缘声明 inline_targeting ⇒ 仍省略 surface（零回归）', () => {
    const { bus, commands } = setup('xiaohongshu', { inlineTargeting: true });
    const base = commands.length;
    emitValuable(bus);
    const open = openNoteOf(commands, base);
    assert.ok(open, 'open_note 已发');
    assert.equal(open!.params?.surface, undefined, 'xhs read=detail ⇒ 永不携 surface（能力不改 registry 值）');
  });
});
