# 浏览会话编排架构

## 1. 概览

### 事件驱动编排架构

系统采用**事件驱动 + 黑板 + 多 Agent 并行 + 仲裁器**模式，替代了原来的 ManagerAgent 单体决策链。核心变化：

- 不再有 `ManagerAgent` 类和 `EngagementDecider`——它们的职能被拆分为 5 个独立 Agent
- 编排通过 `EventBus` 异步驱动，`handler.ts` 中 `eventBus` 为强制依赖
- 每轮决策由 `SessionOrchestrator` 协调：黑板写入上下文 → 多 Agent 并行决策 → 仲裁器合并为最终命令

### 系统架构总览

```
┌───────────────────────────────────────────────────────────────────┐
│                     aidcp-cloud (server.ts)                        │
│                                                                   │
│  ┌──────────┐   ┌───────────────────────────────────────────┐    │
│  │ Feishu   │   │        SessionOrchestrator                │    │
│  │ Receiver │   │                                           │    │
│  └────┬─────┘   │  ┌───────────┐   ┌─────────────────────┐ │    │
│       │         │  │ Blackboard│   │   5 独立 Agents      │ │    │
│       │         │  │ (共享状态) │   │  (并行 decide)       │ │    │
│       │         │  └─────┬─────┘   └──────────┬──────────┘ │    │
│       │         │        │                     │            │    │
│       │         │  ┌─────┴─────────────────────┴──────┐     │    │
│       │         │  │         Arbiter (仲裁器)          │     │    │
│       │         │  └──────────────┬───────────────────┘     │    │
│       │         └─────────────────┼─────────────────────────┘    │
│       │                           │                              │
│       │           ┌───────────────┼───────────────┐              │
│       │           │         EventBus              │              │
│       │           │  (模块间解耦异步通信)          │              │
│       │           └───────────────┼───────────────┘              │
│       │                           │                              │
│  ┌────┴───────┐  ┌───────────────┴──────┐  ┌────────────────┐   │
│  │ Risk       │  │ EdgeCloudServer       │  │ Concept        │   │
│  │ Controller │  │ (WebSocket)           │  │ Extractor      │   │
│  └────────────┘  └──────────┬────────────┘  └────────────────┘   │
└──────────────────────────────┼───────────────────────────────────┘
                               │ ws://
                        ┌──────┴──────┐
                        │  Edge 节点   │
                        │ (浏览器自动化)│
                        └─────────────┘
```

### 与其它模块的关系

| 模块 | 关系 |
|------|------|
| `event-bus/` | 核心通信机制，定义所有事件类型（`EventMap`）与领域类型（`ManagerDecision`、`SessionStats` 等） |
| `blackboard/` | Agent 间的共享状态容器，编排器写入上下文、Agent 写回决策、仲裁器产出最终命令 |
| `agents/` | 5 个独立 Agent（`SessionMonitor`、`FeedScanner`、`ContentCurator`、`InteractionAppraiser`、`CommentReviewer`） |
| `risk/` | 提供 `RiskStatus`（剩余配额、viewOnly 标志），影响可用动作集合；`RiskController` 订阅 `interaction.occurred` 事件 |
| `cache/` | `ConceptPersistence` 接口可对接 PG 实现，持久化概念池 |
| `llm/` | `FeedScanner`、`ContentCurator`、`InteractionAppraiser` 通过 `LlmClient` 调用 Qwen |
| `comm/` | 通过协议信封（`Envelope`）与 edge 通信；`handler.ts` 接收 `note.content` 后直接 `eventBus.emit('note.arrived')` |
| `soul/` | Soul 人设配置驱动各 Agent 的 prompt 和行为偏好 |

---

## 2. EventBus 事件机制

### 设计理念

`EventBus` 是系统内模块间解耦通信的核心。采用 **typed EventEmitter** 模式，所有事件类型在 `EventMap` 接口中静态声明，提供编译时类型安全。

关键特性：
- **fire-and-forget 语义**：`emit()` 同步触发，handler 异常不阻塞其他订阅者
- **异步触发**：`emitAsync()` 等待所有 handler resolve
- **通配监听**：`onAny()` 可监听所有事件（调试/日志用途）
- **自动取消**：`on()` 返回取消订阅函数

