/**
 * 互动域「编排面」的跨进程搬运：回复工作流写侧（3 个跃迁）+ 发送编排（5 个方法）。
 *
 * ## 为什么必须有它
 * 客户端的收件箱那一整片路由由**接口进程**服务，而生成 / 审批 / 编辑 / 入队 / 下发 / 同步 /
 * 重开登录 / 浏览器控制这八件事的实现全在**自动化进程**（它才持有边缘连接注册表与推送出口）。
 * 拆开之后接口进程一件都做不了 —— 后果不是 503，是**整片路由 404**：
 * 收件箱那个构造式是五个依赖的全或无，缺一个就整块不装，客户端看到的是「这个功能不存在」。
 *
 * ## 端口契约按引用共用
 * 两个端口的**唯一声明**在 `../kernel/interaction-automation-ports.ts`。本文件与接口仓的
 * 消费点、自动化仓的属主实例三方共用那一份；这里 MUST NOT 再声明一份结构相同的接口
 * —— 那种第二份实现漂开时两侧都编译通过、两侧测试都过，只有真跑起来且恰好走到那个参数才现形。
 *
 * ## 失败语义
 * 全族经 {@link interactionRoute} / {@link callInteraction} 走，保住 httpStatus / retryable /
 * details 三格。**提交点逐条点名**（见 `INTERACTION_SUBMISSION_METHODS`）：结果不明时报
 * 「已发出但核不到」，MUST NOT 折成一句可重试的失败。本层零重试。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  INTERACTION_SUBMISSION_METHODS,
  type InteractionSendPort,
  type ReplyWorkflowWritePort,
} from '../kernel/interaction-automation-ports.js';
import { InteractionError } from '../kernel/interaction-types.js';
import { callInteraction, interactionRoute, type InteractionCallKind } from './interaction-failure-wire.js';

type WorkflowP<M extends keyof ReplyWorkflowWritePort> = Parameters<ReplyWorkflowWritePort[M]>;
type WorkflowR<M extends keyof ReplyWorkflowWritePort> = Awaited<ReturnType<ReplyWorkflowWritePort[M]>>;
type SendP<M extends keyof InteractionSendPort> = Parameters<InteractionSendPort[M]>;
type SendR<M extends keyof InteractionSendPort> = Awaited<ReturnType<InteractionSendPort[M]>>;

/** 回复工作流写侧的路由名。`satisfies` 钉住「每个端口方法都有一条、且不多不少」。 */
export const INTERACTION_WORKFLOW_ROUTES = {
  generate: 'interaction-workflow/generate',
  approve: 'interaction-workflow/approve',
  edit: 'interaction-workflow/edit',
} as const satisfies Record<keyof ReplyWorkflowWritePort, string>;

/** 发送编排的路由名。 */
export const INTERACTION_SEND_ROUTES = {
  queueApproved: 'interaction-send/queue-approved',
  dispatchQueued: 'interaction-send/dispatch-queued',
  requestSync: 'interaction-send/request-sync',
  requestAuthReopen: 'interaction-send/request-auth-reopen',
  requestBrowserControl: 'interaction-send/request-browser-control',
} as const satisfies Record<keyof InteractionSendPort, string>;

const SUBMISSION_METHOD_NAMES: ReadonlySet<string> = new Set(INTERACTION_SUBMISSION_METHODS);

/**
 * 某个发送编排方法是不是提交点。**从名单派生、绝不在这里再抄一份**——
 * 手抄的第二份在新增提交点时不会有任何东西提醒你更新，
 * 而漏一条的后果是把「可能已上墙」报成「可重试」，客户端据此重投。
 */
function sendCallKind(method: keyof InteractionSendPort): InteractionCallKind {
  return SUBMISSION_METHOD_NAMES.has(method) ? 'submission' : 'read';
}

/** 在属主进程里挂上回复工作流写侧。 */
export function registerInteractionWorkflowRoutes(
  server: InternalHttpServer,
  local: ReplyWorkflowWritePort,
): void {
  server.register(
    INTERACTION_WORKFLOW_ROUTES.generate,
    interactionRoute((args) => local.generate(args as WorkflowP<'generate'>[0])),
  );
  server.register(
    INTERACTION_WORKFLOW_ROUTES.approve,
    interactionRoute((args) => local.approve(args as WorkflowP<'approve'>[0])),
  );
  server.register(
    INTERACTION_WORKFLOW_ROUTES.edit,
    interactionRoute((args) => local.edit(args as WorkflowP<'edit'>[0])),
  );
}

/**
 * 在属主进程里挂上发送编排。
 *
 * `requestSync` 的第二个实参 `options.beforeDispatch` 是个**回调**，跨不了进程：
 * 属主侧只按单参调用。调用侧若真传了它，由 client 那一头当场具名拒绝
 * —— MUST NOT 悄悄忽略：一个「本该在推送前跑一次」的钩子没跑，而调用方拿到成功回执，
 * 正是本仓那条红线说的静默假成功。
 */
