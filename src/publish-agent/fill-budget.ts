/**
 * 正文填写单步预算（change facebook-post-publish 补丁：逐字输入 vs 固定单步墙）。
 *
 * 背景：Facebook 的编辑器要求逐字符输入（一字符一次 Input.insertText），实测每字符
 * ~150–165ms（拟人节奏 + CDP 往返）。而云端单步等待窗口是常数 30s——O(n) 的输入撞常数墙，
 * 正文超过 ~175 字即必然超时：云端判 failed，边缘还在往活着的编辑器里打字。
 *
 * 修法：云端按正文长度算出这一步的**执行预算**，随指令下发（`PublishCommandPayload.timeoutMs`）。
 * 边缘据此自我掐表、超时即停手清场并诚实回报；云端只在其上多等一点点兜底（见 CommandSequencer
 * 的 resultSlackMs），于是**边缘永远先答**，孤儿打字循环由构造消失。
 *
 * 红线：预算超出上限时 MUST 诚实失败（content_too_long），MUST NOT 截断正文。
 */

export interface FillBudgetConfig {
  /** 与长度无关的固定开销：聚焦、清空编辑器、打完后的全文回读校验。 */
  baseMs: number;
  /** 每字符预算。实测均值 ~150–165ms（含 CDP 往返），留约 1.5x 余量。 */
  perCharMs: number;
  /**
   * 单步预算上限。MUST 显著小于边缘发布租约 TTL（AIDCP_EDGE_PUBLISH_LEASE_MS，默认 600s）——
   * 否则边缘会在打字途中单方面过期租约、恢复浏览循环，在半写的编辑器上滚页导航。
   */
  maxMs: number;
}

export const DEFAULT_FILL_BUDGET: FillBudgetConfig = {
  baseMs: 20_000,
  perCharMs: 250,
  maxMs: 240_000,
};

/** 预算上限相对发布租约 TTL 的安全比例。 */
export const FILL_BUDGET_LEASE_RATIO = 0.4;

/** 字符数按码位计——与边缘 `Array.from(text)` 的分字口径一致（中文/emoji 各算一个）。 */
export function contentCharCount(content: string): number {
  return Array.from(content).length;
}

/** 正文填写这一步的执行预算（毫秒）。不设下限于 baseMs 之下；上限由 maxMs 硬钳。 */
export function computeFillTimeoutMs(content: string, cfg: FillBudgetConfig = DEFAULT_FILL_BUDGET): number {
  const chars = contentCharCount(content);
  return Math.min(cfg.maxMs, cfg.baseMs + chars * cfg.perCharMs);
}

/** 预算上限所能容纳的最长正文（字符数）。超过它只能诚实失败，绝不截断。 */
export function maxFillChars(cfg: FillBudgetConfig = DEFAULT_FILL_BUDGET): number {
  return Math.max(0, Math.floor((cfg.maxMs - cfg.baseMs) / cfg.perCharMs));
}

/** 正文是否超出可打完的上限。 */
export function isContentTooLong(content: string, cfg: FillBudgetConfig = DEFAULT_FILL_BUDGET): boolean {
  return contentCharCount(content) > maxFillChars(cfg);
}

/**
 * 按发布租约 TTL 收敛预算上限：maxMs MUST ≤ leaseMs × 0.4。
 * 有人调低租约却没调预算时，把上限压回安全值并告警——绝不让边缘在打字中途过期租约。
 */
export function clampFillBudgetToLease(
  cfg: FillBudgetConfig,
  leaseMs: number,
  warn?: (message: string) => void,
): FillBudgetConfig {
  const ceiling = Math.floor(leaseMs * FILL_BUDGET_LEASE_RATIO);
  if (cfg.maxMs <= ceiling) return cfg;
  warn?.(
    `[fill-budget] 正文填写预算上限 ${cfg.maxMs}ms 超过发布租约 ${leaseMs}ms 的 ${FILL_BUDGET_LEASE_RATIO} → 压回 ${ceiling}ms`,
  );
  return { ...cfg, maxMs: ceiling };
}
