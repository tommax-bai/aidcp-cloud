# 浏览会话编排架构

## 1. 概览

### 编排系统在整体架构中的位置

```
┌─────────────────────────────────────────────────────────┐
│                    aidcp-cloud (server.ts)               │
│                                                         │
│  ┌──────────┐   ┌──────────────────┐   ┌────────────┐  │
│  │ Feishu   │   │  SessionOrch-    │   │  Risk      │  │
│  │ Receiver │   │  estrator        │   │  Controller│  │
│  └────┬─────┘   └───────┬──────────┘   └─────┬──────┘  │
│       │                  │                    │          │
│       │         ┌────────┼────────┐           │          │
│       │         │        │        │           │          │
│       │    ┌────┴───┐ ┌──┴──┐ ┌───┴────┐     │          │
│       │    │Engage- │ │Mana-│ │Concept │     │          │
│       │    │ment    │ │ger  │ │Extrac- │     │          │
│       │    │Decider │ │Agent│ │tor     │     │          │
│       │    └────────┘ └──┬──┘ └────────┘     │          │
│       │                  │                    │          │
│  ┌────┴──────────────────┴────────────────────┴──────┐  │
│  │           EdgeCloudServer (WebSocket)              │  │
│  └───────────────────────┬───────────────────────────┘  │
└──────────────────────────┼──────────────────────────────┘
                           │ ws://
                    ┌──────┴──────┐
                    │  Edge 节点   │
                    │ (浏览器自动化)│
                    └─────────────┘
```

### SessionOrchestrator 的职责与生命周期

`SessionOrchestrator` 是浏览会话编排的顶层控制器，负责：

1. **会话生命周期管理**：`start()` → 循环 `onNote()` → `end_session`
2. **数据流串联**：将 edge 上报的笔记内容依次经过互动决策、概念抽取、上下文构建、ManagerAgent 决策
3. **命令下发**：将 ManagerAgent 决策翻译为协议信封（Envelope），通过 `CommandSink` 下发给 edge
4. **统计维护**：维护 `SessionStats`（views、likes、collects、searches、durationMs）

生命周期：

```
start() → 加载概念池、初始化统计
  │
  ├── kick() → 下发首条 browse_next
  │
  ├── onNote(note) → 循环处理 edge 上报的笔记
  │     ├── EngagementDecider 判断 like/collect/skip
  │     ├── ConceptExtractor 抽取新概念
  │     ├── ContextBuilder 构建上下文
  │     ├── ManagerAgent 产出下一步命令
  │     └── toEnvelope() 翻译并下发
  │
  └── end_session → ManagerAgent 决定结束时下发 session.end
```

### 与其它模块的关系

| 模块 | 关系 |
|------|------|
| `risk/` | 提供 `RiskStatus`（剩余配额、viewOnly 标志），影响可用动作集合 |
| `cache/` | `ConceptPersistence` 接口可对接 PG 实现，持久化概念池 |
| `llm/` | EngagementDecider 和 ConceptExtractor 通过 `LlmClient` 调用 Qwen |
| `comm/` | 通过协议信封（`Envelope`）与 edge 通信，消息类型包括 `browse.next`、`note.open` 等 |
| `soul/` | Soul 人设配置驱动 ManagerAgent 的 prompt 和行为偏好 |

---

## 2. ManagerAgent 角色链

### 角色链设计理念

ManagerAgent 采用**多角色顺序激活**模式：根据当前页面类型动态激活不同角色，每个角色负责不同层面的评估。所有角色的评估结果汇聚为一次单一决策输出。

角色激活逻辑：
- 列表页（feed/search）：`FeedScanner` → `SessionMonitor`
- 详情页（note）：`ContentCurator` → `InteractionAppraiser` → `SessionMonitor`
- `SessionMonitor` 始终激活（最高优先级）

```typescript
// 角色激活代码（manager-agent.ts）
const activeRoles: string[] = [];
if (isFeed) activeRoles.push('FeedScanner');
if (isNote) activeRoles.push('ContentCurator', 'InteractionAppraiser');
activeRoles.push('SessionMonitor');
```