export function registerInteractionSendRoutes(
  server: InternalHttpServer,
  local: InteractionSendPort,
): void {
  server.register(
    INTERACTION_SEND_ROUTES.queueApproved,
    interactionRoute((args) => local.queueApproved(args as SendP<'queueApproved'>[0])),
  );
  server.register(
    INTERACTION_SEND_ROUTES.dispatchQueued,
    interactionRoute((args) => local.dispatchQueued(args as SendP<'dispatchQueued'>[0])),
  );
  server.register(
    INTERACTION_SEND_ROUTES.requestSync,
    interactionRoute((args) => local.requestSync(args as SendP<'requestSync'>[0])),
  );
  server.register(
    INTERACTION_SEND_ROUTES.requestAuthReopen,
    interactionRoute((args) => local.requestAuthReopen(args as SendP<'requestAuthReopen'>[0])),
  );
  server.register(
    INTERACTION_SEND_ROUTES.requestBrowserControl,
    interactionRoute((args) => local.requestBrowserControl(args as SendP<'requestBrowserControl'>[0])),
  );
}

/**
 * 回复工作流写侧的 HTTP 实现。
 *
 * ⚠ 三个方法**都会跑一次模型调用**（生成 / 重写），最坏可到分钟级，而内部 HTTP 的默认
 * 单次超时是 15 秒 ⇒ 用默认值必然超时，而属主侧会照常把任务推进到下一个状态。
 * 那是「看起来失败其实成功」，比失败难查得多。**所以这个 client 必须拿一条放宽了超时的
 * 连接**，由组装根显式给（见 api 组装根里的分档说明）。这里不默默兜——兜了就没人知道要给。
 */
export class InteractionWorkflowHttpClient implements ReplyWorkflowWritePort {
  constructor(private readonly http: InternalHttpClient) {}

  generate(input: WorkflowP<'generate'>[0]): Promise<WorkflowR<'generate'>> {
    return callInteraction(this.http, INTERACTION_WORKFLOW_ROUTES.generate, input, 'read');
  }

  approve(input: WorkflowP<'approve'>[0]): Promise<WorkflowR<'approve'>> {
    return callInteraction(this.http, INTERACTION_WORKFLOW_ROUTES.approve, input, 'read');
  }

  edit(input: WorkflowP<'edit'>[0]): Promise<WorkflowR<'edit'>> {
    return callInteraction(this.http, INTERACTION_WORKFLOW_ROUTES.edit, input, 'read');
  }
}

/** 发送编排的 HTTP 实现。 */
export class InteractionSendHttpClient implements InteractionSendPort {
  constructor(private readonly http: InternalHttpClient) {}

  queueApproved(input: SendP<'queueApproved'>[0]): Promise<SendR<'queueApproved'>> {
    return callInteraction(
      this.http, INTERACTION_SEND_ROUTES.queueApproved, input, sendCallKind('queueApproved'),
    );
  }

  dispatchQueued(input: SendP<'dispatchQueued'>[0]): Promise<SendR<'dispatchQueued'>> {
    return callInteraction(
      this.http, INTERACTION_SEND_ROUTES.dispatchQueued, input, sendCallKind('dispatchQueued'),
    );
  }

  // `async` 不是修辞：声明成返回 Promise 却同步抛，调用方那句 `.catch()` 接不到，
  // 异常会从一个「不该同步抛」的位置逃出去。同一个方法必须只有一种失败形态。
  async requestSync(
    input: SendP<'requestSync'>[0],
    options?: SendP<'requestSync'>[1],
  ): Promise<SendR<'requestSync'>> {
    if (options?.beforeDispatch) {
      // 具名拒绝，绝不静默忽略：这个钩子的约定是「在推送之前跑完」，
      // 跨进程后它根本到不了属主侧。忽略它 = 调用方拿到成功回执、而那一步没发生。
      throw new InteractionError(
        'INTERACTION_INTERNAL_ERROR',
        'requestSync 的 beforeDispatch 钩子跨不了进程；'
          + '需要「推送前先做一件事」时请把那件事放进属主侧，或改用同进程实现。',
        500,
        false,
        { reason: 'interaction_before_dispatch_not_transportable' },
      );
    }
    return callInteraction(
      this.http, INTERACTION_SEND_ROUTES.requestSync, input, sendCallKind('requestSync'),
    );
  }

  requestAuthReopen(input: SendP<'requestAuthReopen'>[0]): Promise<SendR<'requestAuthReopen'>> {
    return callInteraction(
      this.http, INTERACTION_SEND_ROUTES.requestAuthReopen, input, sendCallKind('requestAuthReopen'),
    );
  }

  requestBrowserControl(
    input: SendP<'requestBrowserControl'>[0],
  ): Promise<SendR<'requestBrowserControl'>> {
    return callInteraction(
      this.http,
      INTERACTION_SEND_ROUTES.requestBrowserControl,
      input,
      sendCallKind('requestBrowserControl'),
    );
  }
}
