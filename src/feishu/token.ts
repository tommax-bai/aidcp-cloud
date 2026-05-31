/**
 * 飞书 tenant_access_token 管理。
 *
 * 自建应用通过 App ID + App Secret 换取 tenant_access_token，
 * 有效期 2 小时。本模块在内存缓存 token，并在过期前 5 分钟自动续期，
 * 对外暴露 getToken(): Promise<string>。
 *
 * 仅依赖运行时全局 fetch（Node>=18），不引第三方 SDK。fetch 可注入（测试用）。
 */

const TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** 提前续期窗口：过期前 5 分钟刷新 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  /** 有效期（秒），通常 7200 */
  expire?: number;
}

export interface FeishuTokenManagerOptions {
  /** App ID，默认读 env FEISHU_APP_ID */
  appId?: string;
  /** App Secret，默认读 env FEISHU_APP_SECRET */
  appSecret?: string;
  /** token 端点，默认飞书国内站 */
  endpoint?: string;
  /** 注入时钟（测试用），默认 Date.now */
  clock?: () => number;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 内存缓存的 tenant_access_token 管理器 */
export class FeishuTokenManager {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly endpoint: string;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;

  private cachedToken?: string;
  /** token 失效的绝对时间戳（ms） */
  private expiresAt = 0;
  /** 正在进行中的刷新请求（避免并发重复拉取） */
  private inflight?: Promise<string>;

  constructor(options: FeishuTokenManagerOptions = {}) {
    this.appId = options.appId ?? process.env.FEISHU_APP_ID ?? '';
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET ?? '';
    this.endpoint = options.endpoint ?? TOKEN_ENDPOINT;
    this.clock = options.clock ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 取一个有效 token：命中缓存直接返回，否则（并发安全地）拉取并缓存。 */
  async getToken(): Promise<string> {
    const now = this.clock();
    if (this.cachedToken && now < this.expiresAt - REFRESH_AHEAD_MS) {
      return this.cachedToken;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** 强制刷新 token（忽略缓存） */
  private async refresh(): Promise<string> {
    if (!this.appId || !this.appSecret) {
      throw new Error('飞书凭证缺失：请配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    const resp = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!resp.ok) {
      throw new Error(`飞书 token 请求失败：HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as TenantTokenResponse;
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`飞书 token 获取失败：code=${data.code} msg=${data.msg}`);
    }
    const expireSec = data.expire ?? 7200;
    this.cachedToken = data.tenant_access_token;
    this.expiresAt = this.clock() + expireSec * 1000;
    return this.cachedToken;
  }
}
