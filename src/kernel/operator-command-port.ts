/**
 * 四条**运营指令**的跨属主窄口（kernel · 只定义契约，本轮不接线）。
 *
 * 这四条的共同形状是「入站在 api、处理器在 automation」：
 *   ① 自由文本委托 —— 飞书自然语言 / 旧写命令；
 *   ② 发布 / 评论指令 —— 手动 `/publish`、`/comment`；
 *   ③ 委托任务卡片动作 —— 确认 / 暂停 / 恢复 / 取消 / 刷新；
 *   ④ 调度启停 —— 面板启停按钮 + dashboard 状态灯。
 *
 * **形状照抄 4a 已建立的 paired command**（{@link file://./api-direct-port.js} 的
 * `EdgeResumeCommandPort` / `FacebookScopeCommandPort` / `PublishUiUpdateCommandPort`，
 * 传输三件套见 `src/transport/paired-command-http.ts`）：kernel 窄口 + 信封 + 幂等键 +
 * `applied | duplicate | collision` 回执。**MUST NOT 另造第二套机制。**
 *
 * ── 四条必须守住的语义（本文件用类型 + 注释把它们钉死）────────────────────────────
 *
 * **(A) 版本与部署 target 随每条请求走，且 target 由服务端注入。**
 * 复用 {@link OperatorCommandEnvelope}（即 4a 的 `ApiDirectEnvelope`）：`version` + `executionTarget`
 * + `input` 三段。`executionTarget` 由**客户端构造时**从本进程部署事实注入、接收方逐字比对后才处理，
 * 调用方（飞书 handler / 面板路由 / 卡片回调）**没有任何入口能选它**。这不是风格问题：DEV/OL 长期共库，
 * 让调用方挑 target 等于把「在哪台机器上真跑」交给一个 HTTP body 字段。
 *
 * **(B) 指令不可达 ≠ 已受理。**
 * 处理器没接线时，接收方回 `outcome:'not_delivered'` + 具名 {@link OperatorCommandUndeliveredReason}。
 * api 侧 MUST 原样表述成「指令未送达」，**MUST NOT** 说成已受理 / 已排队 / 已执行。
 * 今天单体里这条是靠 `automation_operator_command_unavailable:<x>` 这类字符串表达的，拆进程后它
 * MUST 变成一个**结构化回执**，否则会与下面 (C) 的「结果未知」混成同一坨字符串。
 *
 * **(C) 传输失败 / 超时 = 结果未知，不是失败。**
 * 这类失败 MUST 由客户端**抛出**（见「失败回报约定」一节），且抛出物的原因码 MUST 明说「未知」。
 * **MUST NOT** 推断成成功，也 **MUST NOT** 推断成失败——发布 / 评论 / 启停都有真实副作用，
 * 「超时了就当没发生」正是本仓红线点名的静默假成功的镜像形态。
 *
 * **(D) 重试靠幂等键，不靠「再发一次总没错」。**
 * 每条写指令携带 {@link OperatorCommandIdParts} 生成的 `commandId`；接收方 MUST 以**持久台账**
 * 按 `commandId` 判重（跨进程重启仍成立），重放回 `outcome:'duplicate'` 并**原样回放首次的结果**。
 * 两条纪律：
 *   - `commandId` MUST 由**运营侧那一次意图**决定（飞书 messageId / 面板请求 id），
 *     **MUST NOT** 每次重试新随机一个——那样幂等键形同虚设；
 *   - `duplicate` 的回执 MUST 是台账里存的首次结果，**MUST NOT** 现算一个
 *     （典型错法：启停重放时补一个 `changed:false` —— 那是编出来的事实，不是记录下来的）。
 *   同一把键空间由 {@link OPERATOR_COMMAND_KINDS} 的 kind 前缀保证：面板与飞书若都能触发同一条
 *   启停，二者落在同一空间、互相判得出重复。
 *
 * ── 失败回报约定（用户 2026-07-29 裁定）─────────────────────────────────────────
 * 统一到本仓既有范式：**客户端 implements 同一个 kernel 接口、返回裸值、失败靠抛**，
 * 抛出物结构化可识别（按具名字段判，**不用 `instanceof`**——§8.5：跨进程后错误是 JSON 反序列化出来的
 * 裸对象，原型链上什么都没有）。
 *
 * 本文件**不新造错误类**：
 *   - 传输层失败（不可达 / 超时 / 形状不符 / 鉴权）已有 `ApiDirectHttpError`（`src/transport/
 *     api-direct-http-common.ts`，带具名 `code`，且 `src/server.ts` 的 edge-resume 调用点已经在按
 *     `code` 字段做结构化识别）。四条指令逐字复用它。
 *   - 处理器的**业务拒绝**已有 {@link DelegatedTaskServiceError}（本仓 kernel 既有类，带具名 `code`）。
 *     本文件只补一个它缺的东西：结构化守卫 {@link isDelegatedTaskServiceError}——因为今天两处消费方
 *     （`src/feishu/delegated-task-card.ts` 判 `version_conflict`、`src/client-auth/client-auth-server.ts`
 *     映射 HTTP 状态）都用 `instanceof` 认它，跨进程后**恒 false**，`version_conflict` 会静默退化成
 *     一条普通错误 toast、刷新卡也不再回。
 *   - `ContentPortError`（`content-port-error.ts`）是 automation→content 方向的 name，**借用等于说谎**，
 *     本文件不碰它。
 *
 * 业务拒绝为什么走**带内回执**而不是让处理器的异常裸奔过线：内部 HTTP 的线格式只保 `code` + `message`
 * （`InternalHttpError` 另保 `details`），`status` 这类字段跨那一跳会丢；而丢了 `status` 再在客户端侧
 * 补一个默认 400，就是「缺席压成默认值」。故拒绝以 {@link OperatorCommandRejection} 带内回传（三字段齐全）。
 * 它**不是**第二套失败约定：`rejected` 与 4a 的 `collision` 同类——是**契约本身**的一个取值，
 * 本地实现与 HTTP 客户端**两侧回同一个形状**（本地实现 catch 住服务类抛的错、转成同一个 `rejected`）。
 * 需要恢复「失败靠抛」的调用点（今天飞书 delegate handler 就是靠抛）用 {@link delegatedTaskRejectionToError}
 * 在自己那一侧重建同一个 `DelegatedTaskServiceError` 抛出，行为逐位不变。
 *
 * kernel 准入：零 SQL、零 HTTP、零 LLM、零模块级活状态（无 `let` / `var` / `new Map` / `new Set` /
 * 定时器 / 连接池），只 import 同层 kernel 契约与部署 target 类型。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type ApiDirectEnvelope,
} from './api-direct-port.js';
import {
  DelegatedTaskServiceError,
  type DelegatedTask,
  type DelegatedTaskConfirmationSummary,
  type DelegatedTaskServicePort,
} from './delegated-task-types.js';
import type { CommentCommandReceipt } from './feishu-card-contract.js';
import type { TriggerOutcome } from './publish-generation-types.js';

/* ─────────────────────────────────────────────────── 信封 / 版本（语义 A） */