### 各角色详述

#### SessionMonitor：会话级约束

**职责**：守护会话全局约束，防止超时、超预算。

监控维度：
- 已浏览次数 `views`
- 会话时长 `durationMs`
- 剩余预算 `remainingActionsToday`（like/collect/search 各项独立计数）
- 冷启动阶段判定（`views < 5`）
- 预算紧迫告警（like ≤ 2 或 collect ≤ 1）

硬上限（来自 `soul.session_limits`）：
- `max_duration_min`：10 分钟
- `max_likes`：8 次
- `max_collects`：5 次
- `max_searches`：3 次

#### FeedScanner：列表页内容筛选策略

**激活条件**：当前页面类型为 `feed` 或 `search`

筛选策略：
- 评估可见卡片的标题、作者、点赞数、收藏数
- 优先选择与 AI/LLM/技术相关的标题
- 互动数据太差的（点赞=0 且无收藏）直接 `scroll`
- 输出动作：`open_note(index)` 或 `scroll`

#### ContentCurator：详情页质量评估

**激活条件**：当前页面类型为 `note`

评估维度：
- 内容是否有具体细节、真实案例、数据支撑
- 作者是否原创（有真实经验、非广告）
- 若质量低（空洞、标题党、广告），直接 `close_note`
- 只有质量过关才能进入 InteractionAppraiser

#### InteractionAppraiser：互动决策

**激活条件**：`ContentCurator` 通过后

决策逻辑：
- `collect`：内容值得反复查看、有实操步骤、代码/配置、架构图等可复用知识
- `like`：内容有启发但不需反复参考
- `close_note`：内容过关但对用户价值不大
- **collect 比 like 更稀有，更谨慎**

#### CommentReviewer（辅助角色）

**激活条件**：评论区已加载

作用：
- top 3 评论负面/spam → 降级评分
- 有价值补充 → 提升评分
- 无评论时不激活

### 动作集合说明

| 动作 | 含义 | 协议消息类型 | 必要参数 |
|------|------|--------------|----------|
| `browse_next` | 滑到下一条笔记 | `browse.next` | — |
| `scroll` | 当前页面滚动 | `browse.scroll` | — |
| `like` | 点赞当前笔记 | `browse.next`（附带 action=like） | — |
| `collect` | 收藏当前笔记 | `browse.next`（附带 action=collect） | — |
| `search` | 执行关键词搜索 | `search.execute` | `params.keyword` |
| `open_note` | 打开一条笔记 | `note.open` | `params.index`（0-based） |
| `close_note` | 关闭当前笔记 | `note.close` | — |
| `end_session` | 结束浏览会话 | `session.end` | — |

### 激活条件与状态转换

可用动作由 `ContextBuilder.availableActions()` 根据以下条件动态计算：

```typescript
// 基础动作（任何页面）
const actions = ['browse_next', 'scroll', 'end_session', 'search'];

// feed/search 页面额外动作
if (pageType === 'feed' || pageType === 'search') actions.push('open_note');

// note 页面额外动作
if (pageType === 'note') {
  actions.push('close_note');
  // 以下需同时满足：已登录、非 viewOnly、有笔记内容
  if (loginState !== 'logged_out' && !risk.viewOnly && hasNoteContent) {
    if (remainingActionsToday.like > 0) actions.push('like');
    if (remainingActionsToday.collect > 0) actions.push('collect');
  }
}
```

---

## 3. Soul 驱动的决策系统

### soul.yaml 结构与各配置项含义

```yaml
identity:           # 身份设定
  name: "小林"       # 角色名
  role: "AI方向研发工程师"  # 角色定位
  background: "..."  # 背景描述
  tone: "技术向、理性、偶尔幽默"  # 语气风格

interests:          # 兴趣领域
  primary: [...]    # 主要兴趣（5项，AI/LLM相关）
  secondary: [...]  # 次要兴趣（3项，泛技术）
  seed_keywords: [...] # 搜索种子词（6个）

behavior_guidelines: # 行为偏好
  style: "精准浏览、不轻易互动、收藏比点赞更稀有"
  privacy: "不盲目回关，只收藏有复用价值的硬核内容"
  collection_principle: "收藏意味着值得反复参考、可以直接落地执行"
  like_principle: "点赞代表有实际共鸣，学到了新东西或观点受启发"

session_limits:     # 会话硬上限
  max_duration_min: 10
  max_likes: 8
  max_collects: 5
  max_searches: 3
  cooldown_between_actions_sec: [3, 8]  # 动作间随机冷却区间
```