### 事件定义（EventMap）

```typescript
interface EventMap {
  'note.arrived': { note: IncomingNote; ts: number };
  'blackboard.updated': { field: string };
  'agent.decided': { agent: AgentRole; decision: AgentDecision };
  'round.complete': { decisions: Map<AgentRole, AgentDecision> };
  'command.ready': { command: ManagerDecision; envelope: Envelope };
  'session.started': { sessionId: string };
  'session.ended': { stats: SessionStats };
  'interaction.occurred': { action: 'like' | 'collect'; noteId: string };
  'concept.discovered': { concepts: string[]; source: string };
}
```

### 事件流转示意

```
Edge → handler.ts (note.content 消息)
    → eventBus.emit('note.arrived', { note, ts })
        → SessionOrchestrator.onNoteArrived(note)
            → 黑板 reset + setInput
            → Agent 并行 decide
            → Arbiter 仲裁
            → sink.send(envelope)
            → eventBus.emit('command.ready', ...)
            → eventBus.emit('interaction.occurred', ...) [如有互动]
                → ConceptExtractor 异步抽取概念
                → RiskController 异步记录
```

---

## 3. SessionOrchestrator

### 职责

`SessionOrchestrator`（`src/orchestrator/session-orchestrator.ts`）是浏览会话的顶层控制器：

1. **会话生命周期管理**：`start()` 初始化 → 订阅 `note.arrived` → `stop()` 清理
2. **黑板写入**：将上下文（笔记、统计、风控状态、可用动作）写入 Blackboard
3. **Agent 调度**：根据 `shouldActivate()` 筛选激活 Agent，通过 `Promise.allSettled` 并行执行
4. **仲裁触发**：调用 `Arbiter.arbitrate()` 合并决策为最终命令
5. **命令下发**：翻译为协议信封，通过 `CommandSink` 下发给 edge
6. **统计维护**：维护 `SessionStats`
7. **事件发射**：发射 `command.ready`、`interaction.occurred` 等跨模块事件

### 生命周期

```
start()
  ├── 加载概念池（ConceptPersistence）
  ├── 初始化 SessionStats
  ├── 订阅 eventBus 'note.arrived'
  └── emit 'session.started'

  │── onNoteArrived(note) [每条笔记触发]
  │     1. 更新 sessionStats (views++, durationMs)
  │     2. 计算 riskStatus（基于 soul.session_limits）
  │     3. 计算 availableActions（基于 pageType + riskStatus）
  │     4. blackboard.reset() + blackboard.setInput(...)
  │     5. 筛选激活 Agent：agents.filter(a => a.shouldActivate(board))
  │     6. blackboard.setExpectedAgents(activeAgents)
  │     7. Promise.allSettled — 并行调用 agent.decide(board)
  │     8. 各 Agent 决策写入黑板（失败则写入 pass）
  │     9. arbiter.arbitrate(board) → finalCommand
  │    10. 更新互动统计 (likes++/collects++/searches++)
  │    11. toEnvelope(command) → sink.send(envelope)
  │    12. emit 'command.ready' + 'interaction.occurred'（如有）
  │
stop()
  ├── 取消 eventBus 订阅
  └── emit 'session.ended'
```

### 构造参数

```typescript
interface SessionOrchestratorOptions {
  soul: Soul;              // 人设配置
  eventBus: EventBus;      // 事件总线
  blackboard: Blackboard;  // 黑板
  agents: BaseAgent[];     // Agent 列表
  arbiter: Arbiter;        // 仲裁器
  sink: CommandSink;       // 命令下发
  persistence?: ConceptPersistence;  // 概念池持久化
  clock?: () => number;    // 时钟（测试注入）
  idGen?: () => string;    // ID 生成（测试注入）
}
```

### SessionStats

| 字段 | 类型 | 说明 |
|------|------|------|
| `startedAt` | `number` | 会话开始时间戳 |
| `durationMs` | `number` | 会话已持续时长 |
| `views` | `number` | 浏览笔记数 |
| `likes` | `number` | 点赞数 |
| `collects` | `number` | 收藏数 |
| `searches` | `number` | 搜索数 |
| `follows` | `number` | 关注数（预留） |

