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

/** 通用文本 LLM 客户端接口（与 edge 侧 selector.LlmClient 同形，便于迁移） */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenClientOptions {
  /** API Key（默认读 env DASHSCOPE_API_KEY） */
  apiKey?: string;
  /** 模型名，默认 qwen-plus */
  model?: string;
  /** 兼容 OpenAI 的 base url，默认 DashScope 兼容端点 */
  baseUrl?: string;
  /** 采样温度，默认 0（定位/规划要稳定） */
  temperature?: number;
  /** 请求超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** Qwen HTTP 客户端 */
export class QwenClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
    this.model = options.model ?? 'qwen-turbo';
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 单轮补全：输入提示词，返回模型纯文本输出 */
  async complete(prompt: string): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }]);
  }

  /** 多轮对话补全 */
  async chat(messages: QwenChatMessage[]): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Qwen apiKey 缺失（设置 DASHSCOPE_API_KEY 或传入 apiKey）');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Qwen HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      if (data.error?.message) {
        throw new Error(`Qwen API 错误: ${data.error.message}`);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Qwen 响应缺少 choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