### 配置项在系统中的使用方式

| 配置项 | 使用位置 | 作用 |
|--------|----------|------|
| `identity` | ManagerAgent prompt / EngagementDecider prompt | 定义角色人设 |
| `interests` | ManagerAgent prompt / EngagementDecider prompt | 驱动内容筛选偏好 |
| `behavior_guidelines` | ManagerAgent prompt | 定义浏览风格、收藏/点赞标准 |
| `engagement_rules` | EngagementDecider prompt | like/skip/comment 倾向 |
| `session_limits` | SessionMonitor 角色 / riskStatus 计算 | 硬约束上限 |

### 如何在 ManagerAgent prompt 中体现

`buildRolePrompt()` 函数将 Soul 配置编织进系统 prompt：

1. 开头声明角色身份、语气、兴趣
2. 注入行为习惯（style / privacy / collection_principle / like_principle）
3. 角色链段落中引用 `session_limits` 作为硬约束
4. `interests` 列表嵌入作为内容筛选偏好背景

---

## 4. 数据流

### 完整的从笔记上报到命令下发的数据流

```
Edge 上报 note.content
      │
      ▼
┌─────────────────────────────────────────────┐
│ SessionOrchestrator.onNote(note)            │
│                                             │
│  1. EngagementDecider.decide(note)          │
│     → action: like | collect | skip         │
│     → reason: 简短理由                      │
│     → newConcepts?: 顺带发现的概念          │
│                                             │
│  2. ConceptExtractor.extract(note, pool)    │
│     → 仅对非 skip 的笔记执行               │
│     → 抽取 1-3 个技术概念                   │
│     → 去重后合并进 pool.candidates          │
│     → 持久化到 ConceptPersistence           │
│                                             │
│  3. 更新 sessionStats                       │
│     (views++, likes++/collects++)           │
│                                             │
│  4. ContextBuilder.build(...)               │
│     → 聚合 pageType/note/stats/riskStatus  │
│     → 计算 availableActions                 │
│                                             │
│  5. ManagerAgent.decide(context)            │
│     → LLM 推理产出 action + params + reason│
│     → 解析失败 fallback 为 browse_next     │
│                                             │
│  6. toEnvelope(command)                     │
│     → 翻译为协议信封                       │
│     → 附加 engagement action（如有）       │
│     → sink.send(envelope)                  │
└─────────────────────────────────────────────┘
      │
      ▼
Edge 接收协议命令并执行
```

### EngagementDecider 流程

```
输入: NoteForDecision { title, summary, likeCount, collectCount }
  │
  ▼
构造 prompt（含 Soul identity + interests + engagement_rules）
  │
  ▼
LLM.complete(prompt)
  │
  ▼
parseDecision(raw) → JSON 解析（容忍围栏/多余文字）
  │
  ├── 成功 → { action, reason, newConcepts? }
  └── 失败 → { action: 'skip', reason: 'unparsable_output' }
```

设计要点：
- 解析失败或模型出错时保守 skip，**绝不误点赞**
- 模型输出严格为 JSON 格式，允许前后有多余文字

### ConceptExtractor 流程

```
输入: { title, summary } + 当前 ConceptPool
  │
  ▼
构造 prompt（"提取1-3个值得深入了解的技术概念"）
  │
  ▼
LLM.complete(prompt)
  │
  ▼
parseConcepts(raw) → JSON 数组解析
  │
  ▼
mergeConcepts(concepts, pool, sourceTitle)
  ├── 过滤：已在 pool.known 或 pool.candidates 中的
  ├── 过滤：空串、超长串（>30字符）
  ├── 上限：最多 3 个概念
  └── 新概念追加到 pool.candidates，记录 source
```

