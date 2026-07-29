/**
 * OpenAI 兼容多模态（视觉）客户端（change textcard-cover-form，design D5）。
 *
 * 与文本出口 QwenClient 并列的独立出口：消息 content 支持 image_url 数组，
 * 供封面形态感知等视觉判定使用；也是后续产后校验等多模态需求的共享缝。
 * dashscope 与 volcengine 的 compatible-mode 端点均接受该消息形状，零新增凭据面。
 *
 * 关键不变量（单测锁死）：
 * - 本客户端**不做任何按角色的模型解析**，也**绝不回落到全局文本模型层**——
 *   model / provider 只来自构造期显式注入的 getModel / getProvider
 *   （解析链「env → 代码默认」在装配处完成，本文件之外）。
 *   文本模型收到 image_url 会 400 或静默走错厂商，属正确性问题而非风格问题。
 * - 凭据只从启动期预载的 providerRuntime 取；选中厂商缺密钥 → **发请求前**诚实抛
 *   ProviderKeyMissingError，绝不跨厂商兜底。
 * - token 记账钩子 onCall 与 qwen.ts 同语义（best-effort、只带元数据与 token 计数，
 *   绝不含密钥或提示词正文，绝不影响调用本体）。
 */

// change split-cloud-automation-production-runtime：错误族从 kernel 取，**绝不**再从文本出口 `./qwen.js` 取。
// 拆仓后文本出口归共享传输包、本文件留 content；两份副本各持一份错误类会让跨副本 `instanceof` 恒 false，
// 把「该厂商密钥缺失」静默降级成泛化的「模型不可用」。同一份定义是这条诚实归因的唯一保证。
import {
  ProviderKeyMissingError,
  buildLlmApiError,
  buildLlmHttpError,
  buildLlmShapeError,
} from '../kernel/llm-errors.js';

/** 纯文本内容段。 */
export interface VisionTextPart {
  type: 'text';
  text: string;
}

/** 图片内容段（OpenAI 兼容形状：URL 或 data URI）。 */
export interface VisionImageUrlPart {
  type: 'image_url';
  image_url: { url: string };
}

export type VisionContentPart = VisionTextPart | VisionImageUrlPart;

/** 多模态消息：content 为字符串（纯文本）或内容段数组（文本 + 图片混排）。 */
export interface VisionChatMessage {
  role: 'system' | 'user';
  content: string | VisionContentPart[];
}

/** Per-call 选项（只有记账归属与超时；**没有** role→模型解析——见文件头不变量）。 */
export interface VisionCallOpts {
  /** 记账归属角色（仅入 onCall 记账/日志；绝不参与模型/厂商解析）。 */
  role?: string;
  /** 记账归属账号。 */
  accountId?: string;
  /** 显式超时覆盖（毫秒）。 */
  timeoutMs?: number;
  /** Optional completion ceiling for dense OCR-like calls; omitted for existing visual classifiers. */
  maxTokens?: number;
}

/** 多模态 LLM 客户端接口（感知服务经此解耦，便于打桩单测）。 */
export interface VisionLlmClient {
  chatVision(messages: VisionChatMessage[], opts?: VisionCallOpts): Promise<string>;
}

