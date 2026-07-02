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
import { type ThinkingMode } from '../config/role-catalog.js';

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
  /**
   * 显式厂商覆盖（change model-config-volcengine-provider）：优先于按角色解析的 provider。
   * 探活按 provider 探时显式传；不传则交注入的 `getProvider` 按角色解析、再缺则走构造默认路径。
   * MUST NOT 在此传裸 baseUrl/apiKey —— 密钥只从启动期预载的 `providerRuntime` 取，保住"唯一出口"不变量。
   */
  provider?: string;
  /** 显式温度覆盖（优先于按角色解析）。 */
  temperature?: number;
  /** 显式超时覆盖（毫秒；探活用短超时）。 */
  timeoutMs?: number;
  /**
   * 显式思考模式覆盖（change role-thinking-mode-config；测试/探活用）：`'off'|'on'` 覆盖，`'default'` = 不干预（不发 thinking 字段）。
   * 优先于按角色解析；不传则走注入的 `getThinking`，再缺则 default（零回归）。
   */
  thinkingMode?: ThinkingMode | 'default';
}

/**
 * 选中厂商的密钥不可用时由 `chat()` 抛出（change model-config-volcengine-provider）。
 * 探活/调用方据此把失败诚实归因为"该厂商密钥缺失"（区别于模型名无效），绝不跨厂商兜底。
 */