/**
 * 运营指令契约版本。**逐字复用 4a 的版本号**：这四条与 4a 的 paired command 走同一条内部 HTTP
 * 传输、同一个信封解析器，分开编号只会让两份版本各自漂移而没有任何一方能发现。
 */
export const OPERATOR_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

/**
 * 运营指令请求信封。`executionTarget` **由服务端（客户端实例构造时）注入**，
 * 接收方逐字比对本机 target，不符即拒——调用方无从选择。
 */
export type OperatorCommandEnvelope<T> = ApiDirectEnvelope<T>;

/** 信封里的部署 target 取值域，与本仓其余处一致。 */
export type OperatorCommandExecutionTarget = DeploymentTarget;

/* ───────────────────────────────────────────────── 幂等键（语义 D） */

/**
 * 四条运营指令的 kind 前缀。**同一把键空间**：不同入口（飞书 / 面板 / 卡片回调）触发同一条指令时，
 * 只要 kind + scope + requestKey 相同就是同一次意图，接收方据此判重。
 */
export const OPERATOR_COMMAND_KINDS = [
  'delegated_task_text',
  'manual_publish',
  'manual_comment',
  'automation_dispatch',
] as const;

export type OperatorCommandKind = (typeof OPERATOR_COMMAND_KINDS)[number];

