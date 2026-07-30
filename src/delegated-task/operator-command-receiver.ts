/**
 * 运营指令在 **automation 侧的唯一接收方**（属主 automation）。
 *
 * 它同时是两条路径的实现，这是刻意的：
 *   (a) 单进程形态下组装根注入给取数聚合口的**本地实现**；
 *   (b) 拆进程后内部 HTTP 路由挂上去的**处理器**。
 * 一份实现服务两条路径 ⇒ 幂等语义、拒绝翻译、作用域校验**不可能**在两条路径上长歪。
 * 写第二份是这一族最容易犯的错：两份各自编译过、各自测试过，只在真跑起来那一刻才对不上。
 *
 * ── 三件事必须在这一层做完，不能推给传输层 ─────────────────────────────────
 *   1. **业务拒绝 catch 成带内回执**（三字段原样，`status` 取服务给的那个、不补默认）——
 *      因为线格式对一个裸抛出物只保 code + message，`status` 跨那一跳会丢，而在客户端补一个
 *      默认 400 会把 409（版本冲突 / 账号已暂停）与 422（平台不支持）一并压平。
 *   2. **形状翻译**：服务返回 `{kind:'control', request:<解析结果全体>}`，契约只要
 *      `{kind:'control', action, taskId}`（kernel 刻意只留 api 侧真正消费的两段）。
 *   3. **台账三态与 `collision` 判定**（见 {@link OperatorCommandLedger}）。
 *
 * ── 「处理器没接线」在两个面上形态不同，这个不对称是固有的 ────────────────────
 * 自由文本那条有带内回执，故回 `outcome:'not_delivered'` + 具名原因（契约要求它**不是异常**）。
 * 而既有 7 方法的签名是「返回裸值、失败靠抛」，那一面**没有**带内通道，所以只能抛。
 * 抛出物 MUST 结构上区别于业务拒绝（{@link HandlerNotWiredError} 的 `name` 与
 * `DelegatedTaskServiceError` 不同）——否则「这台机器上没有这个处理器」会被渲染成
 * 「你的请求被拒绝了」，运营会去改参数重试，而重试对它无效。
 */
import {
  isDelegatedTaskServiceError,
  parseOperatorCommandId,
  type AutomationDispatchAction,
  type AutomationDispatchActivity,
  type AutomationDispatchCommandInput,
  type AutomationDispatchCommandPort,
  type AutomationDispatchCommandReceipt,
  type AutomationDispatchState,
  type DelegatedTaskCommandPort,
  type DelegatedTaskControlAction,
  type DelegatedTaskTextCommandInput,
  type DelegatedTaskTextCommandReceipt,
  type DelegatedTaskTextOutcome,
  type OperatorCommandKind,
  type OperatorCommandRejection,
} from '../kernel/operator-command-port.js';
import type {
  DelegatedActionFamily,
  DelegatedTask,
  DelegatedTaskConfirmationSummary,
  DelegatedTaskIntent,
  DelegatedTaskStatus,
} from '../kernel/delegated-task-types.js';
import type { OperatorCommandLedger } from './operator-command-ledger.js';

/**
 * 「这台机器上没有这个处理器」。**不是业务拒绝**——`name` 与 `DelegatedTaskServiceError` 不同，
 * 所以结构化守卫认不出它，调用方不会把它渲染成一次被拒绝的请求。
 */
export class HandlerNotWiredError extends Error {
  readonly code = 'automation_handler_not_wired';

  constructor(method: string) {
    super(`delegated task handler is not wired in this process: ${method}`);
    this.name = 'HandlerNotWiredError';
  }
}

/**
 * 「抢到台账、但那一次的结局不可知」。
 *
 * `code` 刻意取传输层码表里那个未知码：客户端侧的**补集**判据据此把它认成传输失败
 * （= 结果未知），而不是某个业务原因。**MUST NOT 换成一个业务风格的码**——
 * 那会让「不知道」被读成「对面明确说了什么」。
 */
export class OperatorCommandResultUnknownError extends Error {
  readonly code = 'api_authority_result_unknown';

  constructor(readonly commandId: string) {
    super(
      `operator command ${commandId} is still recorded as in flight; its outcome is unknown`
      + ' (do not retry this key: a new operator message gets a new key)',
    );
    this.name = 'OperatorCommandResultUnknownError';
  }
}

