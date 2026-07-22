/**
 * 闸门镜像陈旧时的**统一停手判据**（change config-mirror-cross-process-invalidation，task 4.8）。
 *
 * ## 停手到底是什么
 *
 * 停手 = **不放行新的真实平台动作**：新会话不启动、命令泵不下发新的互动 / 发布 / 评论命令。
 *
 * 停手**不是**：
 * - 不是 kill 在跑的会话——已在进行的会话沿既有自然结束路径诚实收敛，MUST NOT 就地终止；
 * - 不是「回落到最保守档位继续跑」——最保守档仍然是**放行**真实平台动作，且会把一次基础设施故障
 *   静默转成全车队降速，运营看到的是「系统在跑、只是慢」，属最难发现的一类故障。
 *
 * ## 为什么可以按「任一闸门镜像陈旧就整体停手」实现
 *
 * 全部镜像共用同一个刷新器、同一轮整表版本比对：一次比对失败，所有镜像的 `lastComparedAt` 同时不
 * 推进，因而所有闸门镜像同时转陈旧。分镜像做细粒度停手不会产生任何可观测差异，只会多出一层可以
 * 写错的判断。这里保留「是哪个 mirrorKey 先陈旧」用于告警与记账，判据本身取全集。
 */

import {
  mirrorStateOf,
  noteMirrorStaleRefusal,
  type ConfigMirrorKey,
} from '../config-mirror-freshness.js';
import { CONFIG_MIRRORS, CONFIG_MIRROR_KEYS } from './mirror-registry.js';

/** 当前处于陈旧态的闸门镜像（参数镜像永不入列——它们陈旧只告警、不停手）。 */
export function staleGateMirrors(): ConfigMirrorKey[] {
  return CONFIG_MIRROR_KEYS.filter(
    (key) => CONFIG_MIRRORS[key].tier === 'gate' && mirrorStateOf(key) === 'stale',
  );
}

/** 停手判据的结果。`halted:true` 时带上触发的 mirrorKey，供日志、告警与拒绝记账用。 */
export type PlatformActionHalt =
  | { halted: false }
  | { halted: true; mirrorKey: ConfigMirrorKey };

/**
 * 是否应停止放行**新的**真实平台动作。
 *
 * `context` 只进日志与记账（如 accountId / 命令名），不参与判定。
 * 命中时会记一次「因镜像陈旧而拒绝」——该计数与设计内克制（配额耗尽、模型判定不做、冷却未过）
 * **分别计数**，绝不混计。
 */
export function platformActionHalt(context?: string): PlatformActionHalt {
  const stale = staleGateMirrors();
  const mirrorKey = stale[0];
  if (!mirrorKey) return { halted: false };
  noteMirrorStaleRefusal(mirrorKey, context);
  return { halted: true, mirrorKey };
}

/** 便捷判据（不需要知道是哪个镜像时用）。 */
export function shouldHaltNewPlatformActions(context?: string): boolean {
  return platformActionHalt(context).halted;
}

/**
 * **纯判据，不记账**——供只读裁决路径使用（如 `ui.snapshot` 那条 ~60s 周期链每跳都会问一次
 * 「现在能不能起会话」）。只读裁决什么都没拒绝，让它记一次「因陈旧拒绝真实平台动作」会污染指标。
 * 真正拒绝的那一跳（会话启动闸、命令泵）自己调 `platformActionHalt` / `noteMirrorStaleRefusal`。
 */
export function hasStaleGateMirror(): boolean {
  return staleGateMirrors().length > 0;
}

/** 统一的具名停手原因码——运营与委托任务两侧共用，MUST NOT 与 `needs_persona_setup` 混用。 */
export const CONFIG_MIRROR_STALE_REASON = 'config_mirror_stale';

/** 人设专用的具名不可用态——与「未绑」严格可区分。 */
export const PERSONA_UNAVAILABLE_REASON = 'persona_unavailable';

/**
 * 传输层出口闸在**副本陈旧（`unknown`）**时仍必须放行的信封类型（显式名单）。
 *
 * 出口闸原本只在「环境正处于删除生命周期」这一**确定态**返 false，那时拦死一切是对的。三态化后
 * `unknown` 是一个**全车队同时触发的瞬时基础设施态**（一次 60s 的版本轮询中断），若沿用同一处理，
 * WebSocket 出口会连**控制面与收尾**一起扣住：浏览器租约释放发不出去（槽位不归还）、UI 快照断供、
 * 验证码协助拿不到帧；而调用方看到的只是「投递 0 个」，被归因成边缘离线——边缘明明在线。
 *
 * 那既超出本 change 自定的停手边界（停手 = 不放行**新的真实平台动作**，MUST NOT kill 在跑的会话），
 * 也直接让「在跑会话自然收敛」落空——收尾动作正是被扣住的那一类。故 `unknown` 只拦新的平台动作，
 * 控制/收尾类照常放行；真正的停手仍由上层闸（会话启动闸、命令泵）在入口收敛。
 */
const TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN: ReadonlySet<string> = new Set([
  // 浏览器槽位的取得与**归还**：归还被扣住 = 槽位永不释放；两者成对放行才不会一头堵一头通。
  'edge.task.acquire',
  'edge.task.release',
  // 验证码协助：人在远端替账号解封的通道，扣住它等于把一个可自愈的阻塞做成死锁。
  'captcha.assist.capture',
  'captcha.assist.click',
  // 详情页收尾：离开笔记 / 退回上一页，属自然结束路径，不是新的平台动作。
  'note.close',
  'navigation.back',
]);

/**
 * 传输层出口闸在 `unknown` 时是否放行该信封。
 *
 * `controlCategory` 由调用方从传输层的操作登记表取好传进来——操作登记表在 `src/comm/`，
 * 配置层 MUST NOT 反向依赖它。`automation_control`（快照 / 节奏 / ack / 心跳）与
 * `browser_lifecycle`（浏览器生命周期）两类本身不产生平台动作，照常放行。
 */
export function allowsTransportWhenGateUnknown(
  type: string,
  controlCategory:
    | 'automation_control'
    | 'platform_api_automation'
    | 'browser_lifecycle'
    | 'page_automation'
    | null,
): boolean {
  if (TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN.has(type)) return true;
  return controlCategory === 'automation_control' || controlCategory === 'browser_lifecycle';
}
