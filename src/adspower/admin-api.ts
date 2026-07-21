/**
 * Narrow Cloud-side AdsPower Local API client for management-console environment deletion.
 *
 * Security boundary:
 * - only single-profile `user/delete` and exact `user/list` verification are exposed;
 * - API base and bearer credential are supplied by server-side dependencies only;
 * - response bodies and credentials are never returned in errors.
 */

export const DEFAULT_ADSPOWER_API_BASE = 'http://local.adspower.net:50325';
export const ADSPOWER_MIN_INTERVAL_MS = 1_100;
export const ADSPOWER_REQUEST_TIMEOUT_MS = 10_000;

export type AdsPowerFailureReason =
  | 'adspower_unreachable'
  | 'adspower_timeout'
  | 'adspower_http_error'
  | 'adspower_invalid_response'
  | 'adspower_api_error';

export type AdsPowerOperationResult =
  | { ok: true }
  | { ok: false; reason: AdsPowerFailureReason; detail: string };

export type AdsPowerProfileExistsResult =
  | { ok: true; exists: boolean }
  | { ok: false; reason: AdsPowerFailureReason; detail: string };

export interface AdsPowerAdminApiOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  nowImpl?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

function safeApiBase(value: string | undefined): string {
  const trimmed = value?.trim();
  return (trimmed || DEFAULT_ADSPOWER_API_BASE).replace(/\/+$/, '');
}

function apiErrorDetail(code: unknown): string {
  return typeof code === 'number' || typeof code === 'string'
    ? `adspower_api_error:code=${String(code).slice(0, 40)}`
    : 'adspower_api_error';
}

export class AdsPowerAdminApi {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: AdsPowerAdminApiOptions = {}) {
    this.apiBase = safeApiBase(options.apiBase);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.nowImpl ?? (() => Date.now());
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : ADSPOWER_REQUEST_TIMEOUT_MS;
  }

  private throttledRequest(url: string, init: RequestInit): Promise<Response> {
    const run = this.chain.then(async () => {
      if (this.lastRequestAt !== 0) {
        const waitMs = ADSPOWER_MIN_INTERVAL_MS - (this.now() - this.lastRequestAt);
        if (waitMs > 0) await this.sleep(waitMs);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        this.lastRequestAt = this.now();
      }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requestJson(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: AdsPowerFailureReason; detail: string }> {
    let response: Response;
    try {
      response = await this.throttledRequest(url, init);
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        reason: timeout ? 'adspower_timeout' : 'adspower_unreachable',
        detail: timeout ? `adspower_timeout:${this.timeoutMs}ms` : 'adspower_unreachable',
      };
    }
    if (!response.ok) {
      return { ok: false, reason: 'adspower_http_error', detail: `adspower_http_error:${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:non_json' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:shape' };
    }
    const record = body as Record<string, unknown>;
    if (record.code !== 0) {
      return { ok: false, reason: 'adspower_api_error', detail: apiErrorDetail(record.code) };
    }
    return { ok: true, body: record };
  }

  async deleteProfile(envKey: string, apiKey: string): Promise<AdsPowerOperationResult> {
    const key = envKey.trim();
    if (!key) return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_env_key_missing' };
    const result = await this.requestJson(`${this.apiBase}/api/v1/user/delete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ user_ids: [key] }),
    });
    return result.ok ? { ok: true } : result;
  }

  async profileExists(envKey: string, apiKey: string): Promise<AdsPowerProfileExistsResult> {
    const key = envKey.trim();
    if (!key) return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_env_key_missing' };
    const query = new URLSearchParams({ user_id: key, page: '1', page_size: '10' });
    const result = await this.requestJson(`${this.apiBase}/api/v1/user/list?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!result.ok) return result;
    const data = result.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:list_data' };
    }
    const list = (data as Record<string, unknown>).list;
    if (!Array.isArray(list)) {
      return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:list_shape' };
    }
    const returnedIds: string[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:list_item' };
      }
      const returnedId = String((item as Record<string, unknown>).user_id ?? '').trim();
      if (!returnedId || returnedId !== key) {
        // Absence is authoritative only when AdsPower honored the exact user_id filter.
        // A different/missing id could mean the server ignored the filter or returned a malformed page.
        return { ok: false, reason: 'adspower_invalid_response', detail: 'adspower_invalid_response:list_filter' };
      }
      returnedIds.push(returnedId);
    }
    return { ok: true, exists: returnedIds.length > 0 };
  }
}
