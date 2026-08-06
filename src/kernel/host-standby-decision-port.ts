/**
 * 宿主层让位判决遥测的**只读**投影端口（kernel 段，change report-host-standby-decisions）。
 *
 * 背景：浏览器槽位调度权在宿主层（桌面外壳）——槽位不跨机器、环境绑死本机分身。宿主层持有这份
 * 决策权的**对价**是必须向上可见：2026-08-05 的真机故障形状正是「一台机器上某个环境连续 32 分钟
 * 拒绝让位、锁死一个浏览器槽位」，而运营在另一处零证据。补上的本地留痕只在有人坐在那台机器前时
 * 有用，而车队是跨机器的。
 *
 * **可见性不是审批权**：本端口 SHALL 只被读、只被呈现。它 MUST NOT 出现在任何下发决策路径上
 * （待机提示产出、命令下发、风控裁决）。若云端据此反向干预，两层就会各出一个决策，回到本要求
 * 想修的那类漂移。
 *
 * 归属：事实由 automation 段（边-云网关）收下并持有；api 段的面板经本端口取当前态。
 * 面板绝不知道 automation 侧用什么结构存。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无实现类 / 无模块级活状态 / 无定时器。
 * 时间戳一律 epoch ms（跨进程友好，Date 不过网）。
 */

/** 宿主层就「让不让出浏览器槽位」作出的判决结果。 */
export type HostStandbyVerdict = 'yielded' | 'refused';

/**
 * 某条边缘连接最近一次让位判决的当前态。
 *
 * 本 change 只做「当前态可读」，不做历史留档 / 报表：每条边缘只保留最近一条记录。
 * 连续拒绝的**时长**由 `refusedSince` 表达，**次数**由 `refusedCount` 表达——两者都来自宿主层的
 * 同一份连续拒绝记账，云端不重算（重算等于凭第二套口径判同一件事）。
 */
export interface HostStandbyDecisionRecord {
  /** 作出判决的边缘节点。 */
  edgeId: string;
  /** 该连接绑定的账号；握手未带则为 null（不猜、不回落默认账号）。 */
  accountId: string | null;
  /** 人类可读的机器标签（握手 `machineLabel`）；缺省 null。运营据此知道「是哪台机器」。 */
  machineLabel: string | null;
  /** 宿主层对该环境的本地标识；缺省 null。 */
  envId: string | null;
  /** 让位 / 拒绝。 */
  verdict: HostStandbyVerdict;
  /** 具名原因：拒绝时为宿主层的具名拒绝原因；让位时恒 `ok`。 */
  reason: string;
  /** 连续拒绝次数（同因累加、换因复位）；让位时为 0。 */
  refusedCount: number;
  /** 本段连续拒绝的首次时刻（epoch ms）；无连续拒绝时 null。 */
  refusedSince: number | null;
  /** 该判决所针对的那条待机提示的标识（提示的 `generatedAt`，epoch ms）。 */
  hintGeneratedAt: number;
  /** 宿主层作出判决的时刻（epoch ms，边缘时钟）。 */
  decidedAt: number;
  /** 云端收下这条回执的时刻（epoch ms，云端时钟）。判「这条记录有多陈旧」用它，别用边缘时钟。 */
  receivedAt: number;
}

/**
 * 面板方向的只读读端口。**只读、无副作用、异步**（对齐跨进程传输）。
 *
 * 返回空数组的唯一含义是「当前没有任何边缘上报过判决」——它 MUST NOT 被用来冒充
 * 「读不到 automation 段」：传输失败一律原样抛，绝不回空数组假装天下太平。
 */
export interface HostStandbyDecisionReader {
  listHostStandbyDecisions(): Promise<HostStandbyDecisionRecord[]>;
}
