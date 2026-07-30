/**
 * 契约层：原因码（reason_code）全集，按「拒绝 / 等待 / 终态 / Attempt 未开始」四类冻结。
 *
 * design §19 要求每条 Decision Trace 携带 reasonCode；§23 失败语义矩阵与五份能力 spec
 * 给出具名原因（duplicate_trigger、unsupported、contract_invalid、invalid_task_proposal、
 * no_qualified_target 等）。本文件把它们收敛为可判别联合 + 冻结字面数组，供
 * decision-trace / task-run / execution-attempt 契约共用。
 *
 * 扩展纪律：原因码只增不改语义；新增必须落在正确类别，禁止把「拒绝」伪装成「等待」。
 */

/**
 * 拒绝类原因码：准入（计划准入 / 提交准入，design §9）或提案校验被明确拒绝。
 * 对应 DecisionTrace outcome = 'denied'。
 *
 * - `capability_not_available`：所需 Capability 在当前运行时/平台/Edge 不可用。
 *   **期1 执行层只放行 read_only 动作，platform_write 在准入时即以本码拒绝**
 *   （见 action-classification.ts）；
 * - `action_domain_disabled`：动作域授权为 disabled（design §9）；
 * - `approval_missing` / `approval_rejected`：需要审批但缺失 / 被拒（§23：不得自动放行）；
 * - `capability_scope_denied`：越出 Task CapabilityScope（design §4.3）；
 * - `risk_denied` / `quota_exhausted` / `cooldown_active`：RiskController、配额、冷却硬闸
 *   （§24.4 D2：无 override 档位，任何入口一致）；
 * - `budget_exhausted`：三类预算任一耗尽（design §10，预算不能互相替代）；
 * - `emergency_stop` / `account_suspended`：紧急停止、账号暂停（实时安全项）；
 * - `account_identity_mismatch` / `page_identity_mismatch`：账号/页面真实身份不符，fail-closed（§23）；
 * - `protocol_version_mismatch`：能力/命令版本锁步不满足（§24.2 C7）；
 * - `execution_target_mismatch`：跨 target 回执/身份一律拒收（ledger spec）；
 * - `contract_invalid`：TaskDefinition/能力合同校验失败（§23：failed(contract_invalid)）；
 * - `invalid_task_proposal`：Agent 输出非法（§23：不得把自然语言当命令继续执行）；
 * - `duplicate_trigger`：触发去重命中（§23：不创建重复 Task/TaskRun）；
 * - `duplicate_intent`：业务幂等键命中既有 intent/Attempt（ledger spec）；
 * - `unsupported`：未知能力/未知命令版本，显式声明不支持（§24.2 C6 拒的一侧）；
 * - `stale_target`：commit 阶段目标复核失败（arbitration spec：honest stale/target-changed）。
 */
export type RejectionReasonCode =
  | 'capability_not_available'
  | 'action_domain_disabled'
  | 'approval_missing'
  | 'approval_rejected'
  | 'capability_scope_denied'
  | 'risk_denied'
  | 'quota_exhausted'
  | 'cooldown_active'
  | 'budget_exhausted'
  | 'emergency_stop'
  | 'account_suspended'
  | 'account_identity_mismatch'
  | 'page_identity_mismatch'
  | 'protocol_version_mismatch'
  | 'execution_target_mismatch'
  | 'contract_invalid'
  | 'invalid_task_proposal'
  | 'duplicate_trigger'
  | 'duplicate_intent'
  | 'unsupported'
  | 'stale_target';

export const REJECTION_REASON_CODES = [
  'capability_not_available',
  'action_domain_disabled',
  'approval_missing',
  'approval_rejected',
  'capability_scope_denied',
  'risk_denied',
  'quota_exhausted',
  'cooldown_active',
  'budget_exhausted',
  'emergency_stop',
  'account_suspended',
  'account_identity_mismatch',
  'page_identity_mismatch',
  'protocol_version_mismatch',
  'execution_target_mismatch',
  'contract_invalid',
  'invalid_task_proposal',
  'duplicate_trigger',
  'duplicate_intent',
  'unsupported',
  'stale_target',
] as const satisfies readonly RejectionReasonCode[];