export function isOperatorCommandKind(value: unknown): value is OperatorCommandKind {
  return typeof value === 'string' && (OPERATOR_COMMAND_KINDS as readonly string[]).includes(value);
}

/** `commandId` 的分隔符。三段都不得含它（否则解析会串段）。 */
export const OPERATOR_COMMAND_ID_SEPARATOR = ':';

export interface OperatorCommandIdParts {
  kind: OperatorCommandKind;
  /**
   * 作用域。四条都取 `accountId`（调度启停现役是单全局引擎、accountId 为信息性，但它仍是运营侧
   * 那一次点击所指的账号，作为 scope 稳定且可读）。
   */
  scope: string;
  /**
   * 运营侧那一次意图的稳定标识：飞书 `messageId`、面板请求 id、卡片回调 id 之类。
   *
   * **MUST 跨重试保持不变**。这是整条幂等语义的支点：每次重试新随机一个，等于宣布这套键不存在。
   * 拿不到稳定来源标识时，调用方 MUST 显式构造一个由**指令内容**决定的确定性串（如
   * `<accountId>-<action>-<运营发起的时间戳>`），MUST NOT 顺手用随机数或当前时刻。
   */
  requestKey: string;
}

function isCleanIdPart(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes(OPERATOR_COMMAND_ID_SEPARATOR) &&
    !/\s/.test(value)
  );
}

/**
 * 由三段拼出 `commandId`。**任一段非法返回 `null`，MUST NOT 兜底成随机 id**——
 * 调用方拿到 `null` MUST 当场判成参数错误并拒绝下发（传输层把它译成
 * `api_direct_invalid_request`），因为一个「兜底生成」的幂等键无法判重，
 * 重试会真的产生第二次副作用。
 */
export function operatorCommandId(parts: OperatorCommandIdParts): string | null {
  if (!isOperatorCommandKind(parts.kind)) return null;
  if (!isCleanIdPart(parts.scope) || !isCleanIdPart(parts.requestKey)) return null;
  return [parts.kind, parts.scope, parts.requestKey].join(OPERATOR_COMMAND_ID_SEPARATOR);
}

/** 反解 `commandId`；解析不出返回 `null`（供接收方记账时按 kind 分表 / 排障）。 */
export function parseOperatorCommandId(commandId: unknown): OperatorCommandIdParts | null {
  if (typeof commandId !== 'string') return null;
  const segments = commandId.split(OPERATOR_COMMAND_ID_SEPARATOR);
  if (segments.length !== 3) return null;
  const [kind, scope, requestKey] = segments;
  if (!isOperatorCommandKind(kind)) return null;
  if (!isCleanIdPart(scope) || !isCleanIdPart(requestKey)) return null;
  return { kind, scope, requestKey };
}

/* ──────────────────────────────────── 未送达 / 业务拒绝（语义 B）*/

/**
 * 「指令未送达」的具名原因。**它是一个被送达并被明确回答的结论**（对面在，但这条指令没有处理器），
 * 与「结果未知」（对面没答上来，见语义 C）是两回事，二者 MUST NOT 合流。
 */
export const OPERATOR_COMMAND_UNDELIVERED_REASONS = [
  /**
   * 接收进程里这条指令的处理器没被注入。今天单体里的等价形态是
   * `delegatedTaskService` / `publishScheduler` / `commentScheduler` / 调度启停闭包为 `undefined`。
   */
  'handler_not_wired',
] as const;

