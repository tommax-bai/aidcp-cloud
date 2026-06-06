import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionOrchestrator,
  type CommandSink,
} from '../src/orchestrator/index.js';
import { EventBus } from '../src/event-bus/index.js';
import { Blackboard, Arbiter } from '../src/blackboard/index.js';
import { BaseAgent } from '../src/agents/types.js';
import type { BlackboardState } from '../src/blackboard/types.js';
import type { AgentDecision, AgentRole } from '../src/event-bus/types.js';
import { loadSoul } from '../src/soul/index.js';
import type { Envelope } from '../src/comm/index.js';

const soul = loadSoul();

function collectSink(): { sink: CommandSink; sent: Envelope[] } {
  const sent: Envelope[] = [];
  return { sink: { send: (e) => sent.push(e) }, sent };
}

const memPersistence = {
  loadPool: async () => ({ known: [] as string[], candidates: [] as string[], source: new Map<string, string>() }),
  addCandidates: async (kws: string[]) => kws,
  markSearched: async () => {},
};
void memPersistence; // suppress unused warning

/** 测试用 Agent：始终激活，返回指定动作 */
class StubAgent extends BaseAgent {
  readonly role: AgentRole;
  private readonly _action: AgentDecision['action'];
  private readonly _confidence: number;
  private readonly _reason: string;

  constructor(role: AgentRole, action: AgentDecision['action'], confidence = 0.8, reason = 'stub') {
    super({ soul });
    this.role = role;
    this._action = action;
    this._confidence = confidence;
    this._reason = reason;
  }

  shouldActivate(_board: BlackboardState): boolean {
    return true;
  }

  async decide(_board: BlackboardState): Promise<AgentDecision> {
    return {
      agent: this.role,
      action: this._action,
      reason: this._reason,
      confidence: this._confidence,
      ts: Date.now(),
    };
  }
}

test('orchestrator 通过 EventBus note.arrived 触发决策，browse_next 输出', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink, sent } = collectSink();

  const agents = [
    new StubAgent('feed_scanner', 'browse_next', 0.9, '继续浏览'),
  ];

  const orch = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink,
    clock: () => 1000,
    idGen: () => 'cmd-1',
  });
  await orch.start();

  // 通过 EventBus 触发
  eventBus.emit('note.arrived', {
    note: { noteId: 'n1', title: '测试标题', summary: '摘要', likeCount: 100, collectCount: 30 },
    ts: 1000,
  });

  // 等待异步处理完成
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'browse.next');
  assert.equal(orch.session.views, 1);
  orch.stop();
});

test('orchestrator: interaction_appraiser 输出 like → stats.likes++ 且 emit interaction.occurred', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink, sent } = collectSink();

  const agents = [
    new StubAgent('interaction_appraiser', 'like', 0.9, '干货'),
    new StubAgent('feed_scanner', 'browse_next', 0.7, '继续'),
  ];

  const interactions: { action: string; noteId: string }[] = [];
  eventBus.on('interaction.occurred', (data) => { interactions.push(data); });

  const orch = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink,
    clock: () => 2000,
    idGen: () => 'cmd-2',
  });
  await orch.start();

  eventBus.emit('note.arrived', {
    note: { noteId: 'n2', title: '好内容', summary: '精华', likeCount: 500, collectCount: 100 },
    ts: 2000,
  });

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(orch.session.likes, 1);
  assert.equal(sent.length, 1);
  // Arbiter 将 like 作为 interaction 附加到导航命令上
  assert.equal((sent[0].payload as Record<string, unknown>).action, 'like');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].action, 'like');
  assert.equal(interactions[0].noteId, 'n2');
  orch.stop();
});

test('orchestrator: 全 pass 时 fallback browse_next', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink, sent } = collectSink();

  const agents = [
    new StubAgent('feed_scanner', 'pass', 0, '无意见'),
    new StubAgent('content_curator', 'pass', 0, '无意见'),
  ];

  const orch = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink,
    clock: () => 3000,
  });
  await orch.start();

  eventBus.emit('note.arrived', {
    note: { noteId: 'n3', title: '普通内容', summary: '一般', likeCount: 10, collectCount: 2 },
    ts: 3000,
  });

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'browse.next');
  orch.stop();
});

test('orchestrator.kick 下发首条 browse.next', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink, sent } = collectSink();

  const orch = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents: [],
    arbiter,
    sink,
    clock: () => 1000,
  });
  await orch.start();

  const env = orch.kick();
  assert.equal(env.type, 'browse.next');
  assert.equal(sent.length, 1);
  orch.stop();
});

test('orchestrator: Agent 失败不阻断其他 Agent', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink, sent } = collectSink();

  // 创建一个会抛错的 Agent
  class FailAgent extends BaseAgent {
    readonly role: AgentRole = 'comment_reviewer';
    constructor() { super({ soul }); }
    shouldActivate() { return true; }
    async decide(): Promise<AgentDecision> { throw new Error('模型超时'); }
  }

  const agents = [
    new FailAgent(),
    new StubAgent('feed_scanner', 'browse_next', 0.8, '正常'),
  ];

  const orch = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink,
    clock: () => 4000,
  });
  await orch.start();

  eventBus.emit('note.arrived', {
    note: { noteId: 'n4', title: '容错测试', summary: '测试', likeCount: 50, collectCount: 10 },
    ts: 4000,
  });

  await new Promise((r) => setTimeout(r, 50));

  // 尽管 comment_reviewer 失败了，仍然有输出
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'browse.next');
  orch.stop();
});

test('orchestrator: riskStatus collect 配额使用 maxCollects 而非 maxLikes', async () => {
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();
  const { sink } = collectSink();

  // 使用自定义 soul 限制
  const customSoul = {
    ...soul,
    session_limits: {
      max_duration_min: 30,
      max_likes: 10,
      max_collects: 3,
      max_searches: 5,
      cooldown_between_actions_sec: [2, 5] as [number, number],
    },
  };

  const agents = [
    new StubAgent('interaction_appraiser', 'collect', 0.9, '值得收藏'),
  ];

  const orch = new SessionOrchestrator({
    soul: customSoul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink,
    clock: () => 5000,
  });
  await orch.start();

  // 发送 3 次触发 collect，之后 collect 配额应该为 0
  for (let i = 0; i < 3; i++) {
    eventBus.emit('note.arrived', {
      note: { noteId: `n${i}`, title: `笔记${i}`, summary: '好', likeCount: 100, collectCount: 50 },
      ts: 5000 + i,
    });
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(orch.session.collects, 3);
  orch.stop();
});
