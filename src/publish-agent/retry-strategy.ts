export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let lastError: Error | null = null;
  let delayMs = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, config.maxDelayMs)));
        delayMs *= config.backoffMultiplier;
      }
    }
  }

  throw lastError ?? new Error('executeWithRetry: unknown error');
}

export interface FallbackOption<T> {
  default: T;
  reason: string;
}

export async function executeWithFallback<T>(
  fn: () => Promise<T>,
  fallback: FallbackOption<T>,
  maxRetries: number = 2,
): Promise<{ result: T; usedFallback: boolean; error?: string }> {
  try {
    const result = await executeWithRetry(fn, { ...DEFAULT_RETRY_CONFIG, maxRetries });
    return { result, usedFallback: false };
  } catch (error) {
    return {
      result: fallback.default,
      usedFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
