/**
 * Qwen（阿里通义千问）文本模型 HTTP 客户端。
 *
 * 走 DashScope 兼容 OpenAI 的 chat/completions 接口（兼容模式），
 * 仅依赖运行时全局 fetch（Node>=18），不引第三方 SDK，保持云端轻量。
 *
 * 用途：
 * - planner：把高层目标拆解为有序步骤；
 * - 元素选择：缓存缺口时从元素清单里"做选择题"。
 *
 * 这是云端唯一的模型出口；planner / selector 通过 LlmClient 接口解耦，便于替换/打桩。
 */

/**
 * Per-call 覆盖选项（change console-role-model-config）。
 * 调用方按需传：`role` 触发按角色解析模型/温度；`model`/`temperature`/`timeoutMs` 为显式覆盖（探活与测试用）。
 * **不传 opts 时行为与改造前逐字一致**（零回归不变量）。
 */
export interface LlmCallOpts {
  /** 角色标识（如 `browse:content_evaluator` / `publish:ContentCreator`）；交给注入的解析器按角色取模型/温度。 */
  role?: string;
  /**
   * 账号标识（token 用量按账号归属用；change llm-token-usage-stats）。
   * 现为单租户：不传即 recorder 端缺省 `'default'`。多账号内核落地后由其在并发安全处穿入真实账号
   * （本流不在 RoleDispatcher 实时读共享 currentAccountId，见 change design D5）。
   */
  accountId?: string;
  /** 显式模型名覆盖（优先于按角色解析；用于保存前探活）。 */
  model?: string;
  /** 显式温度覆盖（优先于按角色解析）。 */
  temperature?: number;
  /** 显式超时覆盖（毫秒；探活用短超时）。 */
  timeoutMs?: number;
}

/** 通用文本 LLM 客户端接口（与 edge 侧 selector.LlmClient 同形，便于迁移）。只需补全。 */
export interface LlmClient {
  complete(prompt: string, opts?: LlmCallOpts): Promise<string>;
}

/** 含多轮 chat 的文本客户端（发布角色 + 按角色绑定 wrapper 用）。 */
export interface ChatLlmClient extends LlmClient {
  chat(messages: QwenChatMessage[], opts?: LlmCallOpts): Promise<string>;
}

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenClientOptions {
  /** API Key（默认读 env DASHSCOPE_API_KEY） */
  apiKey?: string;
  /** 模型名，默认 qwen-turbo */
  model?: string;
  /**
   * 运行时模型名解析器（优先于 model）。注入后每次调用按需取当前配置，
   * 使后台改模型名无需重启即热加载生效（change console-model-provider-config）。
   * 可选 `role`：按角色解析覆盖模型，缺省/无覆盖回退全局模型名（change console-role-model-config）。
   */
  getModel?: (role?: string) => string;
  /**
   * 运行时温度解析器（按角色，change console-role-model-config）。
   * 返回该角色的温度覆盖；无覆盖返回 undefined → 回退构造期 temperature。
   */
  getTemperature?: (role?: string) => number | undefined;
  /** 兼容 OpenAI 的 base url，默认 DashScope 兼容端点 */
  baseUrl?: string;
  /** 采样温度，默认 0（定位/规划要稳定） */
  temperature?: number;
  /** 请求超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
  /**
   * 调用可观测钩子（change console-role-model-config；token 字段 change llm-token-usage-stats）：
   * 每次调用后回报 role / 生效 model / 耗时 / 成功与否 / 账号 / token 用量。
   * 只含元数据与 token 计数，MUST NOT 含密钥或提示词正文。供运营验证按角色改模型是否真生效、按账号/角色/模型统计 token 消耗。
   * **token 与 ok 解耦（红线）**：`promptTokens/completionTokens/totalTokens` 取自响应体 `usage`，
   * 即使 `ok=false`（如已返回 usage 但缺 content 判失败）也带真实已计费 token；真没拿到 usage 才为 undefined。
   */
  onCall?: (info: {
    role?: string;
    model: string;
    ms: number;
    ok: boolean;
    accountId?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }) => void;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  /** DashScope 兼容模式 token 用量（change llm-token-usage-stats）：早先被静默丢弃，现捡回交给记账。 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** Qwen HTTP 客户端 */
export class QwenClient implements ChatLlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly getModel?: (role?: string) => string;
  private readonly getTemperature?: (role?: string) => number | undefined;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall?: (info: {
    role?: string;
    model: string;
    ms: number;
    ok: boolean;
    accountId?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }) => void;

  constructor(options: QwenClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
    this.model = options.model ?? 'qwen-turbo';
    this.getModel = options.getModel;
    this.getTemperature = options.getTemperature;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onCall = options.onCall;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 单轮补全：输入提示词，返回模型纯文本输出 */
  async complete(prompt: string, opts?: LlmCallOpts): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], opts);
  }

  /** 多轮对话补全 */
  async chat(messages: QwenChatMessage[], opts?: LlmCallOpts): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Qwen apiKey 缺失（设置 DASHSCOPE_API_KEY 或传入 apiKey）');
    }
    // opts 优先 → 按角色解析 → 构造默认（不传 opts 时与改造前逐字一致）。
    const model = opts?.model ?? this.getModel?.(opts?.role) ?? this.model;
    const temperature = opts?.temperature ?? this.getTemperature?.(opts?.role) ?? this.temperature;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let ok = false;
    // token 用量（change llm-token-usage-stats）：声明于 try 外，使 finally 在失败路径也能看到。
    // 红线：响应体一旦带 usage（prompt token 已计费）就如实带出，绝不因后续判失败而清零。
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Qwen HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      // 早于「缺 content 抛错」捕获 usage：DashScope 兼容模式即使生成失败也常已计 prompt token。
      usage = data.usage;
      if (data.error?.message) {
        throw new Error(`Qwen API 错误: ${data.error.message}`);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Qwen 响应缺少 choices[0].message.content');
      }
      ok = true;
      return content;
    } finally {
      clearTimeout(timer);
      this.onCall?.({
        role: opts?.role,
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
