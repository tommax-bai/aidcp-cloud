/**
 * 引流线索过滤闸的旋钮形状 + 未配置时的回落值（kernel）。
 * 「什么算热帖」的判定留 automation。
 */

/** 过滤闸配置（默认为保守占位，真机看速率分布再经后台校准——见 change Open Questions）。 */
export interface HotLeadGateConfig {
  /** 帖龄上限（小时）：第一道闸，超龄/裸日期直接淘汰。默认 48（2 天）。 */
  maxAgeHours: number;
  /** 每小时点赞速率阈值：达此值算「涨得快」。默认 300。 */
  velocityMin: number;
  /** 最小绝对赞数：挡小基数假热（如 0.5h 20 赞）。默认 500。 */
  minLikeFloor: number;
  /** 速率分母下限（小时）：挡刚发布除零。默认 1。 */
  floorHours: number;
}

/** 保守占位默认值。段一真机看分布，段一/后台再校准（不是最终值）。 */
export const DEFAULT_HOT_LEAD_GATE_CONFIG: HotLeadGateConfig = {
  maxAgeHours: 48,
  velocityMin: 300,
  minLikeFloor: 500,
  floorHours: 1,
};

/** 全局覆盖行（三列各自可空；null = 未覆盖、回落写死默认）。`floorHours` 不进 UI、恒用代码默认。 */
export interface HotLeadConfigOverrides {
  readonly postAgeMaxHours: number | string | null | undefined;
  readonly velocityMin: number | string | null | undefined;
  readonly minLikeFloor: number | string | null | undefined;
}

/** 有效覆盖值：>= 1 的有限整数（0 / 负数 / 非整 / NaN 视作缺 → 回落写死默认）。 */
export function hotLeadOverrideValue(
  raw: number | string | null | undefined,
): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/**
 * 「覆盖行 → 生效闸配置」的**纯判定段**：逐项回落写死默认，永不抛。
 * 属主存储的现读口与同步读快照的发布口都调它——各写一份的现形方式不是报错，
 * 而是两个进程对同一张表算出不同的阈值，而两侧测试都会绿。
 */
export function resolveHotLeadGateConfig(
  overrides: HotLeadConfigOverrides | null | undefined,
): HotLeadGateConfig {
  return {
    maxAgeHours:
      hotLeadOverrideValue(overrides?.postAgeMaxHours) ??
      DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours,
    velocityMin:
      hotLeadOverrideValue(overrides?.velocityMin) ??
      DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin,
    minLikeFloor:
      hotLeadOverrideValue(overrides?.minLikeFloor) ??
      DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor,
    floorHours: DEFAULT_HOT_LEAD_GATE_CONFIG.floorHours,
  };
}
