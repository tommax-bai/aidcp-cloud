/**
 * 配置副本停手闸的**纯判定段**（change split-cloud-automation-production-runtime，定稿 §4.7 2026-08-01 裁决）。
 *
 * ## 为什么析出到 kernel
 *
 * 与全局模型配置默认值那次同形：**拆进程之后出现了第二个读者**。
 * 自动化进程要判「配置副本陈旧了就停手」，而实现（ambient 槽位 + 镜像描述表 + 刷新器）
 * 都是 api 属主、且它够不着。两边各写一份的话会得到本仓反复点名的那种漂移——
 * 两侧各自编译通过、各自测试通过，只有在某一侧的 fail-safe 策略被改动、而另一侧没跟上时才现形，
 * 而现形的方式不是报错，是**该停手的时候没停**。
 *
 * ## 析出的边界：为什么不是整份搬过来
 *
 * 那两份 api 文件**留在 api 是对的**，不是妥协：新鲜度查询口有 7 个 api 属主消费方直接 import，
 * 整份挪走会当场造出 7 条跨域 import；停手判据依赖 api 属主的镜像描述表。
 * 而**挡住它们整份进 kernel 的东西也很具体**：前者有模块级可变单例（准入检查当场不过），
 * 后者依赖上述描述表。所以进来的只有「给定事实源与闸门键清单 → 四个方法」这一段，
 * 它零 IO、零定时器、零 SQL、零模块级可变状态。
 *
 * ## 两条 fail-safe 策略：都在这里，别在调用侧各写一遍
 *
 * 1. **没装事实源 → `fresh`。** 这不是「不知道就当新鲜」——没装事实源的情形下**根本不存在跨进程副本**：
 *    镜像与库在同一个进程、同一次写入路径上同步刷新，语义上就是权威本身。
 *    副本语义要等事实源装上之后才成立，陈旧度那时才有意义。
 * 2. **事实源抛错 → 按 `stale` 收敛。** 查询口在热路径上、契约是永不抛；而事实源异常时不敢断言新鲜，
 *    所以偏向停手那一侧。**MUST NOT 反过来兜成 `fresh`** —— 那会把「查不出来」洗成「没问题」。
 *
 * 记账（`noteStaleRefusal`）永不抛且失败即吞：**它是可观测性、不是判定**，
 * 记账挂了绝不能连累停手本身。
 *
 * ## 闸门键清单**按进程各自给**，刻意不做成共享常量
 *
 * 拆进程后各进程持有的镜像本来就是不同子集（单体里 15 处集中在一个进程，三等分后各自只有自己那部分）。
 * 「两边清单不一致」在这里不是漂移、是事实，所以它是入参而不是本模块的常量。
 * **参数档镜像 MUST NOT 混进来**：它们陈旧只告警、不停手。
 */
import type {
  ConfigMirrorFreshnessSource,
  ConfigMirrorGatePort,
  ConfigMirrorKey,
  MirrorReadState,
  PlatformActionHalt,
} from './config-mirror-bump-types.js';

export interface ConfigMirrorGateInputs {
  /**
   * 新鲜度事实源。`null` = 本进程没装（单进程形态，或秒级回滚开关关掉了刷新器）。
   * 取值时机是**每次调用**而不是构造期：调用方可以传一个现读闭包，让装卸载即时生效。
   */
  source: () => ConfigMirrorFreshnessSource | null;
  /** 本进程持有的**闸门档**镜像键。参数档不停手，MUST NOT 混进来。 */
  gateMirrorKeys: readonly ConfigMirrorKey[];
}

export interface ConfigMirrorGate extends ConfigMirrorGatePort {
  /** 某镜像此刻的副本状态。同步、零 IO、永不抛。 */
  stateOf(mirrorKey: ConfigMirrorKey): MirrorReadState;
  /** 当前处于陈旧态的闸门镜像。 */
  staleGateMirrors(): ConfigMirrorKey[];
}

/** 无状态工厂：所有可变态都在调用方注入的事实源里，本模块自己一个字节都不存。 */
export function createConfigMirrorGate(inputs: ConfigMirrorGateInputs): ConfigMirrorGate {
  const stateOf = (mirrorKey: ConfigMirrorKey): MirrorReadState => {
    const source = inputs.source();
    // 策略 1：没装事实源就不存在跨进程副本，语义上镜像就是权威本身。
    if (!source) return 'fresh';
    try {
      return source.stateOf(mirrorKey);
    } catch {
      // 策略 2：查不出来时不敢断言新鲜，按停手那一侧收敛。MUST NOT 兜成 fresh。
      return 'stale';
    }
  };

  const isStale = (mirrorKey: ConfigMirrorKey): boolean => stateOf(mirrorKey) === 'stale';

  const noteStaleRefusal = (mirrorKey: ConfigMirrorKey, context?: string): void => {
    const source = inputs.source();
    if (!source) return;
    try {
      source.noteStaleRefusal(mirrorKey, context);
    } catch {
      // 记账是可观测性、不是判定；它挂了绝不能连累停手本身。
    }
  };

  const staleGateMirrors = (): ConfigMirrorKey[] =>
    inputs.gateMirrorKeys.filter((key) => stateOf(key) === 'stale');

  return {
    stateOf,
    isStale,
    noteStaleRefusal,
    staleGateMirrors,
    /**
     * **纯判据、不记账**——供只读裁决路径用（如那条周期性快照链每跳都会问一次「现在能不能起会话」）。
     * 只读裁决什么都没拒绝，让它记一次「因陈旧拒绝真实平台动作」会污染指标。
     */
    hasStaleGateMirror: (): boolean => staleGateMirrors().length > 0,
    /**
     * 是否应停止放行**新的**真实平台动作。命中时**顺带记一次拒绝**——
     * 与设计内的克制（配额耗尽、模型判定不做、冷却未过）分别计数，绝不混计。
     * `context` 只进日志与记账，不参与判定。
     */
    platformActionHalt: (context?: string): PlatformActionHalt => {
      const mirrorKey = staleGateMirrors()[0];
      if (!mirrorKey) return { halted: false };
      noteStaleRefusal(mirrorKey, context);
      return { halted: true, mirrorKey };
    },
  };
}
