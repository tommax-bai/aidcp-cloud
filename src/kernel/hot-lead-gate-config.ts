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
