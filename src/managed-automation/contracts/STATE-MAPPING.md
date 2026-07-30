# 旧 delegated-task 模型 → 托管自动化运行时契约：状态映射与 supersession map

- Change：`add-managed-automation-runtime`（期1-1 契约冻结交付物之一）
- 旧模型出处：`src/kernel/delegated-task-types.ts`（11 态 + Attempt/Verification）、`src/delegated-task/types.ts`（状态机 TRANSITIONS）
- 新模型出处：本目录 `src/managed-automation/contracts/`（design.md 为权威）
- 口径：本文档只声明**映射关系**，不是迁移脚本；delta 未落地前旧模型仍是既有委托任务行为的权威（design §24 时机口径）。

## 1. 旧 11 态 → TaskRun 正交模型逐态映射

新模型三字段正交（`task-run.ts`）：`status`（在跑吗）+ `waitReason`（在等什么）+ `terminalOutcome`（怎么结束的）。旧模型把三个维度压进一个互斥枚举，多个旧态在新模型中**不再是 TaskRun 状态**，而是上移到 Task/提案/编译层——这正是拆分的目的。

| # | 旧 `DelegatedTaskStatus` | 新模型对应 | 说明 |
| --- | --- | --- | --- |
| 1 | `draft` | **无 TaskRun 对应** → 提案/授权层：`CreateTaskProposal`（Agent 提案，未授权） | 新模型 TaskRun 只在 API 授权（TaskActivated）后创建；「草稿」不是运行状态（design §3） |
| 2 | `awaiting_confirmation` | **无 TaskRun 对应** → API 授权流程中（提案已提交、`TaskRevision(cause='create')` 未落） | 确认是 API 的授权动作；若确认卡语义迁到运行后审批，则对应 `status='waiting' + waitReason='waiting_for_approval'` |
| 3 | `queued` | `status='queued'` | 语义一致：已授权、已建 run、未开始 |
| 4 | `planning` | **无 TaskRun 状态对应** → Plan Compiler 阶段（计划准入，design §4.5/§9） | 编译发生在 TaskRun 创建路径上；编译失败 → 不建 run 或 `status='terminal' + terminalOutcome='failed' + reasonCode='contract_invalid'` |
| 5 | `waiting_approval` | `status='waiting' + waitReason='waiting_for_approval'` | 审批未到期按 `missPolicy` 判 skip/cancel；C9 裁决：窗口过期只撤当次执行授权，不终结人审 |
| 6 | `executing` | `status='running'` | 语义一致 |
| 7 | `partially_completed` | `status='terminal' + terminalOutcome='partially_succeeded'` | 实际完成量入 `progress.confirmedCount`（如 10+13，不得报 30，design §16） |
| 8 | `completed` | `status='terminal' + terminalOutcome='succeeded'` | 语义一致 |
| 9 | `deferred` | `status='waiting' + waitReason ∈ {waiting_for_account, waiting_for_edge, waiting_until}` | 旧「让开/延期」拆开成因；窗口耗尽 → `terminal + skipped + reasonCode='window_missed'`。旧模型「等待」与「因等待而放弃」混在 deferred/failed 里，新模型强制分离 |
| 10 | `cancelled` | 过渡态 `status='cancel_requested'` → 终态 `status='terminal' + terminalOutcome='cancelled'` | 取消是前向语义（design §12）：已派发 Attempt 独立归并，不覆盖平台结果 |
| 11 | `failed` | `status='terminal' + terminalOutcome='failed'`；平台结果未知的旧 `failed`+`submittedUnknown` 标志 → `terminalOutcome='submitted_unknown'` | 旧 `DelegatedTerminalOutcome.submittedUnknown: boolean` 是补丁字段；新模型把「未知」升为一级终态，禁止折叠成成败 |

旧状态机附注（`src/delegated-task/types.ts`）：
- `TERMINAL_STATUSES` → `status='terminal'` 判定（单字段判终态，不再枚举集合成员）；
- `TRANSITIONS` 转移表 → 期1-2+ 的状态机实现承接；契约层只冻结不变式（`waitReason ⇔ waiting`、`terminalOutcome ⇔ terminal`）；
- `honestTerminalStatus()`（把「有成功计数的失败」修正为 partially_completed）→ 类型直接表达：`terminalOutcome='partially_succeeded'` + `progress`，不再需要修正函数。

## 2. Supersession map：旧概念/接口 → 新模型对应物

