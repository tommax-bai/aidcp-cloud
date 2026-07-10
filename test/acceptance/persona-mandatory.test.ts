/**
 * 验收用例 AC-PERSONA-* — 人设必填 / 系统不存在默认兜底人设（change persona-driven-content-pipeline）。
 *
 * 红线：账号无人设时，解析器返回明确「无人设」信号（null，绝不返回默认 soul）；
 * 浏览 / 发布 / 评论三类任务在入口诚实拒绝（实现层拒绝原因统一为 needs_persona_setup，
 * 即 spec 所称 no_persona 信号的落地口径），绝不以任何默认 / 替代人设运行；
 * 面板写入空人设被拒（persona_required），不存在「清空回落默认」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaResolver } from '../../src/config/persona-store.js';
import { createPersonaPanel } from '../../src/config/persona-facade.js';
import type { PersonaStore } from '../../src/config/persona-store.js';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { PublishScheduler, type PublishSchedulerDeps } from '../../src/publish-agent/publish-scheduler.js';
import { CommentScheduler, type CommentSchedulerDeps } from '../../src/comment-agent/comment-scheduler.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/soul/types.js';

const soulYaml = `
identity:
  name: "账号甲"
  role: "美食博主"
  background: "三年探店"
  tone: "亲切"
interests:
  primary:
    - "家常菜"
  secondary:
    - "烘焙"
  seed_keywords:
    - "空气炸锅"
`;

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['x'], secondary: ['y'], seed_keywords: ['k'] },
};

const silent = { log() {}, warn() {}, error() {} };

describe('AC-PERSONA 人设必填（系统不存在默认/兜底人设）', () => {
  it('AC-PERSONA-1A 解析器：无人设/解析失败/无存储 → null 信号，绝不返回任何默认 soul、绝不抛', () => {
    // 无行 → null
    const noRow = createPersonaResolver({ store: { getForAccount: () => null } });
    assert.equal(noRow('acc-x'), null);
    // 解析失败 → warn + null（不静默替换默认人设）
    const warns: string[] = [];
    const badText = createPersonaResolver({
      store: { getForAccount: () => 'not: valid: soul: text' },
      logger: { warn: (m: string) => warns.push(m) },
    });
    assert.equal(badText('acc-bad'), null);
    assert.equal(warns.length, 1);
    // 存储不可用（fail-closed）→ null
    const noStore = createPersonaResolver({});
    assert.equal(noStore('acc-any'), null);
    // 已绑人设 → 正常解析（不误伤）
    const bound = createPersonaResolver({ store: { getForAccount: () => soulYaml } });
    assert.equal(bound('acc-ok')?.identity.name, '账号甲');
  });

  it('AC-PERSONA-1B 浏览：无人设账号握手 → 诚实拒绝启动，page.cards 不产生任何下发指令', () => {
    const rejected: { accountId: string; reason: string }[] = [];
    const commands: EdgeCommand[] = [];
    const d = new RoleDispatcher({
      getSoul: () => mockSoul,
      llm: { complete: async () => '-1' },
      sendCommand: (c) => commands.push(c),
      isPersonaBound: () => false,
      onSessionRejected: (accountId, reason) => {
        rejected.push({ accountId, reason });
      },
    });
    d.setup();
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acc-none', ts: 1 });
    assert.equal(d.active, false, '未绑人设绝不启动浏览会话');
    assert.deepEqual(rejected, [{ accountId: 'acc-none', reason: 'needs_persona_setup' }]);
    d.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: '测试', likeCount: 1, collectCount: 1, noteId: 'n1' }],
      ts: 2,
    });
    assert.equal(commands.length, 0, '未绑人设账号绝不因边缘上报产生任何指令（不在替代人设上空跑）');
    d.endSession();
  });

  it('AC-PERSONA-1C 发布：无人设账号手动/自动触发均被拒，不调编排、不生成任何内容', async () => {
    const triggered: unknown[] = [];
    const deps: PublishSchedulerDeps = {
      conceptStore: { countNewSince: async () => 99, getNewConceptsSince: async () => ['k'] },
      likedStore: { countSince: async () => 1, recentSince: async () => [] },
      publishLog: { getMostRecentPublishTime: async () => null, recentPublishedContents: async () => [] },
      resolveRisk: async () => ({ canDo: () => true, getState: () => ({ status: 'normal' }) }),
      resolveSingleAccountId: async () => 'acc-none',
      isPersonaBound: () => false,
      orchestrator: { trigger: async (input) => { triggered.push(input); return { status: 'draft' }; } },
      soul: {} as PublishSchedulerDeps['soul'],
      conceptThreshold: 1,
      minHoursBetween: 0,
      logger: silent,
    };
    const scheduler = new PublishScheduler(deps);
    const manual = await scheduler.triggerManual('acc-none');
    assert.equal(manual.result, 'blocked');
    assert.equal(manual.reason, 'needs_persona_setup');
    const auto = await scheduler.checkAndMaybeTrigger();
    assert.equal(auto.result, 'blocked');
    assert.equal(auto.reason, 'needs_persona_setup');
    assert.equal(triggered.length, 0, '未绑人设绝不进入内容生成编排');
  });

  it('AC-PERSONA-1D 评论：无人设账号 /comment 触发被拒，不接管边端、不启动任务', async () => {
    let takeovers = 0;
    const bus = new EventBus();
    const deps: CommentSchedulerDeps = {
      resolveConnection: () => ({ bus, edgeId: 'e1' }),
      pusher: { pushToEdges: () => 1 },
      edgeTaskLeases: {
        withLease: async (request, work) => work({ taskId: `task-${request.kind}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority }),
      },
      getSoul: () => mockSoul,
      isPersonaBound: () => false,
      selectCurated: async () => [],
      llmFor: () => ({ complete: async () => '{}' }),
      dedupFor: () => ({ hasInteracted: async () => false, recordInteraction: async () => {} }),
      onTakeoverStart: () => { takeovers += 1; },
      onTakeoverEnd: () => {},
      logger: { log: () => {}, warn: () => {} },
    };
    const s = new CommentScheduler(deps);
    const r = await s.triggerManual('acc-none');
    assert.equal(r.ok, false);
    assert.match(r.message, /未绑定人设/);
    assert.equal(takeovers, 0, '未绑人设绝不接管边端');
  });

  it('AC-PERSONA-1E 面板写入：空人设 persona_required 诚实拒绝、不落库（前端被绕过也挡住）', async () => {
    const rows = new Map<string, { accountId: string; persona: string; updatedAt: string | null; updatedBy: string | null }>();
    const store = {
      getRow: (id: string) => rows.get(id),
      listAccounts: async () => [{ accountId: 'acc-1', label: null }],
      accountExists: async (id: string) => id === 'acc-1',
      set: async (id: string, persona: string, by: string) => {
        const row = { accountId: id, persona, updatedAt: 't', updatedBy: by };
        rows.set(id, row);
        return row;
      },
      clear: async (id: string) => { rows.delete(id); },
    } as unknown as PersonaStore;
    const panel = createPersonaPanel({ store });
    const empty = await panel.setPersona('acc-1', '   ', 'op');
    assert.deepEqual(empty, { ok: false, reason: 'persona_required' });
    assert.equal(rows.size, 0, '空人设绝不落库');
    // 未绑账号在目录中如实标 none（不冒充任何默认人设为其生效人设）
    const catalog = await panel.getCatalog();
    assert.equal(catalog.accounts[0]?.source, 'none');
    assert.equal(catalog.accounts[0]?.identityName, '');
  });
});