export type OperatorCommandUndeliveredReason =
  (typeof OPERATOR_COMMAND_UNDELIVERED_REASONS)[number];

export function isOperatorCommandUndeliveredReason(
  value: unknown,
): value is OperatorCommandUndeliveredReason {
  return (
    typeof value === 'string' &&
    (OPERATOR_COMMAND_UNDELIVERED_REASONS as readonly string[]).includes(value)
  );
}

/**
 * 处理器的**业务拒绝**（送达了、跑了、明确说不）。三字段齐全跨线，客户端据此在端口边界重建
 * `DelegatedTaskServiceError` 抛出。
 *
 * `status` **MUST 由处理器给出**：客户端补默认值就是「缺席压成默认值」——把 409（版本冲突 /
 * 账号已暂停）、422（平台不支持该委托）一律压成 400，api 的 HTTP 语义当场失真。
 */
export interface OperatorCommandRejection {
  /** 处理器给的具名原因码（如 `empty_request` / `account_name_required` / `unsupported_action`）。 */
  code: string;
  /** 面向运营的可读说明。**MUST NOT 参与任何判定**（文案会变，原因码不会）。 */
  message: string;
  /** 处理器给的 HTTP 语义状态码。 */
  status: number;
}

export function isOperatorCommandRejection(value: unknown): value is OperatorCommandRejection {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as { code?: unknown; message?: unknown; status?: unknown };
  return (
    typeof o.code === 'string' &&
    o.code.length > 0 &&
    typeof o.message === 'string' &&
    Number.isInteger(o.status)
  );
}

/**
 * 把带内的业务拒绝重建成本仓既有的 {@link DelegatedTaskServiceError} 抛出物。
 *
 * 给那些**今天就靠抛**的调用点用（飞书 delegate handler、客户端 API 路由），使其行为逐位不变。
 * 三个字段全部来自处理器的回执，**这里一个默认值都不补**——尤其 `status`：补 400 会把
 * 409（账号已暂停 / 版本冲突）与 422（平台不支持该委托）一并压平。
 */
export function delegatedTaskRejectionToError(
  rejection: OperatorCommandRejection,
): DelegatedTaskServiceError {
  return new DelegatedTaskServiceError(rejection.code, rejection.message, rejection.status);
}

/* ─────────────────────────────── 业务错误的结构化识别（跨进程） */

/**
 * {@link DelegatedTaskServiceError} 实例上的 `name` 取值。它是**跨进程识别键**，
 * 该类构造时已逐字写入实例（自有可枚举属性），故序列化往返后仍在。
 */
export const DELEGATED_TASK_SERVICE_ERROR_NAME = 'DelegatedTaskServiceError';

/**
 * 跨进程边界上委托任务业务错误的**最小可识别形状**。
 * 只认 `name` + `code` 两个自有可枚举属性：`message` 是 Error 构造器定义的**不可枚举**自有属性，
 * JSON 往返后不一定还在，把它列进判定条件会让守卫在真实线路上失效。
 */
export interface DelegatedTaskServiceErrorShape {
  name: typeof DELEGATED_TASK_SERVICE_ERROR_NAME;
  code: string;
  message?: string;
  status?: number;
}

/**
 * 结构化识别委托任务业务错误。**同进程实例与跨进程反序列化对象一视同仁。**
 *
 * 存在理由（不是防御性编程，是已具名的缺口）：实测**三个文件、六个调用点**今天都用
 * `instanceof DelegatedTaskServiceError` 认它——`src/feishu/delegated-task-card.ts`（1）、
 * `src/client-auth/client-auth-server.ts`（**4**，四段逐字重复）、
 * 以及 `src/panel/panel-server.ts` 的委托任务错误出口（1）。
 * 拆进程后这六处恒 false —— 卡片上的 `version_conflict` 会退化成普通错误 toast 且不再回刷新卡，
 * 客户端 API 的 409 / 422 会一律塌成 500，**后台控制台发起的委托任务同样塌成一条泛化 500**。
 * 六处均已迁到本守卫。
 */
