/**
 * Pacing — 节奏时长计算（指令级节奏 Command Pacing）。
 *
 * 设计取舍（见 ai-dcp `openspec/changes/add-pacing-profile`）：
 * - 内容相关的「停留 / 思考」时长由**云端**在做决策时一并算出（云端已通过 `note.detail`
 *   拿到完整正文），随决策指令下发 `dwellMs` / `thinkMs`；§3 时间系数收口在此一处，不下发系数。
 * - 这里只产出**中心值**；最终的随机抖动由**边缘**叠加（防确定性指纹），见 edge 拟人化模块。
 *
 * 系数取自 `ai-dcp/docs/risk-control.md §3`：
 *   read_time = base + k_text·len + k_img·img，base=1.5s，k_text≈0.18s/100字，k_img≈0.8s/图，cap≈90s
 *   tempo：normal=1.0 / warned=1.3 / restricted=1.6（风控状态联动旋钮，状态越差越慢）
 *   fatigue：会话后段（>0.7）放大停顿（§3.4）
 */

import type { RiskStatus } from './types.js';

/** read_time 模型系数（§3.2）。 */
const READ = {
  baseMs: 1500,
  kTextMsPerChar: 1.8, // 0.18s / 100字
  kImgMs: 800,
  capMs: 90_000,
} as const;

/** 无价值「扫一眼」相对完整阅读的折扣：人扫标题/前几行就退，不会读全文。 */
const GLANCE_FACTOR = 0.35;

/** 动作前犹豫/感知时间的基准中心值（§3.1 操作间隔量级）。 */
const THINK_BASE_MS = 700;

/**
 * 详情页最小停留下限（兜底；边缘缺指令时也用同一量级）。
 * 取值偏向"打开一篇笔记后即便不感兴趣，人也会看 2.5–5s 才退"——1.2s 量级偏机械（见 6/16 实测）。
 */
export const DWELL_FLOOR_MS = { min: 2500, max: 5000 } as const;

/** 极薄会话默认块：仅供边缘自主动作与断连兜底，不含 read/pause/fatigue 系数。 */
export interface PacingDefaults {
  /** 全局节奏乘子（风控状态驱动） */
  tempo: number;
  /** 详情页最小停留下限区间 */
  dwellFloorMs: { min: number; max: number };
}

/** 风控状态 → 全局节奏乘子 tempo（状态越差越慢）。 */
export function tempoForStatus(status: RiskStatus): number {
  switch (status) {
    case 'normal':
      return 1.0;
    case 'warned':
      return 1.3;
    case 'restricted':
    case 'frozen':
      return 1.6;
    default:
      return 1.0;
  }
}

/**
 * 会话疲劳乘子（§3.4）：热身略慢、中段正常、后段放大停顿。
 * @param progress 会话进度 0..1（已用时长 / 时长上限）
 */
export function fatigueMultiplier(progress: number): number {
  const p = clamp01(progress);
  if (p < 0.15) return 1.2; // 热身
  if (p <= 0.7) return 1.0; // 自然
  return 1 + 0.6 * (p - 0.7); // 疲劳
}

export interface DwellInput {
  /** 正文字符数（来自已上报 note.detail.content.length） */
  textLen: number;
  /** 图片数（详情未上报时传 0） */
  imgCount?: number;
  /** 'read'=完整阅读路径；'glance'=无价值/返回路径，只扫一眼 */
  mode: 'read' | 'glance';
  status: RiskStatus;
  /** 会话进度 0..1 */
  progress: number;
}

/**
 * 计算详情页停留时长中心值 dwellMs（边缘据此保证页面实际停留达标，并叠加抖动）。
 * 始终 ≥ 感知下限 `DWELL_FLOOR_MS.min`（治「无价值秒退」）。
 */
export function computeDwellMs(input: DwellInput): number {
  const { textLen, imgCount = 0, mode, status, progress } = input;
  const raw = READ.baseMs + READ.kTextMsPerChar * Math.max(0, textLen) + READ.kImgMs * Math.max(0, imgCount);
  const scaled = mode === 'glance' ? raw * GLANCE_FACTOR : raw;
  const withTempo = scaled * tempoForStatus(status) * fatigueMultiplier(progress);
  return Math.round(clamp(withTempo, DWELL_FLOOR_MS.min, READ.capMs));
}

export interface ThinkInput {
  status: RiskStatus;
  /** 会话进度 0..1 */
  progress: number;
}

/** 计算动作前犹豫/感知时间中心值 thinkMs（边缘据此在执行前等待，并叠加抖动）。 */
export function computeThinkMs(input: ThinkInput): number {
  const withTempo = THINK_BASE_MS * tempoForStatus(input.status) * fatigueMultiplier(input.progress);
  return Math.round(withTempo);
}

/** 组装下发给 session.budget 的极薄默认块（仅兜底用）。 */
export function buildPacingDefaults(status: RiskStatus): PacingDefaults {
  return {
    tempo: tempoForStatus(status),
    dwellFloorMs: { ...DWELL_FLOOR_MS },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
