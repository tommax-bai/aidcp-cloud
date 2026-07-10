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
import type { PacingOp, PacingFloorPayload, PacingSnapshotPayload } from '../comm/protocol.js';

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

/** 熟悉内容（近期已评估）的思考时间折扣：人对刚看过的内容反应更快，思考时间降至约 1/3。 */
const FAMILIAR_DISCOUNT = 1 / 3;

/** 思考时间下限：折扣后也不退化为零延迟（杜绝秒退指纹）。 */
const THINK_FLOOR_MS = 150;

/**
 * 详情页最小停留下限（兜底；边缘缺指令时也用同一量级）。
 * 取值偏向"打开一篇笔记后即便不感兴趣，人也会看 2.5–5s 才退"——1.2s 量级偏机械（见 6/16 实测）。
 */
export const DWELL_FLOOR_MS = { min: 2500, max: 5000 } as const;

// ── 操作兜底 floor 配置（change pacing-floor-config-min-interval）─────────────────
//
// 语义：不是"操作后无条件附加固定等待"，而是"两次操作间的最小间隔下限"。数值全局后台可配、
// 存 PG（pacing_floor_config），经 welcome 握手下发（PacingSnapshotPayload），边缘热加载。
// 本模块只持写死默认 + 防呆下限 + 类别上限 + 权威 clamp + 快照组装；落库/内存镜像由
// src/config/pacing-config-store.ts 实现 PacingFloorProvider。

/**
 * 全局操作兜底 floor 上限（毫秒）。看门狗 lockstep 不变量：结构上 MUST ≪ 空闲看门狗轻推下限
 * `IDLE_NUDGE_MIN_MS(200_000)`——前台 gate op 有效兜底恒 ≤ 15s，阅读停留类恒低于看门狗轻推下限。
 * 这是代码常量而非配置，配再大也被夹到类别上限；由 resume-limits 不变量测试断言该常量关系（tripwire）。
 */
export const CAP_MS = 15_000;

/** 各类 pacing 操作的稳定枚举（与协议 PacingOp 逐字对齐；遍历/白名单用）。 */
export const PACING_OPS: readonly PacingOp[] = [
  'action',
  'scroll',
  'card_gap',
  'detail_dwell',
  'feed_card_read',
  'content_glance',
  'content_read',
] as const;

/**
 * 每类操作的非零防呆下限（毫秒，= 读出口 clamp 下界）。
 * 不变量：配置只能抬高延迟、永远抬不穿这个非零下限——即便有人绕过面板 psql 直插 0/负数，
 * 离开云端进程前经 floorFor 的 clamp 夹回。取自设计 §5。
 */
export const OP_MIN_FLOOR: Record<PacingOp, number> = {
  action: 800,
  scroll: 300,
  card_gap: 1000,
  detail_dwell: 1000,
  feed_card_read: 100,
  content_glance: 1000,
  content_read: 1000,
} as const;

export const OP_MAX_FLOOR: Record<PacingOp, number> = {
  action: CAP_MS,
  scroll: CAP_MS,
  card_gap: CAP_MS,
  detail_dwell: CAP_MS,
  feed_card_read: 30_000,
  content_glance: READ.capMs,
  content_read: READ.capMs,
} as const;

export function maxFloorForOp(op: PacingOp): number {
  return OP_MAX_FLOOR[op];
}

/**
 * 每类操作的内置默认区间（毫秒）——表空/缺行/字段非法时逐项回落此值（零回归基线，= 现役量级）。
 * 取自设计 §5：action/scroll/card_gap 与边缘 timing.ts 预设量级对齐；detail_dwell 复用 `DWELL_FLOOR_MS`。
 * 与边缘 BUILTIN_FLOOR 逐字对齐（表空时云端下发此值、边缘据此 gating，混版缺字段时两侧回落一致）。
 */
export const BUILTIN_FLOOR: Record<PacingOp, PacingFloorPayload> = {
  action: { minMs: 1500, maxMs: 4000 },
  scroll: { minMs: 500, maxMs: 1500 },
  card_gap: { minMs: 3000, maxMs: 7000 },
  detail_dwell: { minMs: DWELL_FLOOR_MS.min, maxMs: DWELL_FLOOR_MS.max },
  feed_card_read: { minMs: 450, maxMs: 7000 },
  content_glance: { minMs: DWELL_FLOOR_MS.min, maxMs: READ.capMs },
  content_read: { minMs: DWELL_FLOOR_MS.min, maxMs: READ.capMs },
} as const;

/**
 * 兜底 floor 提供者（config 层实现，风控层只持接口）：给定操作类别返回**已夹逼**的生效区间。
 * 由 `PacingConfigStore.floorFor` 实现（同步读内存镜像、缺行/非法逐项回落非零内置默认、
 * 在读出口 clamp 到 `[OP_MIN_FLOOR[op], 类别上限]`、永不抛）。供 `buildPacingSnapshot` 现读（PUT 后无需重启）。
 */