export function isDelegatedTaskServiceError(
  value: unknown,
): value is DelegatedTaskServiceErrorShape {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as { name?: unknown; code?: unknown };
  return o.name === DELEGATED_TASK_SERVICE_ERROR_NAME && typeof o.code === 'string' && o.code !== '';
}

/**
 * 内部传输层**自己**产出的错误码全集（`InternalHttpError` 的 code + 4a 信封 / 写路径的 code）。
 *
 * 用途是一条**补集**判据：线上错误码若**不在**本表内，它就是处理器给的业务原因码，
 * MUST 还原成业务错误；在本表内的一律按传输失败处置（语义 C：结果未知）。
 * 为什么用补集而不是「业务码白名单」：业务码会随处理器增长，白名单必然滞后，
 * 而滞后的表现是**新原因码被静默吞成传输错误**——运营看到「服务不可用」，真相是「账号已暂停」。
 *
 * `handler_error` 刻意在表内：它恰恰表示处理器抛了一个**没有具名 code** 的东西，那就是未知，
 * MUST NOT 被伪造成某个业务原因。
 */
export const OPERATOR_COMMAND_TRANSPORT_ERROR_CODES = [
  'timeout',
  'transport_error',
  'bad_response',
  'handler_error',
  'route_conflict',
  'internal_http_unauthorized',
  'internal_http_auth_config_invalid',
  'api_direct_invalid_request',
  'api_direct_version_unsupported',
  'api_direct_target_mismatch',
  'api_authority_unavailable',
  'api_authority_bad_response',
  'api_authority_result_unknown',
] as const;

export type OperatorCommandTransportErrorCode =
  (typeof OPERATOR_COMMAND_TRANSPORT_ERROR_CODES)[number];

/** 该 code 是否由传输层自己产出（true ⇒ 结果未知；false ⇒ 处理器的业务原因码）。 */
export function isOperatorCommandTransportErrorCode(
  code: unknown,
): code is OperatorCommandTransportErrorCode {
  return (
    typeof code === 'string' &&
    (OPERATOR_COMMAND_TRANSPORT_ERROR_CODES as readonly string[]).includes(code)
  );
}

/* ────────────────────────────────────── ① 自由文本委托 */

/**
 * 自由文本委托的入参。**`text` 是运营原文，整体转发。**
 *
 * 红线：**意图解析 MUST 留在 automation。** api 侧 MUST NOT 自己拼一个 intent 再去调结构化入口——
 * 解析规则与语料（时间词、数量词、控制命令正则、账号昵称解析）全在 automation 的解析器里，
 * 在 api 侧重做一份，「解析错了」就变成 api 的一个无人知晓的静默行为，且两份规则必然漂移。
 */
export interface DelegatedTaskTextCommandInput {
  commandId: string;
  /** 运营输入的原始文本，**不做任何预解析 / 预归一**。 */
  text: string;
  /** 去重 / 溯源用的来源引用（飞书 messageId 或 chatId）。 */
  sourceRef?: string;
  /** 命令来源会话（飞书 chatId）：确认卡 / 终态卡回投的目标。 */
  originChatId?: string;
}

/**
 * 文本里识别出的**控制动作**（针对已存在任务）。
 * 取值 MUST 与 automation 解析器的 `DelegatedControlAction` 逐字一致；这里重述一份是因为
 * 那个类型住在 automation 属主的解析器文件里，kernel MUST NOT 反向 import 业务层。
 */
export type DelegatedTaskControlAction = 'pause' | 'resume' | 'cancel' | 'status';

