/**
 * 管理后台要用、事实源在自动化进程的两族窄口（change restore-panel-capability-wiring）。
 *
 *   - **验证码人工协助**：后台「验证码协助」页的全部五个端点。现场快照、scoped-token 的
 *     秘密、edge 实时循环都在自动化进程的边缘接入层。
 *   - **授权前置校验**：授权发布前的那道前置，判定要读边缘在场与下发在途。
 *
 * 三条纪律：
 *
 * ① **图像字节 MUST NOT 落日志**。跨进程之后这条约束在**两侧都要成立**——属主侧不打、
 *    传输层不打、调用侧也不打。本文件不做任何 payload 级日志，出错只报路由名与错误消息。
 *
 * ② **验证码答案明文同样 SENSITIVE**：只透传给属主装进下行信封，MUST NOT 落日志 / 库 /
 *    incident / URL。它经本通道时只是 `submitClick` 入参里的一个字段，不单独记录。
 *
 * ③ **「没问到对面」MUST NOT 被压成业务答案**。本文件的客户端一律**原样抛**，绝不把
 *    传输失败翻译成 `{ ok:false, reason:'not_found' }` 之类——那会让运营看到「这个事件
 *    不存在」，而真相是自动化进程没答话。面板层对抛出的处理是 5xx，与业务拒绝的 4xx 天然可分。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

/**
 * **载荷类型在本文件里是泛型参数，不是 import**。
 *
 * 具体形状（现场快照 / 令牌校验结果 / 下发回执）声明在接口仓的面板契约里，而本文件属
 * 传输层、要同时被自动化仓编译——跨属主 import 在这里根本解析不了。**也不重抄一份**：
 * 抄一份就是第二份实现，两侧各自编译通过、只有真跑起来才发现字段对不上。
 *
 * 做法是传输层对载荷保持无知（它本来就只是 JSON 直传），两端各自钉自己的真类型：
 *   - 属主侧：注册时传进来的实例本身就是那些类型的实现；
 *   - 调用侧：用真类型实例化本文件的泛型客户端，再赋给面板依赖字段 —— 形状一旦漂移，
 *     那个赋值就当场编译红。
 */
export interface CaptchaAssistWirePayloads {
  verify: unknown;
  incident: unknown;
  dispatch: unknown;
  submitInput: object;
}

export const PANEL_AUTOMATION_EXTRA_ROUTES = {
  captchaVerifyToken: 'panel-captcha/verify-token',
  captchaGetIncident: 'panel-captcha/get-incident',
  captchaNoteViewerPresence: 'panel-captcha/note-viewer-presence',
  captchaRequestCapture: 'panel-captcha/request-capture',
  captchaSubmitClick: 'panel-captcha/submit-click',
  preflightApprovePublish: 'panel-publish/preflight-approve',
} as const;

/** 属主侧要提供的方法面（载荷一律 `unknown`：属主传进来的实例带着自己的真类型，天然满足）。 */
export interface CaptchaAssistOwnerPort {
  verifyToken(token: string | undefined): unknown;
  getIncident(incidentId: string): unknown;
  noteViewerPresence(incidentId: string): void | Promise<void>;
  requestCapture(
    incidentId: string,
    actor: string,
    reason?: 'initial' | 'refresh' | 'retry',
  ): Promise<unknown>;
  submitClick(input: never): Promise<unknown>;
}

export interface PanelAutomationExtraOwnerPorts {
  /** 属主侧的验证码协助实例；不可用时**不注册**这一族（面板逐路由 503，与「事件不存在」可分）。 */
  captchaAssist?: CaptchaAssistOwnerPort;
  preflightApprovePublish?: (requestId: string) => Promise<unknown>;
}

export function registerPanelAutomationExtraRoutes(
  server: InternalHttpServer,
  local: PanelAutomationExtraOwnerPorts,
): void {
  const captcha = local.captchaAssist;
  if (captcha) {
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.captchaVerifyToken, (args) =>
      Promise.resolve(captcha.verifyToken((args as { token?: string }).token)),
    );
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.captchaGetIncident, (args) =>
      Promise.resolve(captcha.getIncident((args as { incidentId: string }).incidentId)),
    );
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.captchaNoteViewerPresence, async (args) => {
      await captcha.noteViewerPresence((args as { incidentId: string }).incidentId);
      // 返回一个空对象而不是 undefined：线格式要有个可解析的体，
      // 「回了空体」与「连接断了」在调用侧必须能分开。
      return {};
    });
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.captchaRequestCapture, (args) => {
      const a = args as { incidentId: string; actor: string; reason?: 'initial' | 'refresh' | 'retry' };
      return captcha.requestCapture(a.incidentId, a.actor, a.reason);
    });
    // 入参**原样透传**给属主：形状由属主那一侧的真类型把关，传输层不复述它
    //（复述就是第二份声明）。验证码答案明文与轨迹都在这个对象里，本层不拆、不记。
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.captchaSubmitClick, (args) =>
      captcha.submitClick(args as never),
    );
  }

  const preflight = local.preflightApprovePublish;
  if (preflight) {
    server.register(PANEL_AUTOMATION_EXTRA_ROUTES.preflightApprovePublish, (args) =>
      preflight((args as { requestId: string }).requestId),
    );
  }
}

/**
 * 调用侧。**不吞任何传输失败**：所有方法直接把 `http.call` 的 promise 交出去，
 * 失败即 reject，由面板层落成 5xx。这与探活那条口刻意不同——那里「没能探活」是一个
 * 有意义的业务三态（拒写但别改模型名），这里没有对应的三态，编一个只会更糟。
 */
export class PanelCaptchaAssistHttpClient<S extends CaptchaAssistWirePayloads> {
  constructor(private readonly http: InternalHttpClient) {}

  verifyToken(token: string | undefined): Promise<S['verify']> {
    return this.http.call<S['verify']>(PANEL_AUTOMATION_EXTRA_ROUTES.captchaVerifyToken, { token });
  }

  getIncident(incidentId: string): Promise<S['incident']> {
    return this.http.call<S['incident']>(PANEL_AUTOMATION_EXTRA_ROUTES.captchaGetIncident, {
      incidentId,
    });
  }

  async noteViewerPresence(incidentId: string): Promise<void> {
    await this.http.call<Record<string, never>>(
      PANEL_AUTOMATION_EXTRA_ROUTES.captchaNoteViewerPresence,
      { incidentId },
    );
  }

  requestCapture(
    incidentId: string,
    actor: string,
    reason?: 'initial' | 'refresh' | 'retry',
  ): Promise<S['dispatch']> {
    return this.http.call<S['dispatch']>(PANEL_AUTOMATION_EXTRA_ROUTES.captchaRequestCapture, {
      incidentId,
      actor,
      reason,
    });
  }

  submitClick(input: S['submitInput']): Promise<S['dispatch']> {
    return this.http.call<S['dispatch']>(PANEL_AUTOMATION_EXTRA_ROUTES.captchaSubmitClick, input);
  }
}

export class PanelPublishPreflightHttpClient<TResult> {
  constructor(private readonly http: InternalHttpClient) {}

  preflight(requestId: string): Promise<TResult> {
    return this.http.call<TResult>(PANEL_AUTOMATION_EXTRA_ROUTES.preflightApprovePublish, {
      requestId,
    });
  }
}