---

## 4. 独立 Agent 体系

### 架构设计

所有 Agent 继承 `BaseAgent` 抽象类（`src/agents/types.ts`），实现两个核心方法：

```typescript
abstract class BaseAgent {
  abstract readonly role: AgentRole;
  abstract shouldActivate(board: BlackboardState): boolean;
  abstract decide(board: BlackboardState): Promise<AgentDecision>;
}
```

设计原则：
- Agent **仅依赖 BlackboardState 接口**读取上下文，不直接操作 EventBus 或 Blackboard 实例
- 单个 Agent 失败不影响其他 Agent（`Promise.allSettled`）
- 通过 `AgentDecision` 的 `veto` 和 `gate` 字段实现优先级控制

### AgentDecision 结构

```typescript
interface AgentDecision {
  agent: AgentRole;
  action: ManagerActionName | 'pass';  // 'pass' = 无意见
  params?: Record<string, unknown>;
  reason: string;
  confidence: number;         // 0-1
  veto?: boolean;             // true = 否决其他所有决策
  gate?: { blocks: AgentRole[] };  // 质量门控：阻断下游 Agent
  ts: number;
}
```

### 5 个独立 Agent

#### SessionMonitor — 会话健康度监控

- **角色**：`session_monitor`
- **依赖**：纯规则引擎，无 LLM
- **激活条件**：每轮必激活
- **职责**：
  - 检查会话时长超限 → `veto: true` + `end_session`
  - 检查互动配额全部耗尽 → `veto: true` + `end_session`
  - 冷启动检测（`views < 5`） → `gate: { blocks: ['interaction_appraiser'] }`
- **硬上限**（来自 `soul.session_limits`）：
  - `max_duration_min`：10 分钟
  - `max_likes`：8 次
  - `max_collects`：5 次
  - `max_searches`：3 次

#### FeedScanner — 信息流筛选

- **角色**：`feed_scanner`
- **依赖**：LLM（必须）
- **激活条件**：`pageType === 'feed' || pageType === 'search'`
- **职责**：
  - 从可见卡片中选择值得打开的内容
  - 基于 Soul 兴趣与概念池关键词做筛选
  - 输出：`open_note`（含 `params.index`）或 `scroll`

#### ContentCurator — 内容质量评估

- **角色**：`content_curator`
- **依赖**：LLM（必须）
- **激活条件**：`pageType === 'note' && currentNote !== null`
- **职责**：
  - 评估笔记内容质量（原创性、深度、数据支撑）
  - 质量差 → `close_note` + `gate: { blocks: ['interaction_appraiser'] }`（阻断互动）
  - 质量好 → `pass`（让互动 Agent 决定）

#### InteractionAppraiser — 互动决策

- **角色**：`interaction_appraiser`
- **依赖**：LLM（必须）
- **激活条件**：`pageType === 'note' && currentNote !== null`
- **职责**：
  - 综合笔记内容与剩余预算，决定 `like` / `collect` / `pass`
  - 替代了原来的 `EngagementDecider`
  - 若 `availableActions` 中无 like/collect，直接 pass 不调 LLM
  - 决策逻辑：
    - `collect`：内容值得反复查看、有实操步骤、代码/配置等可复用知识（更稀有更谨慎）
    - `like`：内容有启发但不需反复参考
    - `pass`：不够格互动

#### CommentReviewer — 评论区质量审查（预留）

- **角色**：`comment_reviewer`
- **依赖**：无（当前协议未传递评论数据）
- **激活条件**：当前始终返回 `false`（待协议补充评论数据后启用）
- **职责**：分析评论区 top 评论，辅助调整互动决策的 confidence

---

## 5. Blackboard 与 Arbiter

### Blackboard（黑板）

共享状态容器，连接编排器与 Agent：

```typescript
interface BlackboardState {
  // 输入区（Orchestrator 写入）
  currentNote: IncomingNote | null;
  pageType: PageType;
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
  loginState: LoginState;
  conceptPool: ConceptPool;
  availableActions: ManagerActionName[];

  // Agent 决策区
  decisions: Map<AgentRole, AgentDecision>;

  // 输出区（仲裁器写入）
  finalCommand: ManagerDecision | null;
}
```