/** 命令键非法 / kind 不符时抛它：**绝不拿一把算不出来的键去记账**（记了也判不了重）。 */
export class OperatorCommandIdInvalidError extends Error {
  readonly code = 'api_direct_invalid_request';

  constructor(commandId: string, detail: string) {
    super(`operator commandId is unusable (${detail}): ${commandId}`);
    this.name = 'OperatorCommandIdInvalidError';
  }
}

/**
 * 服务侧自由文本入口的真实形状（automation 本地类的方法，非 kernel 契约）。
 *
 * `confirmation` **刻意声明成 kernel 那个具体类型、而不是 `unknown` + 断言**：服务用的就是同一个
 * kernel 类型，声明具体类型让编译器真的去核对；写 `unknown as ...` 会把「摘要形状漂了」
 * 这类真问题一并断言掉。
 */
export interface DelegatedTaskTextSource {
  createFromText(
    text: string,
    opts?: { sourceRef?: string; originChatId?: string },
  ): Promise<
    | {
        kind: 'task';
        task: DelegatedTask;
        confirmation: DelegatedTaskConfirmationSummary;
        created: boolean;
        autoQueued: boolean;
      }
    | { kind: 'control'; request: { action: DelegatedTaskControlAction; taskId: string } }
  >;
}

/** 既有 7 方法窄面（组装根注入的那个服务实例结构上满足它）。 */
export interface DelegatedTaskServiceSource extends DelegatedTaskTextSource {
  createDraft(intent: DelegatedTaskIntent): Promise<{
    task: DelegatedTask;
    confirmation: DelegatedTaskConfirmationSummary;
    created: boolean;
    autoQueued: boolean;
  }>;
  confirm(taskId: string, version: number): Promise<DelegatedTask>;
  pause(taskId: string, version?: number): Promise<DelegatedTask>;
  resume(taskId: string, version?: number): Promise<DelegatedTask>;
  cancel(taskId: string, version?: number): Promise<DelegatedTask>;
  get(taskId: string): Promise<DelegatedTask>;
  list(filter?: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  }): Promise<DelegatedTask[]>;
}

export interface DelegatedTaskCommandReceiverDeps {
  /**
   * 本地服务实例。**允许缺席**（api 独立起进程时它物理上不存在），缺席时自由文本那条回
   * `not_delivered`、7 方法抛 {@link HandlerNotWiredError}。
   */
  service: DelegatedTaskServiceSource | null | undefined;
  ledger: OperatorCommandLedger;
}

function rejectionOf(error: unknown): OperatorCommandRejection | null {
  if (!isDelegatedTaskServiceError(error)) return null;
  const status = (error as { status?: unknown }).status;
  // status 必须是处理器给的整数。给不出就**不当成业务拒绝**——降级成「结果未知」是安全方向
  // （调用方会如实报未知），反过来编一个 status 才是编造事实。
  if (!Number.isInteger(status)) return null;
  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : error.code;
  return { code: error.code, message, status: status as number };
}

/**
 * 承接自由文本委托（第 8 个方法）与既有 7 方法的**单一接收方**。
 *
 * 台账只管**有真副作用的那一条**（自由文本委托会落一条委托任务并可能自动入队）。
 * 既有 7 方法**刻意不进台账**：它们的入参里没有命令键，且各自已有版本号乐观锁
 * （`confirm` 比 version、`pause`/`resume`/`cancel` 幂等到状态机上）——
 * 给它们套一层按键判重会新造一套与状态机并存的第二判据。
 */
export class DelegatedTaskCommandReceiver implements DelegatedTaskCommandPort {
  /**
   * 同进程内正在跑的那一次。**它不是缓存，是为了让「同一进程里的重投」拿到真答案**：
   * 台账那一行此刻是 `in_flight`，只读台账只能回「结果未知」，而这里握着 promise，
   * 等一下就知道真结局。落到台账那一格的因此只剩「进程真的死过」或「是另一个进程」两种。
   */
  private readonly inFlight = new Map<string, Promise<DelegatedTaskTextOutcome>>();

  constructor(private readonly deps: DelegatedTaskCommandReceiverDeps) {}

  /* ─────────────────────────── 第 8 个方法：自由文本委托（带台账） */

