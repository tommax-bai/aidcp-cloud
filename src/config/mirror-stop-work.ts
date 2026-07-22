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

/** 统一的具名停手原因码——运营与委托任务两侧共用，MUST NOT 与 `needs_persona_setup` 混用。 */
export const CONFIG_MIRROR_STALE_REASON = 'config_mirror_stale';

/** 人设专用的具名不可用态——与「未绑」严格可区分。 */
export const PERSONA_UNAVAILABLE_REASON = 'persona_unavailable';