核心方法：
- `setInput(...)` — Orchestrator 写入当前轮上下文
- `writeDecision(decision)` — Agent 写入各自决策，触发 `agent.decided` 事件
- `setExpectedAgents(agents)` — 设定本轮预期 Agent，用于判定 round 完成
- `setFinalCommand(command)` — 仲裁器写入最终命令

### Arbiter（仲裁器）

纯逻辑（无 LLM），合并所有 Agent 决策为最终命令：

**优先级规则**：
1. **Veto 否决**（最高优先级）：带 `veto: true` 的决策直接采纳，多个 veto 按固定优先级排序
2. **Gate 门控**：收集被 gate 阻断的 Agent，忽略其决策
3. **分类合并**：
   - 导航类（`browse_next`/`scroll`/`open_note`/`close_note`/`search`/`end_session`）：选 confidence 最高的
   - 互动类（`like`/`collect`）：附加到导航命令上
   - 终止动作（`close_note`/`end_session`）不附加互动
4. **全 Pass Fallback**：所有 Agent 均 pass → `browse_next`

Veto 优先级（索引越小越高）：
```
session_monitor > content_curator > interaction_appraiser > feed_scanner > comment_reviewer
```

---

## 6. 数据流

### 完整数据链路（从消息到达到命令下发）

```
Edge 上报 note.content
      │
      ▼
┌──────────────────────────────────────────────────────┐
│ handler.ts (DefaultMessageHandler)                   │
│                                                      │
│  case 'note.content':                                │
│    字段映射 edge payload → IncomingNote              │
│    eventBus.emit('note.arrived', { note, ts })       │
│    return 'note.ack'（立即回复 Edge）                │
└──────────────────────────────────────────────────────┘
      │ EventBus 'note.arrived'
      ▼
┌──────────────────────────────────────────────────────┐
│ SessionOrchestrator.onNoteArrived(note)              │
│                                                      │
│  1. 更新统计 (views++, durationMs)                   │
│                                                      │
│  2. 计算 riskStatus                                  │
│     (基于 soul.session_limits 与当前统计)            │
│                                                      │
│  3. 计算 availableActions                            │
│     (基于 pageType + loginState + riskStatus)        │
│                                                      │
│  4. blackboard.reset() + setInput(...)               │
│     写入 currentNote/pageType/stats/risk/pool/actions│
│                                                      │
│  5. 筛选激活 Agent                                   │
│     agents.filter(a => a.shouldActivate(board))      │
│                                                      │
│  6. 并行决策                                         │
│     Promise.allSettled(agents.map(a => a.decide()))  │
│     → 结果写入 blackboard.writeDecision()           │
│                                                      │
│  7. 仲裁                                             │
│     arbiter.arbitrate(board) → ManagerDecision       │
│     { action, params?, reason, interaction? }        │
│                                                      │
│  8. 翻译 & 下发                                      │
│     toEnvelope(command) → sink.send(envelope)        │
│                                                      │
│  9. 发射跨模块事件                                   │
│     emit('command.ready', ...)                        │
│     emit('interaction.occurred', ...) [如有互动]     │
└──────────────────────────────────────────────────────┘
      │
      ▼
Edge 接收协议命令并执行
      │
      │ [异步副作用，由 EventBus 订阅触发]
      ▼
┌──────────────────────────────────────────────────────┐
│ ConceptExtractor (订阅 interaction.occurred)          │
│   → 抽取新概念 → emit('concept.discovered')          │
│                                                      │
│ RiskController (订阅 interaction.occurred)            │
│   → 记录互动动作到滑动窗口计数器                     │
└──────────────────────────────────────────────────────┘
```

### 协议翻译（toEnvelope）

| ManagerDecision action | 协议消息类型 | payload |
|------------------------|-------------|---------|
| `browse_next` | `browse.next` | `{ reason }` |
| `scroll` | `browse.scroll` | `{ reason }` |
| `open_note` | `note.open` | `{ noteId?, index?, reason }` |
| `close_note` | `note.close` | `{ reason }` |
| `like` / `collect` | `browse.next` | `{ reason }` + 附加 `action` 字段 |
| `search` | `search.execute` | `{ keyword, source: 'manager', maxResults }` |
| `end_session` | `session.end` | `{ reason, stats }` |