/**
 * 等待原因（TaskRun/StepRun 正交状态第二字段，design §2）。
 * 仅在 status = 'waiting' 时非空；同时充当 DecisionTrace outcome = 'delayed' 的原因码。
 * null 语义由字段侧表达（`waitReason: WaitReason | null`），联合本身不含 null。
 */
export type WaitReason =
  | 'waiting_for_account'
  | 'waiting_for_edge'
  | 'waiting_for_content'
  | 'waiting_for_approval'
  | 'waiting_until'
  | 'waiting_for_reconciliation';

export const WAIT_REASONS = [
  'waiting_for_account',
  'waiting_for_edge',
  'waiting_for_content',
  'waiting_for_approval',
  'waiting_until',
  'waiting_for_reconciliation',
] as const satisfies readonly WaitReason[];

/**
 * 终态类原因码：解释 terminalOutcome 为何落到 skipped / failed / partially_succeeded 等。
 * 对应 DecisionTrace outcome = 'skipped' / 'superseded' 等。
 *
 * - `no_qualified_target`：无强相关目标，0 条也是诚实结果（design §14）；
 * - `content_exhausted`：内容供给耗尽仍不足目标数（design §16 场景：10+13 ≠ 30）；
 * - `deadline_exceeded` / `window_missed`：超时 / 超过 latestStartAt（missPolicy 判定）；
 * - `edge_unavailable` / `content_unavailable`：有界等待到期后诚实跳过（§23）；
 * - `superseded`：新 TaskRevision/ExecutionPlan 取代未派发工作（§23 最后一行）；
 * - `cancelled_by_user` / `cancelled_by_system`：取消来源区分（前向语义，design §12）；
 * - `reconciliation_inconclusive`：有界对账无结论，保持 unknown + 人工关注（design §12）。
 */
export type TerminalReasonCode =
  | 'no_qualified_target'
  | 'content_exhausted'
  | 'deadline_exceeded'
  | 'window_missed'
  | 'edge_unavailable'
  | 'content_unavailable'
  | 'budget_exhausted'
  | 'superseded'
  | 'cancelled_by_user'
  | 'cancelled_by_system'
  | 'reconciliation_inconclusive';

export const TERMINAL_REASON_CODES = [
  'no_qualified_target',
  'content_exhausted',
  'deadline_exceeded',
  'window_missed',
  'edge_unavailable',
  'content_unavailable',
  'budget_exhausted',
  'superseded',
  'cancelled_by_user',
  'cancelled_by_system',
  'reconciliation_inconclusive',
] as const satisfies readonly TerminalReasonCode[];

/**
 * Attempt 派发前未开始的类型化原因（ledger spec「Attempt outcomes MUST preserve
 * distinctions that determine recovery」）：四类**不得合并或改名**，
 * 因为只有显式的 `resource_slot_wait` 可保留自动重试授权。
 * 未识别的派发前失败缺省归入 not-dispatched 分类（由实现层裁定，不在此新增杂项码）。
 */
export type AttemptNonStartReason =
  | 'executor_unavailable'
  | 'browser_control_degraded'
  | 'acquisition_timeout'
  | 'resource_slot_wait';

export const ATTEMPT_NON_START_REASONS = [
  'executor_unavailable',
  'browser_control_degraded',
  'acquisition_timeout',
  'resource_slot_wait',
] as const satisfies readonly AttemptNonStartReason[];

/** decision-trace 可携带的原因码全集（四类并集）。 */
export type ReasonCode = RejectionReasonCode | WaitReason | TerminalReasonCode | AttemptNonStartReason;
