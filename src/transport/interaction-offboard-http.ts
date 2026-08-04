/**
 * 客户提交离场之后的**即时派发**的跨进程触发。
 *
 * ## 为什么必须有它
 * 客户在桌面客户端提交离场，受理与台账在接口进程；而真正要发生的事是
 * **往那个账号此刻所在的边缘推一条离场指令**，那需要边缘连接注册表与推送出口，
 * 两者都只存在于自动化进程。单体时代同进程直调；拆开之后接口进程没有任何办法推，
 * 于是这条回调在接口侧一直缺席 —— 后果不是报错，是**离场指令只能等边缘下次重连时**
 * 由握手侧的对账顺带投出去。
 *
 * ## 为什么参数里没有 edgeId
 * 单体那处是「调用方解析 edgeId → 传给派发」。跨进程后照搬会让**推送目标取自调用方的
 * 在场镜像**，而镜像会陈旧 —— 拿一个过期的目标去推一条真指令，是把「推给谁」
 * 建立在过期事实上。所以这条路由只收 accountId，**目标由属主进程就地解析**。
 *
 * ## 失败语义
 * - 边缘不在线 ⇒ 回 `0`。**这是一个事实**（客户端据此知道「已受理、待边缘上线」）。
 * - 派发本身失败 ⇒ **抛**，原样穿过传输层。MUST NOT 吞成 0——那会让「推失败了」
 *   与「没人可推」同形，而前者需要有人处置。
 *
 * ## 重复调用是安全的，但**不是因为这一层做了什么**
 * 幂等来自属主侧：派发成功才落 dispatched 标记，重来只会重推**仍然待办**的那些。
 * **本层 MUST NOT 加任何重试**：推送是对外动作，一条已经上墙的离场指令
 * 不该因为调用方没收到回执而被再推一次。调用方也按 fire-and-forget 用它。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

/** 离场指令的即时派发口（属主域实现，接口域调用）。 */
export interface InteractionOffboardDispatcher {
  /** 推该账号名下待办的离场指令，返回真正推出去的条数；边缘不在线回 0。 */
  dispatchPendingOffboards(accountId: string): Promise<number>;
}

export const INTERACTION_OFFBOARD_ROUTES = {
  dispatchPendingOffboards: 'interaction-offboard/dispatch-pending',
} as const satisfies Record<keyof InteractionOffboardDispatcher, string>;

/** 在属主进程里把这一个方法挂上。**零 catch**（理由见文件头）。 */
export function registerInteractionOffboardRoutes(
  server: InternalHttpServer,
  local: InteractionOffboardDispatcher,
): void {
  server.register(INTERACTION_OFFBOARD_ROUTES.dispatchPendingOffboards, (args) => {
    const a = args as { accountId: string };
    return local.dispatchPendingOffboards(a.accountId);
  });
}

/**
 * 端口的 HTTP 实现（跑在调用方进程里）。
 *
 * **逐方法显式转调**：绝不用对象展开去「继承」实现 —— 展开拿不到类实例原型上的方法，
 * 那种错编译得过、要真跑起来才现形。
 */
export class InteractionOffboardHttpClient implements InteractionOffboardDispatcher {
  constructor(private readonly http: InternalHttpClient) {}

  dispatchPendingOffboards(accountId: string): Promise<number> {
    return this.http.call<number>(INTERACTION_OFFBOARD_ROUTES.dispatchPendingOffboards, {
      accountId,
    });
  }
}