### ContextBuilder 上下文聚合

`ContextBuilder.build()` 将分散信息聚合为统一的 `ManagerContext`：

```typescript
interface ManagerContext {
  currentPage: { type: PageType };          // 当前页面类型
  pageAttributes: PageAttributes;           // 可见卡片/当前笔记/关键词/评论
  sessionStats: SessionStats;               // 会话统计
  riskStatus: RiskStatus;                   // 风控状态
  loginState: LoginState;                   // 登录状态
  availableActions: ManagerActionName[];     // 动态计算的可用动作
}
```

### ManagerAgent 决策

ManagerAgent 通过 LLM 推理输出 JSON 决策：

```typescript
// 输入：system prompt（角色链 + soul配置） + user message（context JSON）
// 输出格式：
{ "action": "browse_next", "params": {}, "reason": "[角色名] 简短原因" }
```

解析容错机制（`parseManagerDecision`）：
1. 提取首个 `{` 到最后 `}` 之间的 JSON
2. 校验 `action` 是否在 `availableActions` 中
3. 校验参数完整性（`search` 需要 `keyword`，`open_note` 需要 `index`）
4. 任何校验失败 → `fallbackDecision()`（`browse_next`）

### 协议翻译（toEnvelope）

| ManagerAgent action | 协议消息类型 | payload |
|---------------------|-------------|---------|
| `browse_next` | `browse.next` | `{ reason }` |
| `scroll` | `browse.scroll` | `{ reason }` |
| `open_note` | `note.open` | `{ noteId?, index?, reason }` |
| `close_note` | `note.close` | `{ reason }` |
| `like` / `collect` | `browse.next` | `{ reason }` + 附加 `action` 字段 |
| `search` | `search.execute` | `{ keyword, source: 'manager', maxResults }` |
| `end_session` | `session.end` | `{ reason, stats }` |

---

## 5. 风控集成

### RiskStatus 约束机制

SessionOrchestrator 内部维护一个轻量级 `riskStatus()` 方法，基于 soul 配置的会话上限计算剩余配额：

```typescript
private riskStatus(): RiskStatus {
  return {
    status: 'normal',
    quotaLevel: 'normal',
    remainingActionsToday: {
      view: MAX_SAFE_INTEGER,
      like: max(0, maxLikes - stats.likes),
      collect: max(0, maxCollects - stats.collects),
      search: max(0, maxSearches - stats.searches),
      follow: MAX_SAFE_INTEGER,
    },
    viewOnly: false,
  };
}
```

### remainingActionsToday 如何影响可用动作

`ContextBuilder.availableActions()` 中：
- `like` 仅在 `remainingActionsToday.like > 0` 时加入可用动作
- `collect` 仅在 `remainingActionsToday.collect > 0` 时加入可用动作
- 当配额耗尽时，对应动作从可选列表中移除，ManagerAgent **无法选择**该动作

### 冷启动阶段约束（views < 5 禁止互动）

在 `buildRolePrompt` 中：

```typescript
const coldStartNote = ctx.sessionStats.views < 5
  ? '【冷启动阶段（views<5）】：禁止互动（like/collect），只浏览。'
  : '';
```

这是一条**软约束**（通过 prompt 告知 LLM），配合 ContextBuilder 中的动作过滤形成双重保障。

### 预算紧迫时的策略

当 `like ≤ 2` 或 `collect ≤ 1` 时，prompt 中注入：

```
【预算紧迫】：互动额度不足，建议只浏览或结束会话。
```

引导 ManagerAgent 减少互动、偏向 `browse_next` 或 `end_session`。

### 全局风控层（RiskController）

除会话内编排器自有的配额管理外，系统还有独立的 `RiskController`：

- 基于**滑动窗口计数器**（分钟/小时/天三级窗口）
- 状态机：`normal → warned → restricted → frozen`
- 点赞率约束：`like/view ≤ 35%`（当日浏览量 ≥ 10 时生效）
- 信号驱动状态迁移（`light` / `quota_exceeded` / `confirmed` / `fatal` / `recovered`）

