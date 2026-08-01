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
  configMirrorFreshnessSource,
  type ConfigMirrorKey,
} from '../config-mirror-freshness.js';
import { createConfigMirrorGate } from '../kernel/config-mirror-gate.js';
import { CONFIG_MIRRORS, CONFIG_MIRROR_KEYS } from './mirror-registry.js';

/**
 * 本进程的闸门档镜像键（参数档永不入列——它们陈旧只告警、不停手）。
 * 单体里 = 描述表里全部 gate 档；三等分后各进程只有自己那部分，故它是 kernel 工厂的**入参**。
 */
const GATE_MIRROR_KEYS: readonly ConfigMirrorKey[] = CONFIG_MIRROR_KEYS.filter(
  (key) => CONFIG_MIRRORS[key].tier === 'gate',
);

/**
 * 停手判定单写在 kernel 的无状态工厂里（定稿 §4.7 2026-08-01 裁决）：拆进程后自动化进程要判同一件事，
 * 而它够不着本文件（api 属主，且依赖 api 属主的镜像描述表）。本文件保留的是**属主那一部分**——
 * 哪些键属于闸门档，那是描述表说了算。
 */
const gate = createConfigMirrorGate({
  source: configMirrorFreshnessSource,
  gateMirrorKeys: GATE_MIRROR_KEYS,
});

/** 当前处于陈旧态的闸门镜像（参数镜像永不入列——它们陈旧只告警、不停手）。 */
export function staleGateMirrors(): ConfigMirrorKey[] {
  return gate.staleGateMirrors();
}

/**
 * 停手判据的结果。形状单写在 kernel（change cloud-coupling-phase4-runtime-ports），此处等值再导出。
 * `halted:true` 时带上触发的 mirrorKey，供日志、告警与拒绝记账用。
 */
export type { PlatformActionHalt } from '../kernel/config-mirror-bump-types.js';
import type { PlatformActionHalt } from '../kernel/config-mirror-bump-types.js';

/**
 * 是否应停止放行**新的**真实平台动作。
 *
 * `context` 只进日志与记账（如 accountId / 命令名），不参与判定。
 * 命中时会记一次「因镜像陈旧而拒绝」——该计数与设计内克制（配额耗尽、模型判定不做、冷却未过）
 * **分别计数**，绝不混计。
 */
export function platformActionHalt(context?: string): PlatformActionHalt {
  return gate.platformActionHalt(context);
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
  return gate.hasStaleGateMirror();
}


/**
 * 传输层出口闸在**副本陈旧（`unknown`）**时仍必须放行的信封类型。
 *
 * **判定单写在 kernel**（change split-cloud-automation-production-runtime 批 D）：
 * 拆进程后两个进程都要问同一个问题（接口进程的出口闸、自动化进程的边-云出口闸），
 * 两边各写一份的现形方式不是报错，是**某一侧悄悄多扣住了一类信封**。
 * 本文件等值再导出，既有调用点一行不改。
 */
export {
  allowsTransportWhenGateUnknown,
  TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN,
} from '../kernel/transport-gate-exemptions.js';