  async createFromText(
    input: DelegatedTaskTextCommandInput,
  ): Promise<DelegatedTaskTextCommandReceipt> {
    const scope = this.requireScope(input.commandId, 'delegated_task_text');
    const service = this.deps.service;
    if (!service) {
      // 契约要求：**不是异常**。「没接线」是一个被送达并被明确回答的结论，
      // 与「结果未知」（对面没答上来）是两回事，二者 MUST NOT 合流。
      return { outcome: 'not_delivered', commandId: input.commandId, reason: 'handler_not_wired' };
    }

    const claim = await this.deps.ledger.claim({
      commandId: input.commandId,
      kind: 'delegated_task_text',
      scope,
    });

    if (claim.outcome === 'existing') {
      const row = claim.row;
      if (row.scope !== scope) return { outcome: 'collision', commandId: input.commandId };
      if (row.state === 'applied') {
        // **原样回放首次结果**：这里是从台账读出来的载荷，不是重新算一遍。
        return {
          outcome: 'duplicate',
          commandId: input.commandId,
          result: row.receipt as DelegatedTaskTextOutcome,
        };
      }
      if (row.state === 'rejected') {
        return { outcome: 'rejected', commandId: input.commandId, rejection: row.rejection };
      }
      // state === 'in_flight'
      const running = this.inFlight.get(input.commandId);
      if (running) {
        // 同进程里那一次还在跑：等它拿到真结局，再按 duplicate 回。
        return { outcome: 'duplicate', commandId: input.commandId, result: await running };
      }
      throw new OperatorCommandResultUnknownError(input.commandId);
    }

    const running = this.runText(service, input);
    this.inFlight.set(input.commandId, running);
    try {
      const result = await running;
      await this.deps.ledger.settleApplied(input.commandId, result);
      return { outcome: 'applied', commandId: input.commandId, result };
    } catch (error) {
      const rejection = rejectionOf(error);
      if (!rejection) {
        // 非业务错误：**台账那一行留在 in_flight**，重放会得到「结果未知」。
        // 这是有意的——副作用可能已经发生，我们确实不知道。理由见 ledger 文件头。
        throw error;
      }
      await this.deps.ledger.settleRejected(input.commandId, rejection);
      return { outcome: 'rejected', commandId: input.commandId, rejection };
    } finally {
      if (this.inFlight.get(input.commandId) === running) this.inFlight.delete(input.commandId);
    }
  }

  private async runText(
    service: DelegatedTaskTextSource,
    input: DelegatedTaskTextCommandInput,
  ): Promise<DelegatedTaskTextOutcome> {
    const result = await service.createFromText(input.text, {
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      ...(input.originChatId === undefined ? {} : { originChatId: input.originChatId }),
    });
    if (result.kind === 'control') {
      // 形状翻译：只带 api 侧真正消费的两段。后续 pause / resume / cancel / get 由调用方
      // 经既有 7 方法执行，与单体里的调用序列逐位一致。
      return { kind: 'control', action: result.request.action, taskId: result.request.taskId };
    }
    return {
      kind: 'task',
      task: result.task,
      confirmation: result.confirmation,
      created: result.created,
      autoQueued: result.autoQueued,
    };
  }

  /**
   * 命令键必须算得出、且 kind 必须对得上。
   *
   * **对自由文本这条，`collision` 在结构上打不响**，这一点明说而不隐藏：`commandId` 形如
   * `kind:scope:requestKey`，scope 就在键里，所以「同键不同 scope」自相矛盾、永远不会发生。
   * 真会发生的是**手动发帖 / 评论**那两条——它们的入参另带 `accountId`，与键里的 scope 是两个来源，
   * 对不上就是调用方复用了别人的键。那条分支留着是给它们用的，不是给这条用的。
   * （所以不要看到 `collision` 分支就以为这条命令有这层保护。）
   */
  private requireScope(commandId: string, expected: OperatorCommandKind): string {
    const parts = parseOperatorCommandId(commandId);
    if (!parts) {
      throw new OperatorCommandIdInvalidError(commandId, 'not a well-formed operator command id');
    }
    if (parts.kind !== expected) {
      throw new OperatorCommandIdInvalidError(commandId, `kind is ${parts.kind}, expected ${expected}`);
    }
    return parts.scope;
  }

  /* ─────────────────────────── 既有 7 方法：直接转调，不进台账 */