### 动作集合

| 动作 | 含义 | 协议消息类型 |
|------|------|-------------|
| `browse_next` | 滑到下一条笔记 | `browse.next` |
| `scroll` | 当前页面滚动 | `browse.scroll` |
| `like` | 点赞当前笔记 | `browse.next`（附带 action=like） |
| `collect` | 收藏当前笔记 | `browse.next`（附带 action=collect） |
| `search` | 执行关键词搜索 | `search.execute` |
| `open_note` | 打开一条笔记 | `note.open` |
| `close_note` | 关闭当前笔记 | `note.close` |
| `end_session` | 结束浏览会话 | `session.end` |

### availableActions 计算逻辑

```typescript
// 基础动作
const actions = ['browse_next', 'scroll', 'end_session'];

// feed/search 页面
if (pageType === 'feed' || pageType === 'search') actions.push('open_note');

// note 页面
if (pageType === 'note') {
  actions.push('close_note');
  if (loginState !== 'logged_out' && !risk.viewOnly && hasNoteContent) {
    if (remainingActionsToday.like > 0) actions.push('like');
    if (remainingActionsToday.collect > 0) actions.push('collect');
  }
}
actions.push('search');
```

---

## 7. 风控集成

### 会话级风控（SessionOrchestrator 内部）

SessionOrchestrator 基于 `soul.session_limits` 自行计算剩余配额：

```typescript
private riskStatus(): RiskStatus {
  const maxLikes = soul.session_limits?.max_likes ?? 8;
  const maxCollects = soul.session_limits?.max_collects ?? 5;
  const maxSearches = soul.session_limits?.max_searches ?? 3;
  return {
    status: 'normal',
    quotaLevel: 'normal',
    remainingActionsToday: {
      view: Number.MAX_SAFE_INTEGER,
      like: Math.max(0, maxLikes - stats.likes),
      collect: Math.max(0, maxCollects - stats.collects),
      search: Math.max(0, maxSearches - stats.searches),
      follow: Number.MAX_SAFE_INTEGER,
    },
    viewOnly: false,
  };
}
```

配额如何影响决策：
- `remainingActionsToday.like ≤ 0` → `like` 从 `availableActions` 中移除
- `remainingActionsToday.collect ≤ 0` → `collect` 从 `availableActions` 中移除
- `InteractionAppraiser` 检测到无可用互动动作时直接 pass，不调 LLM

### SessionMonitor Agent 的硬约束

- 会话时长超限 → `veto: true, action: 'end_session'`
- 所有互动配额耗尽 → `veto: true, action: 'end_session'`
- 冷启动阶段（`views < 5`） → `gate: { blocks: ['interaction_appraiser'] }`（硬性阻断互动）

### 全局风控层（RiskController）

独立于编排器，作为跨会话的长期风控：

- 基于**滑动窗口计数器**（分钟/小时/天三级窗口）
- 状态机：`normal → warned → restricted → frozen`
- 点赞率约束：`like/view ≤ 35%`（当日浏览量 ≥ 10 时生效）

RiskController 通过 EventBus 订阅 `interaction.occurred` 事件自动记录：

```typescript
eventBus.on('interaction.occurred', (evt) => {
  riskController.record(evt.action);
});
```

### 风控协议消息（Edge ↔ Cloud）

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `session.budget.request` | Edge → Cloud | 请求会话预算参数 |
| `session.budget` | Cloud → Edge | 下发预算（quotaLevel/maxActions/viewOnly） |
| `risk.canDo` | Edge → Cloud | 询问某动作是否可执行 |
| `risk.canDo.result` | Cloud → Edge | 回复是否允许 + 原因 |
| `risk.record` | Edge → Cloud | 上报已执行的动作 |
| `risk.record.result` | Cloud → Edge | 确认记录 |

---

## 8. AgentOrchestrator（备用编排方案）