/** 文本被识别成「新建委托」。 */
export interface DelegatedTaskTextDraftOutcome {
  kind: 'task';
  task: DelegatedTask;
  confirmation: DelegatedTaskConfirmationSummary;
  /** false = 命中既有同 dedupeKey 的待确认任务（不是新建）。 */
  created: boolean;
  /** true = 精确命令直接入队（不出确认卡）。 */
  autoQueued: boolean;
}

/**
 * 文本被识别成「对既有任务的控制」。**只带 api 侧真正消费的两段**（动作 + 任务号），
 * 后续的 pause / resume / cancel / get 由调用方经 {@link DelegatedTaskCommandPort} 的既有 7 方法执行，
 * 与今天单体里的调用序列逐位一致。
 */
export interface DelegatedTaskTextControlOutcome {
  kind: 'control';
  action: DelegatedTaskControlAction;
  taskId: string;
}

export type DelegatedTaskTextOutcome =
  | DelegatedTaskTextDraftOutcome
  | DelegatedTaskTextControlOutcome;

/**
 * 自由文本委托的回执。
 *
 * `rejected` 覆盖**解析失败**与**创建期业务拒绝**两类：二者都 MUST 带具名 `code` 回来
 * （`empty_request` / `account_name_required` / `invalid_task` / `unsupported_action` / `account_paused` …），
 * 且**MUST NOT 落一条无意图的委托任务**——解析不出目标就是没有目标，凭空建一条 draft
 * 等于让运营在确认卡上看到一个系统自己编出来的任务。
 */
export type DelegatedTaskTextCommandReceipt =
  | { outcome: 'applied' | 'duplicate'; commandId: string; result: DelegatedTaskTextOutcome }
  | { outcome: 'rejected'; commandId: string; rejection: OperatorCommandRejection }
  | { outcome: 'not_delivered'; commandId: string; reason: OperatorCommandUndeliveredReason }
  | { outcome: 'collision'; commandId: string };

/**
 * 委托端口**缺失的那一个方法**。
 *
 * 实测：既有 `DelegatedTaskServicePort`（`delegated-task-types.ts`）只有 7 个方法
 * （createDraft / confirm / pause / resume / cancel / get / list），既有传输三件套
 * （`src/transport/delegated-task-http.ts`）的路由表也正好 7 条 —— **自由文本入口
 * `createFromText` 两处都不在**。而 `src/server.ts` 的飞书 delegate handler 调的正是它。
 * 端口按现状注入过去，飞书自由文本委托会整条不可用。本接口补上这一个方法。
 */
export interface DelegatedTaskTextCommandPort {
  createFromText(input: DelegatedTaskTextCommandInput): Promise<DelegatedTaskTextCommandReceipt>;
}

/**
 * 委托任务的**完整跨属主面** = 既有 7 方法 + 自由文本入口。
 *
 * 一并覆盖第 ③ 条（委托任务卡片动作）：那条的处理器 `handleDelegatedTaskCardAction` 本来就是
 * **api 属主**（`src/feishu/` 整目录归 api），它只是**调** automation 属主的服务端口
 * （confirm / cancel / pause / resume / get，全在既有 7 方法内）。**没有任何代码需要搬家**，
 * 缺的只是把本端口注入进去 —— 注入本端口即同时点亮 ① 与 ③。
 *
 * 注意 ③ 还有一个**不在注入范围内**的缺口：卡片处理器按 `version_conflict` 分流时用的是
 * `instanceof`，见 {@link isDelegatedTaskServiceError} 的说明。
 */
export interface DelegatedTaskCommandPort
  extends DelegatedTaskServicePort, DelegatedTaskTextCommandPort {}

/* ────────────────────────────────── ② 发布指令（手动 /publish） */