/** onCall 记账钩子信息（与 qwen.ts 的 onCall 同形同语义）。 */
export interface VisionCallInfo {
  role?: string;
  provider?: string;
  model: string;
  ms: number;
  ok: boolean;
  accountId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface OpenAiCompatVisionClientOptions {
  /**
   * 视觉模型名访问器。**必填、无隐式默认**：装配处按「env（AIDCP_COVER_FORM_MODEL 等）
   * → 代码默认」解析后注入；本客户端自身不解析、不回落。
   */
  getModel: () => string;
  /** 厂商 id 访问器（同上；必填）。 */
  getProvider: () => string;
  /**
   * 启动期预载的 `provider → {baseUrl, apiKey}` 静态映射（与 qwen.ts 同源；必填）。
   * 选中厂商缺密钥即诚实抛错，绝不跨厂商兜底。
   */
  providerRuntime: Record<string, { baseUrl: string; apiKey: string }>;
  /** 调用可观测钩子（token 记账；与 qwen.ts 同语义，best-effort 绝不破坏调用）。 */
  onCall?: (info: VisionCallInfo) => void;
  /** 请求超时（毫秒），默认 30s（视觉判定内层闸的缺省档；调用方可 per-call 覆盖）。 */
  timeoutMs?: number;
  /** 注入 fetch（测试用），默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'warn'>;
}

/** 兼容模式 chat/completions 响应体（与 qwen.ts 同形；此处仅取所需字段）。 */
interface VisionChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { code?: string; message?: string; request_id?: string; requestId?: string; type?: string };
}

/** OpenAI 兼容多模态客户端实现。 */
export class OpenAiCompatVisionClient implements VisionLlmClient {
  private readonly getModel: () => string;
  private readonly getProvider: () => string;
  private readonly providerRuntime: Record<string, { baseUrl: string; apiKey: string }>;
  private readonly onCall?: (info: VisionCallInfo) => void;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatVisionClientOptions) {
    // 构造期硬校验：模型/厂商/凭据映射必须显式注入——本客户端没有任何「默认文本模型」
    // 可回落（不变量：含 image_url 的消息绝不进全局文本模型层）。
    if (
      typeof options?.getModel !== 'function' ||
      typeof options?.getProvider !== 'function' ||
      !options?.providerRuntime ||
      typeof options.providerRuntime !== 'object'
    ) {
      throw new Error(
        'OpenAiCompatVisionClient 需要显式注入 getModel / getProvider / providerRuntime（无隐式默认，绝不回落文本模型层）',
      );
    }
    this.getModel = options.getModel;
    this.getProvider = options.getProvider;
    this.providerRuntime = options.providerRuntime;
    this.onCall = options.onCall;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 多模态补全：返回模型纯文本输出（temperature 恒 0——形态判定要稳定）。 */
  async chatVision(messages: VisionChatMessage[], opts?: VisionCallOpts): Promise<string> {
    const model = this.getModel();
    const provider = this.getProvider();
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const maxTokens =
      typeof opts?.maxTokens === 'number' && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
        ? Math.floor(opts.maxTokens)
        : undefined;
    const rt = this.providerRuntime[provider];
    if (!rt || !rt.apiKey) {
      // 发请求前诚实抛错：绝不退回别厂商的 key/baseUrl（避免把模型名发到错误厂商的"静默走错"）。
      throw new ProviderKeyMissingError(provider, { role: opts?.role, model, accountId: opts?.accountId });
    }
    const baseUrl = rt.baseUrl;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let ok = false;
    // token 用量：声明于 try 外，使 finally 在失败路径也能看到（与 qwen.ts 同红线：
    // 响应体一旦带 usage 就如实带出，绝不因后续判失败而清零）。
    let usage: VisionChatCompletionResponse['usage'];
    try {
      const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rt.apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw buildLlmHttpError(res.status, text, { provider, model, role: opts?.role, accountId: opts?.accountId, baseUrl });
      }
      const data = (await res.json()) as VisionChatCompletionResponse;
      usage = data.usage;
      if (data.error?.message) {
        throw buildLlmApiError(data.error, { provider, model, role: opts?.role, accountId: opts?.accountId, baseUrl });
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw buildLlmShapeError('missing choices[0].message.content', {
          provider,
          model,
          role: opts?.role,
          accountId: opts?.accountId,
          baseUrl,
        });
      }
      ok = true;
      return content;
    } finally {
      clearTimeout(timer);
      this.onCall?.({
        role: opts?.role,
        provider,
        model,
        ms: Date.now() - startedAt,
        ok,
        accountId: opts?.accountId,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
      });
    }
  }
}