### 2.1 `src/kernel/delegated-task-types.ts`

| 旧概念 | 新模型对应 | 备注 |
| --- | --- | --- |
| `DelegatedTaskStatus`（11 态） | `RunStatus` + `WaitReason` + `RunTerminalOutcome`（task-run.ts / reason-codes.ts） | 见 §1 逐态表 |
| `DELEGATED_TASK_STATUSES` | `RUN_STATUSES` / `WAIT_REASONS` / `RUN_TERMINAL_OUTCOMES` | 同一 `as const satisfies` 模式 |
| `DelegatedTask` | **拆分**为 `Task`（授权副本，task.ts）+ `TaskRun`（一次运行，task-run.ts） | 旧模型把「工作目标」和「这次运行」合在一行；新模型 Task 可多次派生 run |
| `DelegatedTaskIntent` | `CreateTaskProposal`（agent-intents.ts） | 提案仅为建议，由 API 授权（design §3） |
| `DelegatedTaskAttempt` | `ExecutionAttempt` + 分离出的不可变 `ExecutionIntent`（execution-attempt.ts） | 旧 Attempt 把意图字段和结果字段混存；新模型意图先行且不可变 |
| `DelegatedAttemptStatus.prepared/dispatched` | `ExecutionAttemptStatus.prepared/dispatched` | 同名同义 |
| `DelegatedAttemptStatus.succeeded` | `platform_confirmed` | 更名以钉死证据口径：Edge ack 不是平台成功 |
| `DelegatedAttemptStatus.failed` | `confirmed_not_applied`（+ `confirmedNotAppliedKind` 区分 never_applied / platform_refused）或派发前 `blocked` | 旧模型不区分「没写上」和「平台拒绝」 |
| `DelegatedAttemptStatus.skipped` | 派发前 `blocked`/`cancelled` + `reasonCode` | 「跳过」归因到具体拒绝/取消原因 |
| `DelegatedAttemptStatus.submitted_unknown` | `submitted_unknown` | 同义保留；新增红线：禁止重派、只交 Reconciler |
| `DelegatedVerificationKind.platform_*_confirmed` | `platform_confirmed` + `evidenceRef`（证据合同按 capability 声明） | 平台/动作细分转移到 CapabilityDefinition.requiredEvidenceRef |
| `DelegatedVerificationKind.candidate_persisted / candidate_version_updated` | **无直接对应** | 属 Content 域结果；新模型经 `StepRun.resultRef` 与 `CreationCompleted` 事件引用，不再算 Attempt 验证类别 |
| `DelegatedVerificationKind.not_dispatched / not_started` | `AttemptNonStartReason` 四分类（reason-codes.ts）+ 派发前状态 | 旧二分（跑没跑）细化为四因；「有没有碰过平台」语义由 `ATTEMPT_PRE_DISPATCH_STATUSES` 承接 |
| `DelegatedTerminalOutcome`（code/message/submittedUnknown/remainingCount） | `terminalOutcome` + `reasonCode` + `RunProgress` | 未知升一级终态；剩余量 = `targetCount - confirmedCount` |
| `DelegatedTaskProgress` | `RunProgress`（task-run.ts） | 增加 `confirmedCount/targetCount` 唯一确认口径 |
| `executionWindow` + `DelegatedScheduleMode`（immediate/at_time/next_safe_slot） | `ScheduleWindow`（scheduledAt/latestStartAt/**missPolicy**，common.ts） | 旧模型无「错过怎么办」；missPolicy 是新增必填语义 |
| `DelegatedApprovalMode`（review/auto_approve/draft_only） | `AuthorizationLevel`（require_approval/standing_authorized/disabled）+ 动作域拆分 | 适配器映射：review→require_approval，auto_approve→standing_authorized；draft_only→创作域放行 + 提交域 disabled（design §9：不改变用户可见配置） |
| `clampClientApprovalMode()` | **无对应（有意）** | 授权归一属 API 侧适配器职责，cutover 时另建；契约层不带旧模式归一逻辑 |
| `DelegatedTaskPriority`（normal/high） | **无对应（本期）** | 优先级改由 Account Work Arbiter 的 priority class 承接（design §7，期3）；不是 Task 属性 |
| `DelegatedTaskSource` / `sourceRef` | `TriggerType`（plan.ts）+ `AgentIntentProvenance`（agent-intents.ts） | 来源拆成「触发类型」与「对话溯源」两个正交面 |
| `originChatId` | **无对应（本期）** | 通知路由（飞书卡片投递）属通知域，期5/6 结果通知承接；契约层不含投递目标 |
| `actionFamily` / `DelegatedAction` | `ActionDomain` + `CapabilityId`（action-classification.ts / capability.ts） | 三分类扩展为七动作域 + 能力 ID；另增 read_only/platform_write 执行分类（期1 准入闸） |
| `pauseRequested` | **无对应（有意）** | TaskRun 无暂停：等待（waiting）、取消（前向）、supersede（新 revision）三者覆盖；Plan 层有 `paused`（ManagedPlanPaused） |
| `cancelRequested: boolean` | `status='cancel_requested'`（一级状态） | 从布尔补丁升为正交状态机成员 |
| `claimToken` / `claimExpiresAt` | **无对应（本期）** | 认领/租约属仲裁与 typed store 实现（期1-2 单写者、期3 Arbiter lane），不属对象契约 |
| `dedupeKey` | `TriggerBinding.idempotencyKeyRule` + `TaskRun.idempotencyKey` + `ExecutionIntent.idempotencyKey` | 幂等分层：触发去重 / 运行幂等 / 平台动作幂等 |
| `version` | `aggregateVersion` | 同义更名（对齐信封 aggregateVersion） |
| `executionTarget` | `executionTarget`（所有持久化契约必带，common.ts） | 语义不变；服务端注入纪律照旧 |
| `DelegatedTaskConfirmationSummary` | **无对应（本期）** | 审批卡投影属 API 侧客户投影（design §20），期5/6 承接 |
| `DelegatedTaskServiceError` | **无对应（本期）** | 契约层零运行时；入口操作的 typed error 由期1-4 定义 |
| `DelegatedTaskServicePort` | `AgentAutomationIntent` 四入口 + `QueryTaskProjection`（agent-intents.ts） | createDraft/confirm→CreateTaskProposal+API 授权；cancel→CancelTaskProposal；get/list→QueryTaskRequest；**pause/resume 无对应**（见 pauseRequested 行） |
| `TriggeredPublishRefsReader` | **无对应（本期）** | 发布引用集属 platform_write 纵切（期5）；期1 执行层拒绝 platform_write |
| `DelegatedPlatformId`（排除 wechat_channels） | `PlatformId`（kernel 原样引用） | 新契约不预排除平台；平台可用性走 Capability/平台合同判定 |

### 2.2 `src/delegated-task/types.ts`

| 旧概念 | 新模型对应 | 备注 |
| --- | --- | --- |
| `TERMINAL_STATUSES`（Set） | `status='terminal'` 单字段判定 | 不再需要终态集合 |
| `TRANSITIONS`（Set 转移表） | 期1-2+ 状态机实现承接；契约只冻结正交不变式 | 契约层不持模块级 Set（零运行时纪律） |
| `isTerminalTaskStatus` / `canTransitionTask` | 期1-2+ 实现层函数 | 同上 |
| `validateDelegatedTaskIntent` | API 侧提案校验（`invalid_task_proposal` 原因码已冻结） | Agent 输出必须过 schema/allowlist/版本/授权校验（design §22） |
| `honestTerminalStatus` | `terminalOutcome='partially_succeeded'` + `RunProgress` | 诚实终态由类型结构直接表达，见 §1 附注 |

## 3. 有意不建立对应物的汇总（快查）

| 旧概念 | 原因 |
| --- | --- |
| `draft` / `awaiting_confirmation` 两个运行状态 | 授权动作上移 API；TaskRun 只存在于授权之后 |
| `pauseRequested`、`ServicePort.pause/resume` | 新模型无 TaskRun 暂停；waiting/cancel/supersede 三语义覆盖，Plan 层另有 paused |
| `DelegatedTaskPriority` | 优先级属 Arbiter priority class（期3），不是任务属性 |
| `originChatId`、`DelegatedTaskConfirmationSummary` | 通知/卡片投影属 API 与通知域（期5/6） |
| `claimToken/claimExpiresAt` | 认领属 store/lane 实现，不属领域对象契约 |
| `clampClientApprovalMode` | 旧授权模式归一属 cutover 适配器，不进新领域语言 |
| `TriggeredPublishRefsReader` | platform_write 纵切（期5）承接；期1 准入即拒 platform_write |
| `candidate_persisted/candidate_version_updated` 验证类别 | Content 域结果经引用回流，不是平台动作验证 |