export interface PacingFloorProvider {
  floorFor(op: PacingOp): PacingFloorPayload;
}

/**
 * 权威读出口夹逼（第二道夹，`floorFor` 与快照组装共用此单一实现）：把任意区间夹到
 * `[OP_MIN_FLOOR[op], 类别上限]`，并保证 `min ≤ max`（越序时 max 抬到 min）。
 * 负数/超界/零展宽在此被结构性夹成非零合法区间——绝不零延迟、绝不逼近看门狗。
 */
export function clampFloorRange(op: PacingOp, minMs: number, maxMs: number): PacingFloorPayload {
  const lo = OP_MIN_FLOOR[op];
  const hi = maxFloorForOp(op);
  const min = Math.round(clamp(minMs, lo, hi));
  let max = Math.round(clamp(maxMs, lo, hi));
  if (max < min) max = min;
  return { minMs: min, maxMs: max };
}

function floorForComputation(op: PacingOp, provider?: PacingFloorProvider): PacingFloorPayload {
  if (!provider) return BUILTIN_FLOOR[op];
  try {
    const f = provider.floorFor(op);
    return clampFloorRange(op, f.minMs, f.maxMs);
  } catch {
    return BUILTIN_FLOOR[op];
  }
}

/**
 * 组装 welcome 握手节奏快照（total 函数）：`tempo`(风控档标量) + 每类操作已夹逼 floor 区间。
 * 整体 try/catch——provider 抛错/任意异常一律返回 `undefined`（省略 welcome 的 `pacing` 字段），
 * 绝不 brick 握手/致边缘非零退出。status 由调用方（handler）纯读风控态传入、握手早于风控态则回落 normal。
 */
export function buildPacingSnapshot(
  status: RiskStatus,
  provider: PacingFloorProvider,
): PacingSnapshotPayload | undefined {
  try {
    const tempo = tempoForStatus(status);
    const opFloorsMs: Partial<Record<PacingOp, PacingFloorPayload>> = {};
    for (const op of PACING_OPS) {
      const { minMs, maxMs } = provider.floorFor(op);
      // 防御性二次夹：即便某实现漏夹，快照离云端前也非零合法（权威夹点仍在 floorFor）。
      opFloorsMs[op] = clampFloorRange(op, minMs, maxMs);
    }
    return { tempo, opFloorsMs };
  } catch {
    return undefined;
  }
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
  pacing?: PacingFloorProvider;
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
  const floor = floorForComputation(mode === 'glance' ? 'content_glance' : 'content_read', input.pacing);
  return Math.round(clamp(withTempo, floor.minMs, floor.maxMs));
}

export interface ThinkInput {
  status: RiskStatus;
  /** 会话进度 0..1 */
  progress: number;
  /** 目标内容近期已评估过（熟悉）→ 思考时间按 FAMILIAR_DISCOUNT 折扣（仍夹非零下限）。 */
  familiar?: boolean;
}

/** 计算动作前犹豫/感知时间中心值 thinkMs（边缘据此在执行前等待，并叠加抖动）。 */
export function computeThinkMs(input: ThinkInput): number {
  const withTempo = THINK_BASE_MS * tempoForStatus(input.status) * fatigueMultiplier(input.progress);
  if (input.familiar) {
    // 熟悉内容反应更快：降至约 1/3，但夹非零下限不秒退。
    return Math.round(Math.max(withTempo * FAMILIAR_DISCOUNT, THINK_FLOOR_MS));
  }
  return Math.round(withTempo);
}

/**
 * feed 翻页「看新卡」停留下限系数（feed-scroll-card-floor，可调）：
 * 真人扫一眼一张新卡约 0.3–0.5s；perCardMs 线性缩放，capMs 封顶整屏换新不至过长。
 */
export const FEED_FLOOR = { perCardMs: 450, capMs: 7000 } as const;

export interface FeedFloorInput {
  /** 本次翻页新出现（未见过）的卡片数。 */
  newCount: number;
  status: RiskStatus;
  /** 会话进度 0..1 */
  progress: number;
  pacing?: PacingFloorProvider;
}

/**
 * 计算 feed 翻页停留时长中心值 dwellMs（按本次新卡数缩放，复用 tempo/fatigue）。
 * 无新卡（newCount<=0）→ 0（返回未刷新不加延迟）；有新卡按张数线性、封顶 `FEED_FLOOR.capMs`。
 */
export function computeFeedFloorMs(input: FeedFloorInput): number {
  const n = Math.max(0, Math.floor(input.newCount));
  if (n === 0) return 0;
  const floor = floorForComputation('feed_card_read', input.pacing);
  const withTempo = floor.minMs * n * tempoForStatus(input.status) * fatigueMultiplier(input.progress);
  return Math.round(clamp(withTempo, 0, floor.maxMs));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
