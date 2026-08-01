/**
 * 副本陈旧（`unknown`）时传输层出口闸仍必须放行的信封类型（change split-cloud-automation-production-runtime，批 D）。
 *
 * ## 为什么这一段要单写一份
 *
 * 出口闸原本只在「环境正处于删除生命周期」这个**确定态**返 false，那时拦死一切是对的。
 * 三态化之后 `unknown` 是一个**全车队同时触发的瞬时基础设施态**（一次配置副本版本轮询中断），
 * 若沿用同一处理，长连接出口会连**控制面与收尾**一起扣住：
 * 浏览器租约释放发不出去（槽位永不归还）、界面快照断供、验证码协助拿不到帧；
 * 而调用方看到的只是「投递 0 个」，被归因成边缘离线 —— 边缘明明在线。
 *
 * 那既超出停手的自定边界（停手 = 不放行**新的真实平台动作**，MUST NOT kill 在跑的会话），
 * 也直接让「在跑会话自然收敛」落空 —— 收尾动作正是被扣住的那一类。
 *
 * **拆进程后两个进程都要问同一个问题**（接口进程的出口闸、自动化进程的边-云出口闸），
 * 所以判定单写在这里。两边各写一份的现形方式不是报错，是**某一侧悄悄多扣住了一类信封**。
 *
 * ## 名单是「不放行会造成死锁」的那几类，不是「重要的那几类」
 *
 * 判据很窄：扣住它会让一个**本可自愈的阻塞变成死锁**，或让在跑会话无法自然收敛。
 * 新增成员 MUST 按这条判据说明理由，MUST NOT 因为「这个也挺重要」就加进来 ——
 * 名单越长，停手闸能停住的东西越少。
 */

/**
 * 显式豁免名单。
 *
 * **刻意不用模块级 `new Set`**：kernel 准入判据禁止模块级可变单例，而
 * `const X: ReadonlySet<string> = new Set([...])` 的类型标注救不了它（准入正则认的是写法）。
 * 名单只有几条，逐项比对的代价可以忽略。
 */
export const TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN = [
  // 浏览器槽位的取得与**归还**：归还被扣住 = 槽位永不释放；两者成对放行才不会一头堵一头通。
  'edge.task.acquire',
  'edge.task.release',
  // 验证码协助：人在远端替账号解封的通道，扣住它等于把一个可自愈的阻塞做成死锁。
  'captcha.assist.capture',
  'captcha.assist.click',
  // 详情页收尾：离开笔记 / 退回上一页，属自然结束路径，不是新的平台动作。
  'note.close',
  'navigation.back',
] as const;

/**
 * 传输层控制类别。`automation_control`（快照 / 节奏 / ack / 心跳）与
 * `browser_lifecycle`（浏览器生命周期）两类本身不产生平台动作，照常放行。
 */
export type TransportControlCategory =
  | 'automation_control'
  | 'platform_api_automation'
  | 'browser_lifecycle'
  | 'page_automation';

/**
 * 副本 `unknown` 时是否放行该信封。
 *
 * `controlCategory` 由调用方从各自进程的传输层操作登记表取好传进来 —— 登记表是各进程自己的东西，
 * 本模块 MUST NOT 反向依赖它。
 */
export function allowsTransportWhenGateUnknown(
  type: string,
  controlCategory: TransportControlCategory | null,
): boolean {
  if ((TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN as readonly string[]).includes(type)) return true;
  return controlCategory === 'automation_control' || controlCategory === 'browser_lifecycle';
}