export class ProviderKeyMissingError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} apiKey 缺失（在后台为该厂商配置密钥并重启 cloud）`);
    this.name = 'ProviderKeyMissingError';
  }
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
  /**
   * 运行时厂商解析器（按角色，change model-config-volcengine-provider）。
   * 返回该次调用胜出层的 provider id（与 `getModel` 取自同一解析、必然同层一致）。
   * 注入后每次调用按 provider 从 `providerRuntime` 取 baseUrl+key；不注入则走构造默认（零回归）。
   */
  getProvider?: (role?: string) => string;
  /**
   * 运行时思考模式解析器（按角色，change role-thinking-mode-config）。
   * 返回该角色生效的思考三态（'off'/'on'）或 undefined(=default 不干预)。注入后每次调用按角色解析、热加载。
   * **不注入时（单测/旧路径）行为与改造前逐字一致**：不发任何 thinking 字段。
   */
  getThinking?: (role?: string) => ThinkingMode | undefined;
  /**
   * 启动期预载的 `provider → {baseUrl, apiKey}` 静态映射（change model-config-volcengine-provider）。
   * 与现状"密钥启动期一次性加载"一致：模型名热加载、密钥变更重启生效。
   * 注入后 `chat()` 按解析出的 provider 取地址与密钥；选中 provider 缺密钥即诚实抛错、绝不跨厂商兜底。
   * 不注入（单测/旧路径）则用构造期 baseUrl+apiKey，请求与改造前逐字一致。
   */
  providerRuntime?: Record<string, { baseUrl: string; apiKey: string }>;
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
    /** 生效厂商（change model-config-volcengine-provider）：供日志/记账区分同名模型来自哪个厂商。 */
    provider?: string;
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

/** 已告警过的守卫组合（warn-once，避免刷屏）；key = `${provider}|${model}|${mode}`。 */
const warnedThinkingGuards = new Set<string>();

/** 模型家族粗判（按名字前缀；change role-thinking-mode-config 的家族判定集中此处，便于单测与校正）。 */
function thinkingModelFamily(model: string): 'qwen' | 'deepseek' | 'other' {
  const m = model.trim().toLowerCase();
  if (m.startsWith('qwen')) return 'qwen';
  if (m.startsWith('deepseek')) return 'deepseek';
  return 'other';
}

/**
 * 把思考三态按 provider + model 翻译成要合并进请求体的附加字段（change role-thinking-mode-config）。
 * - `undefined`（= default） → `{}`：不发任何 thinking 字段，请求体与本 change 前逐字一致（零回归红线）。
 * - `off`：dashscope → `{ enable_thinking: false }`；volcengine → `{ thinking: { type: 'disabled' } }`。
 * - `on`：dashscope + deepseek 系 → `{ enable_thinking: true }`（非流式可用，推理落 reasoning_content、我们仍只读 content）；
 *         volcengine → `{ thinking: { type: 'enabled' } }`；
 *         **dashscope + qwen 系 / 未识别组合 → `{}` 失败安全 + warn**（Qwen 开思考需流式，出口恒非流式，绝不发会 400 的字段）。
 * ⚠ 参数键名（enable_thinking / thinking.type）晚于训练截止；部署前须逐个 curl 探活确认目标模型接受（见 change tasks 1.x），错了只需改此一处。
 */
export function buildThinkingParams(
  provider: string | undefined,
  model: string,
  mode: ThinkingMode | undefined,
): { params: Record<string, unknown>; warn?: string } {
  if (!mode) return { params: {} };
  if (provider === 'volcengine') {
    return { params: { thinking: { type: mode === 'on' ? 'enabled' : 'disabled' } } };
  }
  if (provider === 'dashscope') {
    if (mode === 'off') return { params: { enable_thinking: false } };
    // on：仅 DeepSeek 系非流式可开思考；Qwen 系需流式 → 失败安全回落 default + warn。
    if (thinkingModelFamily(model) === 'deepseek') return { params: { enable_thinking: true } };
    return {
      params: {},
      warn: `thinking=on 对 dashscope/${model} 需流式支持（本期不支持），回落 default 不发 thinking 字段，绝不发会 400 的请求`,
    };
  }
  // 未知 provider：失败安全，绝不发可能被拒的字段。
  return {
    params: {},
    warn:
      mode === 'on'
        ? `thinking=on 对未知 provider ${provider ?? '-'}/${model} 失败安全回落 default`
        : undefined,
  };
}

/** Qwen HTTP 客户端 */
export class QwenClient implements ChatLlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly getModel?: (role?: string) => string;
  private readonly getTemperature?: (role?: string) => number | undefined;
  private readonly getProvider?: (role?: string) => string;
  private readonly getThinking?: (role?: string) => ThinkingMode | undefined;
  private readonly providerRuntime?: Record<string, { baseUrl: string; apiKey: string }>;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall?: (info: {
    role?: string;
    provider?: string;
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
    this.getProvider = options.getProvider;
    this.getThinking = options.getThinking;
    this.providerRuntime = options.providerRuntime;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.temperature = options.temperature ?? 0;
    // 默认 180s：thinking 类模型（qwen3 thinking / deepseek-r1 类）复杂提示常需 60–150s+，
    // 短天花板会把大量合法慢调用误判为超时中止（change raise-model-call-timeouts-for-thinking-models）。
    // 天花板经 env AIDCP_LLM_TIMEOUT_MS 可调（在 server.ts 构造处读取）；探活/发布等显式传 timeoutMs 的路径不受影响。
    // 关键联动不变量：浏览闭环空转看门狗轻推阈值 MUST 严格大于此天花板（见 resume-limits.ts）。
    this.timeoutMs = options.timeoutMs ?? 180_000;
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
    // opts 优先 → 按角色解析 → 构造默认（不传 opts 时与改造前逐字一致）。
    const model = opts?.model ?? this.getModel?.(opts?.role) ?? this.model;
    const temperature = opts?.temperature ?? this.getTemperature?.(opts?.role) ?? this.temperature;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    // provider 路由（change model-config-volcengine-provider）：按本次解析出的 provider 取 baseUrl+key。
    // 缺密钥发请求前诚实抛错、绝不退回别厂商的 key/baseUrl（避免把模型名发到错误厂商的"静默走错"）。
    const provider = opts?.provider ?? this.getProvider?.(opts?.role);
    // 思考三态解析（change role-thinking-mode-config）：显式覆盖 → 按角色解析 → undefined(=default)。
    // 'default' 显式覆盖等价 undefined（不发 thinking 字段）。不注入 getThinking 的旧路径/单测恒 undefined → 零回归。
    let thinking: ThinkingMode | undefined;
    if (opts?.thinkingMode === 'off' || opts?.thinkingMode === 'on') thinking = opts.thinkingMode;
    else if (opts?.thinkingMode === 'default') thinking = undefined;
    else thinking = this.getThinking?.(opts?.role);
    const { params: thinkingParams, warn: thinkingWarn } = buildThinkingParams(provider, model, thinking);
    if (thinkingWarn) {
      const k = `${provider ?? '-'}|${model}|${thinking ?? '-'}`;
      if (!warnedThinkingGuards.has(k)) {
        warnedThinkingGuards.add(k);
        console.warn(`[llm] ${thinkingWarn}`);
      }
    }
    let baseUrl: string;
    let apiKey: string;
    if (provider && this.providerRuntime) {
      const rt = this.providerRuntime[provider];
      if (!rt || !rt.apiKey) throw new ProviderKeyMissingError(provider);
      baseUrl = rt.baseUrl;
      apiKey = rt.apiKey;
    } else {
      // 未注入多厂商运行时（单测/旧路径）：用构造默认，与改造前逐字一致。
      baseUrl = this.baseUrl;
      apiKey = this.apiKey;
      if (!apiKey) {
        throw new Error('Qwen apiKey 缺失（设置 DASHSCOPE_API_KEY 或传入 apiKey）');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let ok = false;
    // token 用量（change llm-token-usage-stats）：声明于 try 外，使 finally 在失败路径也能看到。
    // 红线：响应体一旦带 usage（prompt token 已计费）就如实带出，绝不因后续判失败而清零。
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    try {
      const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // change role-thinking-mode-config：thinkingParams 为 default 态时为空对象，spread 不加任何字段 → 请求体零回归。
        body: JSON.stringify({
          model,
          messages,
          temperature,
          ...thinkingParams,
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
