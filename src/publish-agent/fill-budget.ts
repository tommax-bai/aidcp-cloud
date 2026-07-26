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
   * 单步预算上限。MUST 显著小于边缘发布租约 TTL（AIDCP_EDGE_PUBLISH_LEASE_MS，默认 1000s）——
   * 否则边缘会在打字途中单方面过期租约、恢复浏览循环，在半写的编辑器上滚页导航。
   */
  maxMs: number;
}

export const DEFAULT_FILL_BUDGET: FillBudgetConfig = {
  baseMs: 20_000,
  perCharMs: 250,
  maxMs: 400_000,
};

/** 预算上限相对发布租约 TTL 的安全比例。 */
export const FILL_BUDGET_LEASE_RATIO = 0.4;

/** 发布租约 TTL 的兜底值（与 AIDCP_EDGE_PUBLISH_LEASE_MS 的默认值一致）。 */
export const DEFAULT_PUBLISH_LEASE_MS = 1_000_000;

/**
 * 预算必须容得下的最小正文长度。内容管线的设计产出区间是 200–500 字；
 * 有效上限掉到这个数以下，说明配置本身把 FB 发帖压死了，MUST 在启动时吼出来——
 * 否则每一篇都以 `content_too_long` 失败，而那条错误信息会把运维引向内容生成侧。
 */
export const MIN_USABLE_FILL_CHARS = 600;

/**
 * 逐项校验预算配置：非有限数 / 非正数一律回落默认值并告警；base ≥ max 亦回落。
 *
 * 必要性：`AIDCP_PUBLISH_FILL_PER_CHAR_MS=0` 会让可打完的上限变成无穷 → 诚实长度闸整个失效；
 * 而任何一项变成 NaN 都会一路污染到下发的预算，让云端的等待窗口退化成「立刻超时」，
 * 把本模块刚拆掉的孤儿打字级联原样复活。
 */
export function sanitizeFillBudget(cfg: FillBudgetConfig, warn?: (message: string) => void): FillBudgetConfig {
  const pick = (value: number, fallback: number, name: string): number => {
    if (!Number.isFinite(value) || value <= 0) {
      warn?.(`[fill-budget] ${name}=${value} 非法（须为正有限数）→ 回落默认值 ${fallback}`);
      return fallback;
    }
    return value;
  };
  const baseMs = pick(cfg.baseMs, DEFAULT_FILL_BUDGET.baseMs, 'baseMs');
  const perCharMs = pick(cfg.perCharMs, DEFAULT_FILL_BUDGET.perCharMs, 'perCharMs');
  let maxMs = pick(cfg.maxMs, DEFAULT_FILL_BUDGET.maxMs, 'maxMs');
  if (maxMs <= baseMs) {
    warn?.(`[fill-budget] maxMs=${maxMs} 不大于 baseMs=${baseMs}（正文一个字都打不了）→ 回落默认上限 ${DEFAULT_FILL_BUDGET.maxMs}`);
    maxMs = DEFAULT_FILL_BUDGET.maxMs;
  }
  return { baseMs, perCharMs, maxMs };
}

/**
 * 启动时的可用性自检：有效正文上限低于管线设计区间就吼出来，并明确指出该调哪个旋钮。
 * 只告警、不改配置——租约确实压不下长正文时，诚实失败好过偷偷截断。
 */
export function warnIfFillBudgetUnusable(cfg: FillBudgetConfig, warn: (message: string) => void): void {
  const chars = maxFillChars(cfg);
  if (chars >= MIN_USABLE_FILL_CHARS) return;
  warn(
    `[fill-budget] 有效正文上限只有 ${chars} 字（预算上限 ${cfg.maxMs}ms），低于内容管线 200–500 字的设计区间：` +
      `Facebook 发帖将大面积以 content_too_long 失败。这是配置问题、不是内容生成问题——` +
      `请调高 AIDCP_EDGE_PUBLISH_LEASE_MS / AIDCP_PUBLISH_FILL_MAX_MS，或调低 AIDCP_PUBLISH_FILL_PER_CHAR_MS。`,
  );
}

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
  // 租约本身非法（NaN / 负数 / 0）→ 绝不让它污染预算。用默认租约算天花板并告警：
  // 若放任 NaN 传下去，maxMs 会变成 NaN，下发的预算随之 NaN，云端 setTimeout(NaN) 立刻触发，
  // 等于把「云端先放弃、边缘还在打字」的级联重新装回来。
  let effectiveLeaseMs = leaseMs;
  if (!Number.isFinite(effectiveLeaseMs) || effectiveLeaseMs <= 0) {
    warn?.(
      `[fill-budget] 发布租约 ${leaseMs} 非法（须为正有限数）→ 按默认 ${DEFAULT_PUBLISH_LEASE_MS}ms 计算预算天花板`,
    );
    effectiveLeaseMs = DEFAULT_PUBLISH_LEASE_MS;
  }
  const ceiling = Math.floor(effectiveLeaseMs * FILL_BUDGET_LEASE_RATIO);
  if (cfg.maxMs <= ceiling) return cfg;
  warn?.(
    `[fill-budget] 正文填写预算上限 ${cfg.maxMs}ms 超过发布租约 ${effectiveLeaseMs}ms 的 ${FILL_BUDGET_LEASE_RATIO} → 压回 ${ceiling}ms`,
  );
  return { ...cfg, maxMs: ceiling };
}