系统中还存在一个 `AgentOrchestrator`（`src/orchestrator/agent-orchestrator.ts`），它采用**事件流驱动的循环收敛**模式：

- 所有已注册的 `RoleAgent` 每轮并发执行（`Promise.all`）
- 循环直到一轮下来无新事件产出（事件流稳定）
- 从事件流中 harvest 最终 `ManagerDecision`

harvest 优先级：`session.verdict deny > interaction.decision > feed.decision > fallback`

该方案与 `SessionOrchestrator` 的黑板 + 仲裁器模式并存，作为更松耦合的编排方式。当前生产入口使用 `SessionOrchestrator`。

---

## 9. 配置与扩展

### 如何添加新 Agent

1. 在 `src/agents/` 下创建新文件，继承 `BaseAgent`
2. 实现 `role`（需在 `AgentRole` 联合类型中注册）、`shouldActivate()`、`decide()`
3. 在 `src/agents/index.ts` 中导出
4. 在 `src/server.ts` 的 `agents` 数组中实例化并注册
5. 如需门控/否决能力，在 `AgentDecision` 中设置 `veto` 或 `gate` 字段
6. 如需调整仲裁优先级，修改 `src/blackboard/arbiter.ts` 的 `VETO_PRIORITY`

### 如何添加新事件

1. 在 `src/event-bus/types.ts` 的 `EventMap` 接口中添加新事件签名
2. 在发射端调用 `eventBus.emit('new.event', payload)`
3. 在订阅端调用 `eventBus.on('new.event', handler)` 注册处理逻辑
4. 编译时类型检查确保 payload 结构正确

### 如何添加新动作

1. 在 `event-bus/types.ts` 的 `ManagerActionName` 联合类型中添加新动作名
2. 在 `SessionOrchestrator.computeAvailableActions()` 中定义激活条件
3. 在 `SessionOrchestrator.toEnvelope()` 的 switch 中添加协议翻译
4. 在 `comm/protocol.ts` 中定义对应的 `MessageType` 和 payload 接口
5. 在相关 Agent 的 prompt 中添加新动作说明

### 如何调整行为参数

| 参数 | 文件 | 修改效果 |
|------|------|----------|
| 会话上限 | `src/soul/soul.yaml` → `session_limits` | 调整浏览时长、互动次数上限 |
| 兴趣偏好 | `src/soul/soul.yaml` → `interests` | 影响内容筛选方向 |
| 互动标准 | `src/soul/soul.yaml` → `behavior_guidelines` | 改变点赞/收藏的严格程度 |
| 冷启动阈值 | `src/agents/session-monitor.ts` → `views < 5` | 调整冷启动结束条件 |
| 仲裁优先级 | `src/blackboard/arbiter.ts` → `VETO_PRIORITY` | 调整 Agent 否决优先级 |
| 概念长度上限 | `src/orchestrator/concept-extractor.ts` → `MAX_CONCEPT_LEN`（30） | 过滤过长的概念字符串 |

---

## 10. 关键设计决策

1. **事件驱动 + 黑板 vs 单体 ManagerAgent**  
   拆分为独立 Agent 后，每个 Agent 职责单一、可独立测试、可独立失败。仲裁器合并决策避免单点故障。

2. **并行 decide + allSettled**  
   Agent 间无依赖可并行执行，`allSettled` 确保单个 Agent 失败不影响整体。

3. **Gate 门控机制**  
   `ContentCurator` 判定内容质量差时，通过 gate 硬性阻断 `InteractionAppraiser`，避免对低质内容误互动。

4. **Veto 否决机制**  
   `SessionMonitor` 超限时直接否决所有决策，确保安全约束不可被绕过。

5. **编排器不直接依赖网络**  
   命令通过注入的 `CommandSink` 接口下发，所有外部依赖通过构造函数注入，保持可测试性。

6. **EventBus 强制依赖**  
   `handler.ts` 中 `eventBus` 为必传参数，移除了原来的同步 fallback 路径。消息处理通过事件解耦为纯异步流。

7. **Fallback 为 browse_next**  
   任何异常情况下默认执行 `browse_next`——最安全的动作（只浏览、不互动、不结束会话）。