/**
 * 手动发帖指令入参。处理器是发布调度器的 `triggerManual(accountId?, opts?)`。
 *
 * `accountId` **收成必填**：今天 api 侧在下发前已用昵称解析出真实账号，缺省解析（「唯一真实账号」）
 * 是 automation 本地扳机才用的路径。跨边界保留一个可缺省的账号位，等于把「解析不出唯一账号」
 * 这类失败推到边界另一侧、再以一个笼统 blocked 回来。
 *
 * 参照稿洗稿（`referenceNote`）**刻意不在本入参内**：那条链路走的是另一个方法（console 的洗稿触发），
 * 今天的 api 命令面从不设置它。需要时再按 YAGNI 补，不预留空位。
 */
export interface ManualPublishCommandInput {
  commandId: string;
  accountId: string;
  /** 触发本次指令的飞书会话；审批卡优先投这里。 */
  manualApprovalChatId?: string;
}

/**
 * 手动发帖回执。`result` 逐字复用 kernel 既有的 {@link TriggerOutcome}
 * （`triggered` / `skipped` / `blocked` 三态本身就是处理器的诚实回报，MUST NOT 在边界上再压平）。
 */
export type ManualPublishCommandReceipt =
  | { outcome: 'applied' | 'duplicate'; commandId: string; accountId: string; result: TriggerOutcome }
  | { outcome: 'not_delivered'; commandId: string; reason: OperatorCommandUndeliveredReason }
  | { outcome: 'collision'; commandId: string };

export interface ManualPublishCommandPort {
  triggerManualPublish(input: ManualPublishCommandInput): Promise<ManualPublishCommandReceipt>;
}

/* ────────────────────────────────── ② 评论指令（手动 /comment） */

/**
 * 手动按需评论指令入参。处理器是评论调度器的 `triggerManual(accountId, options?)`。
 *
 * 只收**JSON 安全且 api 侧真会设置的**那几个开关；调度器 options 里的回调型字段
 * （`onResult` / `actionGate`）与仅内部调用方使用的字段（`contactFallback` / `source` / `priority` /
 * `approvalMode`）**MUST NOT** 出现在跨进程面上 —— 尤其 `contactFallback`：它是一条「具名放弃」
 * 的授权，六个入口里只有 Facebook 规则模式那一个有资格传，开在运营指令面上等于把它变成默认可达。
 */
export interface ManualCommentCommandInput {
  commandId: string;
  accountId: string;
  /**
   * 操作员单次越权（今天 api 侧对手动 `/comment` 恒为 `true`）。**收成必填**：
   * 接收方 MUST NOT 替调用方补默认值 —— 越权与否是运营授权事实，缺席不得压成任何一侧。
   */
  manualOverride: boolean;
  /** `--contact`：注入账号联系方式。缺省 = 不注入（不是「未知」，是运营没要求）。 */
  injectContact?: boolean;
  /** `--join`：先加群再评论。 */
  joinFirst?: boolean;
  /** `--join=<url>`：指定要加入的群。 */
  joinGroupUrl?: string;
  /** `--force`：放开两道内容筛选。 */
  force?: boolean;
  /** 评论后尽快回到 feed。 */
  fastReturnToFeed?: boolean;
}

/**
 * 手动评论回执。`result` 逐字复用 kernel 既有的 {@link CommentCommandReceipt}
 * （它本身已带 `ok` / `level` / 可重试 `code`，是处理器对**触发结果**的结构化回报；
 * 最终评论结果由任务自己的结果卡异步回报，本回执 MUST NOT 冒充终态）。
 */
export type ManualCommentCommandReceipt =
  | {
      outcome: 'applied' | 'duplicate';
      commandId: string;
      accountId: string;
      result: CommentCommandReceipt;
    }
  | { outcome: 'not_delivered'; commandId: string; reason: OperatorCommandUndeliveredReason }
  | { outcome: 'collision'; commandId: string };

export interface ManualCommentCommandPort {
  triggerManualComment(input: ManualCommentCommandInput): Promise<ManualCommentCommandReceipt>;
}

/* ─────────────────────────────────────── ④ 调度启停（paired command） */

