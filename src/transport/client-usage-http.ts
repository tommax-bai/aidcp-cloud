/**
 * 客户端「今日进展」那块用量载荷的跨进程取用。
 *
 * ## 为什么必须有它
 * 桌面客户端首页那一行（今日进展 / 当日上限 / 慢启动档位）由 `buildTodayUsageForAccount`
 * 装配，而它的每一项输入都是 automation 属主的：四个时间窗的风控计数、**内存里的活体会话**
 * 用量、配额档与释放时刻、平台能力投影。调用方（客户鉴权口）住在接口进程。
 * 单体时代同进程直调；拆开之后接口进程既没有那些表的连接、也看不见活体会话
 * ⇒ 该依赖在接口进程侧一直缺席，客户端上是「今日进展，暂时无法获取」
 * （2026-08-04 用户实测报障）。
 *
 * ## 粒度为什么是「装配好的整块」而不是四项原料
 * 把原料搬过来的话，接口进程还得自己做平台能力投影 —— 而那张平台能力注册表在
 * 控制仓 §4.7 已被终局裁定「不析出、整体维持 automation」，接口进程**永远拿不到它**。
 * 拿不到又硬要拼，唯一的写法是给投影传一个空值，而那**不报错**：它会回落成「保持现状」、
 * 把 collect 那一格留着，于是 Facebook 账号又看到「收藏 0/N」——
 * 正是 change `platform-honest-usage-metrics` 专门除掉的那个谎，且 typecheck 全绿。
 * **所以正确的粒度是让属主域算完了给。** 属主域侧零新增逻辑：那个装配器早就存在，
 * 这里只是给它多开一个调用面。
 *
 * ## 为什么这个文件对载荷形状「无知」（泛型而不是再抄一份类型）
 * 载荷类型住在协议文件里，而它已被终局裁定 **MUST NOT 进 kernel、MUST NOT 再提案**。
 * 传输层要拿到它就只能再抄第三份，而定稿 §10.9 明写**同步点数量 MUST NOT 增加**。
 * 于是这里把载荷做成类型参数：**传输层是一根管子，本来就不需要知道里面流的是什么**。
 * 两端各自用自己已有的、已被 §10.9 管着的那份声明去实例化，
 * 不新增第三个需要有人盯着的同步点。
 *
 * ## 失败语义原样穿过，MUST NOT 在这一层降级
 * 这条链在单体里的终点是 **503**，不是 0：装配器内部对「首帖段」「配额段」各自 catch
 * 成**字段缺席**（＝诚实的「未知」，客户端据此不渲染那一块），而四项风控计数与会话快照
 * **不 catch、直接抛**，最外层再 catch 成 null → 客户鉴权口回 503。
 * 本层**零 catch**：把跨进程失败降级成一块空载荷，等于让客户端把每个动作渲染成 0 ——
 * 那是一句错话，而且比 503 更难被发现（503 会有人报障，0 不会）。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

/**
 * 当日用量装配器的只读取用面。
 *
 * `TPayload` = 调用方自己那份载荷声明（见文件头）。
 * `edgeId` 缺省即「不带活体会话视角」——**这与「传了但那个边缘不在线」不是一回事**，
 * 后者由装配器在结果面表达（会话窗标记为未激活），别在调用侧把两者合并。
 */
export interface ClientUsageReader<TPayload> {
  todayUsageForAccount(accountId: string, edgeId?: string): Promise<TPayload>;
}

export const CLIENT_USAGE_ROUTES = {
  todayUsageForAccount: 'client-usage/today-usage-for-account',
} as const satisfies Record<keyof ClientUsageReader<unknown>, string>;

/** 在属主进程里把这一个只读方法挂上。**零 catch**（理由见文件头）。 */
export function registerClientUsageRoutes<TPayload>(
  server: InternalHttpServer,
  local: ClientUsageReader<TPayload>,
): void {
  server.register(CLIENT_USAGE_ROUTES.todayUsageForAccount, (args) => {
    const a = args as { accountId: string; edgeId?: string };
    return local.todayUsageForAccount(a.accountId, a.edgeId);
  });
}

/**
 * 端口的 HTTP 实现（跑在调用方进程里）。
 *
 * **逐方法显式转调**：绝不用对象展开去「继承」实现 —— 展开拿不到类实例原型上的方法，
 * 那种错编译得过、要真跑起来才现形。
 */
export class ClientUsageHttpClient<TPayload> implements ClientUsageReader<TPayload> {
  constructor(private readonly http: InternalHttpClient) {}

  todayUsageForAccount(accountId: string, edgeId?: string): Promise<TPayload> {
    // `edgeId` 为 undefined 时不放进 args：JSON 会丢掉 undefined 键，
    // 而属主侧读到的正是「这个键不存在」＝不带会话视角，与显式传 undefined 同义。
    return this.http.call<TPayload>(CLIENT_USAGE_ROUTES.todayUsageForAccount, {
      accountId,
      ...(edgeId === undefined ? {} : { edgeId }),
    });
  }
}