---

## 6. 关键约束与设计决策

### 硬约束列表

| 约束 | 来源 | 机制 |
|------|------|------|
| 会话最长 10 分钟 | `session_limits.max_duration_min` | SessionMonitor prompt |
| 单次会话最多 8 赞 | `session_limits.max_likes` | 动作过滤 + prompt |
| 单次会话最多 5 藏 | `session_limits.max_collects` | 动作过滤 + prompt |
| 单次会话最多 3 搜 | `session_limits.max_searches` | 动作过滤 + prompt |
| 冷启动前 5 条仅浏览 | `views < 5` → prompt 禁止 | prompt 软约束 |
| 配额耗尽不可选 | `remainingActions ≤ 0` | 动作列表过滤（硬） |
| viewOnly 时禁互动 | `risk.viewOnly === true` | 动作列表过滤（硬） |
| 未登录时禁互动 | `loginState === 'logged_out'` | 动作列表过滤（硬） |

### 设计取舍说明

1. **角色链 in prompt vs 多次调用**  
   选择将所有角色内联到一次 prompt 中，而非多次 LLM 调用。牺牲角色间独立推理，换取延迟和成本的大幅降低（单次 qwen-turbo 调用 ≤ 3s）。

2. **fallback 为 browse_next**  
   任何 LLM 超时/解析失败时，默认执行 `browse_next`。这是最安全的动作（只浏览、不互动、不结束会话）。

3. **互动由 EngagementDecider + ManagerAgent 双层判断**  
   EngagementDecider 先做笔记级互动决策（like/collect/skip），ManagerAgent 再做会话级下一步规划。两者结果合并到最终信封。

4. **概念抽取仅对非 skip 笔记执行**  
   被 skip 的低质内容不浪费 LLM tokens 抽概念。

5. **编排器不直接依赖网络**  
   命令通过注入的 `CommandSink` 接口下发，概念持久化通过 `ConceptPersistence` 接口注入，使得 `onNote()` 可完全单测。

6. **RiskStatus 在编排层内部计算（非从 RiskController 实时查询）**  
   当前实现中 SessionOrchestrator 基于 session_limits 自行计算剩余配额，避免依赖外部状态查询的延迟。全局 RiskController 作为独立层存在，用于跨会话的长期风控。

---

## 7. 配置与扩展

### 如何调整行为参数

| 参数 | 文件 | 修改效果 |
|------|------|----------|
| 会话上限 | `src/soul/soul.yaml` → `session_limits` | 调整浏览时长、互动次数上限 |
| 兴趣偏好 | `src/soul/soul.yaml` → `interests` | 影响内容筛选方向 |
| 互动标准 | `src/soul/soul.yaml` → `behavior_guidelines` | 改变点赞/收藏的严格程度 |
| 冷启动阈值 | `src/orchestrator/manager-agent.ts` → `views < 5` | 调整冷启动结束条件 |
| 预算告警阈值 | `src/orchestrator/manager-agent.ts` → `like ≤ 2 \|\| collect ≤ 1` | 调整预算告警触发点 |
| LLM 超时 | `ManagerAgentOptions.timeoutMs`（默认 3000ms） | 调整 LLM 调用超时 |
| 概念长度上限 | `concept-extractor.ts` → `MAX_CONCEPT_LEN`（30） | 过滤过长的概念字符串 |

### 如何添加新角色

1. 在 `buildRolePrompt()` 中定义新角色段落（参考 `FeedScanner`、`ContentCurator` 的格式）
2. 在 `activeRoles` 数组中根据激活条件加入新角色名
3. 角色段落应明确说明：触发条件、评估维度、可输出的动作

### 如何添加新动作

1. 在 `ManagerActionName` 联合类型中添加新动作名
2. 在 `ContextBuilder.availableActions()` 中定义激活条件
3. 在 `SessionOrchestrator.toEnvelope()` 的 switch 中添加协议翻译
4. 在 `comm/protocol.ts` 中定义对应的 `MessageType` 和 `Payload` 接口
5. 在 `buildRolePrompt()` 的输出格式说明中注明必要参数
