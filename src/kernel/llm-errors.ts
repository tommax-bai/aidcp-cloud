/**
 * LLM 错误族（kernel 段）：错误类型 + 统一错误消息构造 + 排障元数据格式化。
 *
 * 为什么必须进 kernel（change split-cloud-automation-production-runtime）：
 * 拆仓后文本出口 `src/llm/qwen.ts` 归共享传输包、视觉出口 `src/llm/vision.ts` 留 content，
 * 两侧都要抛/认这同一族错误。若各持一份定义，跨副本 `instanceof` 恒 false，
 * 「该厂商密钥缺失」会被静默降级成泛化的「模型不可用」——正是红线里的静默假成功。
 * 故这一族**只允许存在一份定义**，由本文件持有；qwen.ts / vision.ts 一律从这里取。
 *
 * kernel 准入：无 SQL / 无 HTTP 路由 / 无供应商调用标识符与端点字面量 / 无进程内活状态 / 不反向依赖业务层。
 * 本文件只做纯计算（字符串格式化 + JSON 解析），不发任何请求。
 */

/** LLM 错误排障元数据（错误信息统一带 provider/model/role/account/endpoint，文本与多模态客户端共用）。 */
export interface LlmErrorMeta {
  provider?: string;
  model?: string;
  role?: string;
  accountId?: string;
  baseUrl?: string;
}

/** 厂商错误体解析结果（只含排障元数据与被压缩的消息，绝不含密钥）。 */
interface ProviderErrorPayload {
  code?: string;
  message?: string;
  requestId?: string;
  type?: string;
}

function endpointHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.slice(0, 80);
  }
}

function compactText(s: string | undefined, max = 500): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function valueOrDash(v: string | undefined): string {
  return v?.trim() || '-';
}

/**
 * 排障元数据统一格式（缺失项显式打 `-`，MUST NOT 悄悄省略字段）。
 * 供本族错误与调用出口自己的超时错误共用，保证同一条日志线上字段位次一致。
 */
export function formatLlmMeta(meta: LlmErrorMeta): string {
  return [
    `provider=${valueOrDash(meta.provider)}`,
    `model=${valueOrDash(meta.model)}`,
    `role=${valueOrDash(meta.role)}`,
    `account=${valueOrDash(meta.accountId)}`,
    `endpoint=${valueOrDash(endpointHost(meta.baseUrl))}`,
  ].join(' ');
}

/**
 * 选中厂商的密钥不可用时由调用出口抛出（change model-config-volcengine-provider）。
 * 探活/调用方据此把失败诚实归因为"该厂商密钥缺失"（区别于模型名无效），绝不跨厂商兜底。
 */
export class ProviderKeyMissingError extends Error {
  constructor(
    public readonly provider: string,
    meta?: Pick<LlmErrorMeta, 'role' | 'model' | 'accountId'>,
  ) {
    super(`${provider} apiKey 缺失 ${formatLlmMeta({ ...meta, provider })}（在后台为该厂商配置密钥并重启 cloud）`);
    this.name = 'ProviderKeyMissingError';
  }
}

function extractRequestId(message: string | undefined): string | undefined {
  return message?.match(/request\s*id\s*:\s*([A-Za-z0-9._:-]+)/i)?.[1];
}

function parseProviderErrorBody(body: string): ProviderErrorPayload {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; request_id?: unknown; requestId?: unknown; type?: unknown };
      code?: unknown;
      message?: unknown;
      request_id?: unknown;
      requestId?: unknown;
      type?: unknown;
    };
    const err = parsed.error ?? parsed;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const requestIdRaw = err.request_id ?? err.requestId ?? parsed.request_id ?? parsed.requestId;
    return {
      code: typeof err.code === 'string' ? err.code : undefined,
      message,
      requestId: typeof requestIdRaw === 'string' ? requestIdRaw : extractRequestId(message),
      type: typeof err.type === 'string' ? err.type : undefined,
    };
  } catch {
    return { message: compactText(body, 240), requestId: extractRequestId(body) };
  }
}

function formatProviderErrorFields(err: ProviderErrorPayload): string {
  return [
    err.code ? `code=${err.code}` : undefined,
    err.requestId ? `requestId=${err.requestId}` : undefined,
    err.type ? `type=${err.type}` : undefined,
    err.message ? `apiMessage=${JSON.stringify(compactText(err.message, 240))}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

/** HTTP 非 2xx → 统一格式错误（含厂商错误体解析；文本与多模态出口共用，勿在别处复制实现）。 */
export function buildLlmHttpError(status: number, body: string, meta: LlmErrorMeta): Error {
  const parsed = parseProviderErrorBody(body);
  const providerFields = formatProviderErrorFields(parsed);
  const bodyPreview = compactText(body, 300);
  return new Error(
    [
      `LLM HTTP ${status}`,
      formatLlmMeta(meta),
      providerFields,
      bodyPreview ? `body=${bodyPreview}` : undefined,
    ]
      .filter(Boolean)
      .join(' | '),
  );
}

/** 响应体带 error 字段（HTTP 200 但 API 报错）→ 统一格式错误（文本与多模态出口共用）。 */
export function buildLlmApiError(
  err: { code?: string; message?: string; request_id?: string; requestId?: string; type?: string },
  meta: LlmErrorMeta,
): Error {
  return new Error(
    [
      'LLM API error',
      formatLlmMeta(meta),
      formatProviderErrorFields({
        code: err.code,
        message: err.message,
        requestId: err.request_id ?? err.requestId ?? extractRequestId(err.message),
        type: err.type,
      }),
    ]
      .filter(Boolean)
      .join(' | '),
  );
}

/** 响应形状不符（缺 content 等）→ 统一格式错误（文本与多模态出口共用）。 */
export function buildLlmShapeError(message: string, meta: LlmErrorMeta): Error {
  return new Error(['LLM response error', formatLlmMeta(meta), message].join(' | '));
}
