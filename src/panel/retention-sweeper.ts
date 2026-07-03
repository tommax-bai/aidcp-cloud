/**
 * 数据保留清理调度器（change console-cloud-panel-hardening #21/#22/#23）。
 *
 * 面板层的「全局 / 纯时间窗」只读查询打在为「按账号写」优化的追加型表上，这些表原本零保留策略、
 * 无限增长，使扫描成本随运行时长单调恶化。本调度器把三张表的保留清理统一到一个日频任务：
 *  - risk_counters：配额计数流水，风控只回读 1 天 → 默认保留 7 天。
 *  - interaction_feed：展示账本 → 默认保留 30 天。
 *  - llm_token_usage：用量记账（10 分钟桶预聚合）→ 默认保留 45 天（覆盖用量页 31 天窗口 + 容错）。
 *
 * 红线：
 *  - 各表 purge 各自 try/catch——一个失败不拖累其它、不抛逃逸崩进程（照 token-usage flush 定时器范式）。
 *  - 纯读侧治理：只删各自表的过期行，绝不碰风控状态单写路径 / 发布链 / edge。
 *  - purge 的 DELETE 走 occurred_at / bucket_start 索引（见各 store），不全表扫描。
 */

/** 鸭子类型接口——只依赖各 store 暴露的 purge 方法，不与具体 store 类耦合。 */
export interface RetentionTargets {
  riskStore?: { purgeCountersOlderThan(days: number): Promise<number> };
  interactionFeedStore?: { purgeOlderThan(days: number): Promise<number> };
  tokenUsageStore?: { purgeOlderThan(days: number): Promise<number> };
}

export interface RetentionConfig {
  riskCounterDays: number;
  interactionFeedDays: number;
  tokenUsageDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  riskCounterDays: 7,
  interactionFeedDays: 30,
  tokenUsageDays: 45,
};

/** 从 env 读保留天数（缺省回落 DEFAULT_RETENTION；非法值忽略）。 */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    riskCounterDays: num(env.AIDCP_RETENTION_RISK_DAYS, DEFAULT_RETENTION.riskCounterDays),
    interactionFeedDays: num(env.AIDCP_RETENTION_FEED_DAYS, DEFAULT_RETENTION.interactionFeedDays),
    tokenUsageDays: num(env.AIDCP_RETENTION_TOKEN_DAYS, DEFAULT_RETENTION.tokenUsageDays),
  };
}

/** 一次清理的结果：各表删除行数；null = 该 store 缺失（跳过）或本次清理失败。 */
export interface RetentionSweepResult {
  riskCounters: number | null;
  interactionFeed: number | null;
  tokenUsage: number | null;
}

/**
 * 跑一次三表保留清理。每表独立 try/catch——一个失败其它照常，失败项记 null + warn，绝不抛逃逸。
 */
export async function runRetentionSweep(
  targets: RetentionTargets,
  config: RetentionConfig = DEFAULT_RETENTION,
  logger: Pick<Console, 'log' | 'warn'> = console,
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = { riskCounters: null, interactionFeed: null, tokenUsage: null };

  if (targets.riskStore) {
    try {
      result.riskCounters = await targets.riskStore.purgeCountersOlderThan(config.riskCounterDays);
    } catch (err) {
      logger.warn(`[retention] risk_counters 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
    }
  }
  if (targets.interactionFeedStore) {
    try {
      result.interactionFeed = await targets.interactionFeedStore.purgeOlderThan(config.interactionFeedDays);
    } catch (err) {
      logger.warn(`[retention] interaction_feed 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
    }
  }
  if (targets.tokenUsageStore) {
    try {
      result.tokenUsage = await targets.tokenUsageStore.purgeOlderThan(config.tokenUsageDays);
    } catch (err) {
      logger.warn(`[retention] llm_token_usage 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
    }
  }

  const deleted = [result.riskCounters, result.interactionFeed, result.tokenUsage].filter((n): n is number => n !== null);
  if (deleted.length && deleted.some((n) => n > 0)) {
    logger.log(
      `[retention] 保留清理完成：risk_counters -${result.riskCounters ?? '·'} / interaction_feed -${result.interactionFeed ?? '·'} / llm_token_usage -${result.tokenUsage ?? '·'}`,
    );
  }
  return result;
}

export interface RetentionSweeperOptions {
  targets: RetentionTargets;
  config?: RetentionConfig;
  /** 清理周期，默认 24h；env AIDCP_RETENTION_INTERVAL_MS 覆盖（测试可传短）。 */
  intervalMs?: number;
  /** 是否启动时立即跑一次（默认 true）。 */
  runOnStart?: boolean;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface RetentionSweeperHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 起一个日频保留清理定时器（unref，不挡进程退出）。定时回调的 rejection 绝不逃逸成 unhandledRejection。
 */
export function startRetentionSweeper(options: RetentionSweeperOptions): RetentionSweeperHandle {
  const logger = options.logger ?? console;
  const config = options.config ?? retentionConfigFromEnv();
  const envInterval = Number(process.env.AIDCP_RETENTION_INTERVAL_MS);
  const intervalMs =
    options.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS);

  if (options.runOnStart !== false) {
    runRetentionSweep(options.targets, config, logger).catch(() => {});
  }
  const timer = setInterval(() => {
    runRetentionSweep(options.targets, config, logger).catch(() => {});
  }, intervalMs);
  timer.unref?.();

  logger.log(
    `[retention] 保留清理已启动（周期 ${Math.round(intervalMs / 3_600_000)}h；risk_counters ${config.riskCounterDays}d / interaction_feed ${config.interactionFeedDays}d / llm_token_usage ${config.tokenUsageDays}d）`,
  );
  return { stop: () => clearInterval(timer) };
}