  /**
   * 取本地服务，缺席即抛。
   *
   * **七个转调方法一律声明成 `async`**，不写成「同步 throw + 返回 promise」的省事形态：
   * 端口签名承诺返回 Promise，而同步抛会让 `port.get(x).catch(...)` 这类调用方**抓不住**
   * ——异常在拿到 promise 之前就飞出去了。这条是用例实测抓出来的，不是风格洁癖。
   */
  private require(method: string): DelegatedTaskServiceSource {
    const service = this.deps.service;
    if (!service) throw new HandlerNotWiredError(method);
    return service;
  }

  async createDraft(intent: DelegatedTaskIntent): Promise<{
    task: DelegatedTask;
    confirmation: DelegatedTaskConfirmationSummary;
    created: boolean;
    autoQueued: boolean;
  }> {
    return this.require('createDraft').createDraft(intent);
  }

  async confirm(taskId: string, version: number): Promise<DelegatedTask> {
    return this.require('confirm').confirm(taskId, version);
  }

  async pause(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.require('pause').pause(taskId, version);
  }

  async resume(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.require('resume').resume(taskId, version);
  }

  async cancel(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.require('cancel').cancel(taskId, version);
  }

  async get(taskId: string): Promise<DelegatedTask> {
    return this.require('get').get(taskId);
  }

  async list(filter?: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  }): Promise<DelegatedTask[]> {
    return this.require('list').list(filter);
  }
}

/* ──────────────────────────────────── 调度启停：刻意**没有**持久台账 */

export interface AutomationDispatchHandles {
  /** 翻转调度引擎，回报**观测到的**事实（`changed` 是本次是否真翻转，不是「我请求了所以变了」）。 */
  setDispatch(accountId: string, action: AutomationDispatchAction): Promise<AutomationDispatchState>;
  /** 当前是否在跑。 */
  isActive(): boolean;
}

/**
 * 调度启停的接收方。**刻意不带持久台账，理由必须留在这里，否则将来一定有人为了「四条一致」把它补上。**
 *
 * 它改的状态本身就是**进程内的一个布尔**。给它一个跨重启的台账，会让「重启后运营再点一次启动」
 * 被判成 `duplicate` 并回放一条陈旧的「是否真翻转」——**那是编造事实**，正是本仓红线的形态。
 * 4a 的既有判例逐字支持这条：`src/comm/edge-resume-command-receiver.ts` 明写
 * 「回执缓存刻意是进程内的，因为它管的状态也是进程内的，本适配器 MUST NOT 暗示持久的恰好一次」。
 *
 * 所以这里只有**进程内**的回执表：同一进程内的重投拿回首次结果，重启后**重新执行**（这是对的）。
 */
export class AutomationDispatchCommandReceiver implements AutomationDispatchCommandPort {
  private readonly receipts = new Map<string, { scope: string; state: AutomationDispatchState }>();

  constructor(private readonly handles: AutomationDispatchHandles | null | undefined) {}

  async setDispatch(
    input: AutomationDispatchCommandInput,
  ): Promise<AutomationDispatchCommandReceipt> {
    const handles = this.handles;
    if (!handles) {
      return { outcome: 'not_delivered', commandId: input.commandId, reason: 'handler_not_wired' };
    }
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      // 判据形态照 4a：比**入参里那个账号**，不比从键反解的那个。
      if (previous.scope !== input.accountId) {
        return { outcome: 'collision', commandId: input.commandId };
      }
      // 原样回放首次观测到的事实。**MUST NOT 现算一个 `changed:false`**——
      // 首次那一下到底翻没翻转，只有首次的记录知道。
      return { outcome: 'duplicate', commandId: input.commandId, state: previous.state };
    }
    const state = await handles.setDispatch(input.accountId, input.action);
    this.receipts.set(input.commandId, { scope: input.accountId, state });
    return { outcome: 'applied', commandId: input.commandId, state };
  }

  async readDispatchActivity(): Promise<AutomationDispatchActivity> {
    const handles = this.handles;
    // 三态严格：读不到 MUST NOT 压成 `active:false`——「读不到调度引擎」与「调度引擎停着」
    // 在面板上长得一模一样，但一个要人去查进程、另一个是正常停机状态。
    if (!handles) return { state: 'unavailable', reason: 'handler_not_wired' };
    return { state: 'known', active: handles.isActive() };
  }
}
