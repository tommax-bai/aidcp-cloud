/**
 * 跨进程配置镜像的「新鲜度」查询口（change config-mirror-cross-process-invalidation）。
 *
 * ## 为什么这个模块在 `src/` 根、而不在 `src/config/`
 *
 * 闸门取值口分布在 `src/risk/`、`src/comm/`、`src/orchestrator/` 等多个域，其中 `src/risk/` 对
 * `src/config/` 的运行时依赖今天恰好为 0（依据见 `src/config/mirror-registry.ts` 头注与
 * change 的 task 1.3 静态断言）。把 key 闭集合与新鲜度查询口放进 `src/config/`，会让风控层为了
 * 判「副本是否陈旧」而第一次 import 配置层，当场推翻那条已被定稿方案（§11.4 要求一）当作
 * 归属判据的既成事实。故：**闭集合的 key 类型与查询口在本模块（中立、无依赖）**，
 * 描述符表在 `src/config/mirror-registry.ts`（`Record<ConfigMirrorKey, …>` 穷举）。
 *
 * ## 「未安装 = fresh」是有意的，不是把未知压成否
 *
 * 刷新器未安装（单进程、或 `AIDCP_CONFIG_MIRROR_REFRESH=false` 秒级回滚）时本模块返回 `fresh`。
 * 这不是「不知道就当新鲜」——那种情形下**根本不存在跨进程副本**：镜像与库在同一个进程、同一次
 * 写入路径上同步刷新，语义上就是权威本身（今天的现状）。一旦安装了刷新器，副本语义才成立，
 * 陈旧度才有意义。回滚开关关掉刷新器时行为逐位退回今日现状，正是 design 的 Migration Plan 所要求的。
 */

/**
 * 全部进程内配置镜像的闭集合（15 处，实测清单见 `src/config/mirror-registry.ts`）。
 *
 * 新增一处镜像 MUST 在此登记：`CONFIG_MIRRORS` 是 `Record<ConfigMirrorKey, …>`，
 * 漏登记即 typecheck 失败（与两份 protocol.ts 的 `Record<MessageType,true>` 同款防漂移手法）。
 *
 * 定义位置随 change block3-l3-config-mirror-bump-decouple 抬进 `src/kernel/config-mirror-bump-types.ts`：
 * automation 与 api 两侧的配置写入方都要引用它，留在任一属主域都会造出一条跨域 import。
 * 本模块等值再导出，既有 import 路径全部保持不变。
 */
export type { ConfigMirrorKey } from './kernel/config-mirror-bump-types.js';
import type { ConfigMirrorKey } from './kernel/config-mirror-bump-types.js';

/**
 * 副本读取状态与新鲜度事实源的**形状**单写在 kernel（change cloud-coupling-phase4-runtime-ports），
 * 此处等值再导出；ambient 槽位与全部实现仍留本文件（api 属主）。
 */
export type { MirrorReadState, ConfigMirrorFreshnessSource } from './kernel/config-mirror-bump-types.js';
import type { MirrorReadState, ConfigMirrorFreshnessSource } from './kernel/config-mirror-bump-types.js';

import { createConfigMirrorGate } from './kernel/config-mirror-gate.js';

let installedSource: ConfigMirrorFreshnessSource | null = null;

/**
 * 两条 fail-safe 策略（未安装 → fresh、事实源抛错 → 按 stale 收敛）**单写在 kernel 的无状态工厂里**
 * （定稿 §4.7 2026-08-01 裁决）。理由是拆进程后出现了第二个读者：自动化进程要判同一件事，
 * 而它够不着本文件（api 属主）。两边各写一份的现形方式不是报错，是**该停手的时候没停**。
 *
 * 本文件保留的正是**不能进 kernel 的那一部分**：上面那个模块级可变槽位。
 * `source` 传闭包而非取值：装卸载（含秒级回滚）即时生效，与改造前逐位一致。
 * 闸门键清单在本口用不到（本文件只做单键查询），故传空——`staleGateMirrors` 那一族在
 * `src/config/mirror-stop-work.ts` 侧按镜像描述表给。
 */
const singleKeyGate = createConfigMirrorGate({
  source: () => installedSource,
  gateMirrorKeys: [],
});

/** 装配期安装事实源（传 null 卸载，供单测与秒级回滚）。 */
export function installConfigMirrorFreshnessSource(source: ConfigMirrorFreshnessSource | null): void {
  installedSource = source;
}

/**
 * 取当前事实源（未安装 → `null`）。**只供构造停手闸用**：
 * MUST NOT 拿它直接做判定 —— 那会绕开 kernel 工厂里那两条 fail-safe 策略
 * （未安装 → fresh、事实源抛错 → 按 stale 收敛），而绕开的后果不是报错，是判错。
 */
export function configMirrorFreshnessSource(): ConfigMirrorFreshnessSource | null {
  return installedSource;
}

/** 当前是否已安装事实源（= 是否已按跨进程副本语义运行）。 */
export function isConfigMirrorFreshnessInstalled(): boolean {
  return installedSource !== null;
}

/** 同步、零 IO、永不抛：某镜像此刻的副本状态。未安装事实源 → `fresh`（见头注）。 */
export function mirrorStateOf(mirrorKey: ConfigMirrorKey): MirrorReadState {
  return singleKeyGate.stateOf(mirrorKey);
}

/** 便捷判据。热路径大量调用，保持同步零 IO。 */
export function isMirrorStale(mirrorKey: ConfigMirrorKey): boolean {
  return singleKeyGate.isStale(mirrorKey);
}

/** 记一次「因镜像陈旧而拒绝」。永不抛——记账失败绝不能连累停手本身。 */
export function noteMirrorStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void {
  singleKeyGate.noteStaleRefusal(mirrorKey, context);
}