/**
 * 调度启停的**入口只有面板**。
 *
 * 实测坐实：飞书命令面 `src/feishu/command-face.ts` 组装的动作全集是
 * status / pause / resume / bindChat / delegate / publish / comment —— **没有 dispatch**。
 * `dispatch` / `dispatchActive` 只进 `panelCommandActions`（面板 `POST /api/accounts/:id/dispatch`）
 * 与 dashboard summary 的状态灯。**「飞书 dispatch」这条通道自始至终不存在**，
 * 故本条一次接线同时点亮面板按钮与状态灯，**飞书侧零改动**。
 *
 * 处理器是 `src/server.ts` 里的就地闭包 `ctx.automationDispatchCommands`：驱动运行时的
 * startAll / endAll 与在线边缘计数。
 */
export type AutomationDispatchAction = 'start' | 'stop';

export interface AutomationDispatchCommandInput {
  commandId: string;
  /**
   * 面板点击所指的账号。现役是**单全局调度引擎**，故它对引擎而言是信息性的；
   * 但它仍是幂等键的 scope，且 per-edge 拆分后会变成真作用域。
   */
  accountId: string;
  action: AutomationDispatchAction;
}

/**
 * 启停后的事实。**四段全部是观测值**：`changed` 是本次是否真的翻转（不是「我请求了所以变了」），
 * `edgesOnline` 是真实在线边缘数（绝不乐观）。
 */
export interface AutomationDispatchState {
  accountId: string;
  dispatch: 'started' | 'stopped';
  changed: boolean;
  edgesOnline: number;
}

/**
 * 启停回执。
 *
 * `duplicate` 的 `state` MUST 是台账里存的**首次结果**：重放一次 start 时现算一个
 * `changed:false` 是编造——首次那一下到底翻没翻转，只有首次的记录知道。
 */
export type AutomationDispatchCommandReceipt =
  | { outcome: 'applied' | 'duplicate'; commandId: string; state: AutomationDispatchState }
  | { outcome: 'not_delivered'; commandId: string; reason: OperatorCommandUndeliveredReason }
  | { outcome: 'collision'; commandId: string };

/**
 * 状态灯读数。**三态，不是布尔。**
 *
 * `unavailable` MUST NOT 被压成 `active:false` —— 「读不到调度引擎」与「调度引擎停着」在面板上
 * 长得一模一样，但一个要人去查进程、另一个是正常停机状态。今天单体里的面板已经是三态
 * （未注入 → `dispatchActive: null`），跨进程后 MUST 保持三态。
 */
export type AutomationDispatchActivity =
  | { state: 'known'; active: boolean }
  | { state: 'unavailable'; reason: OperatorCommandUndeliveredReason };

export interface AutomationDispatchCommandPort {
  /** 下发启停。 */
  setDispatch(input: AutomationDispatchCommandInput): Promise<AutomationDispatchCommandReceipt>;
  /** 读当前是否在跑（状态灯）。入参为空信封，版本与 target 仍随请求走。 */
  readDispatchActivity(): Promise<AutomationDispatchActivity>;
}

/* ───────────────────────────────────────────────────────── 机械普查 */

/**
 * 方法面机械普查（照 4a 的 `API_DIRECT_PORT_INVENTORY` 形状）。把方法名逐字钉在这里，
 * 使得「路由表 / 包导出 / 端口面」三者漂移时测试当场失败，而不是等到运行期 404。
 */
export const OPERATOR_COMMAND_PORT_INVENTORY = {
  delegatedTaskText: ['createFromText'],
  delegatedTaskFull: [
    'createFromText',
    'createDraft',
    'confirm',
    'pause',
    'resume',
    'cancel',
    'get',
    'list',
  ],
  manualPublish: ['triggerManualPublish'],
  manualComment: ['triggerManualComment'],
  automationDispatch: ['setDispatch', 'readDispatchActivity'],
} as const;

export type OperatorCommandPortGroup = keyof typeof OPERATOR_COMMAND_PORT_INVENTORY;
