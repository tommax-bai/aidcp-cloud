/**
 * 通义万相（Wanxiang）文生图 HTTP 客户端。
 *
 * 走 DashScope 文生图异步任务接口：
 * 1. POST 提交生成任务 → 返回 task_id
 * 2. GET 轮询任务状态（最多 6 次，间隔 5s，总超时约 30s）
 * 3. 状态为 SUCCEEDED 时获取结果 URL
 *
 * 仅依赖运行时全局 fetch（Node>=18），不引第三方 SDK，保持轻量。
 * 失败返回 { url: null, error } 不抛异常，调用方无需 try/catch。
 */

import type { ImageProvider, ImageResult } from './image-provider.js';

const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis';
const TASK_URL_PREFIX = 'https://dashscope.aliyuncs.com/api/v1/tasks/';

export interface WanxiangClientOptions {
  /** API Key（默认读 env WANXIANG_API_KEY） */
  apiKey?: string;
  /** 模型名，默认 wanx-v1 */
  model?: string;
  /** 默认尺寸，默认 1024*1024 */
  defaultSize?: string;
  /** 最大轮询次数，默认 6 */
  maxPollAttempts?: number;
  /** 轮询间隔（毫秒），默认 5000 */
  pollIntervalMs?: number;
  /** 日志注入 */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 提交任务响应 */
interface SubmitResponse {
  output?: { task_id?: string; task_status?: string };
  request_id?: string;
  code?: string;
  message?: string;
}

/** 轮询任务响应 */
interface TaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    results?: Array<{ url?: string }>;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

export class WanxiangClient implements ImageProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultSize: string;
  private readonly maxPollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WanxiangClientOptions = {}) {
    // 万相文生图与 Qwen 同属百炼、同一 DashScope key；未单设 WANXIANG_API_KEY 时回退 DASHSCOPE_API_KEY。
    this.apiKey = options.apiKey ?? process.env.WANXIANG_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    this.model = options.model ?? 'wanx-v1';
    this.defaultSize = options.defaultSize ?? '1024*1024';
    this.maxPollAttempts = options.maxPollAttempts ?? 6;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.logger = options.logger ?? console;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 生成图片：提交任务 + 轮询结果 */
  async generate(prompt: string, style?: string): Promise<ImageResult> {
    if (!this.apiKey) {
      return { url: null, error: '图片生成 key 未配置（WANXIANG_API_KEY / DASHSCOPE_API_KEY 均空）' };
    }

    // 1. 提交生成任务
    const submitResult = await this.submitTask(prompt, style);
    if (submitResult.error) {
      return submitResult;
    }
    const taskId = submitResult.taskId!;

    // 2. 轮询任务状态
    return this.pollTask(taskId);
  }

  /** 提交异步生成任务 */
  private async submitTask(prompt: string, style?: string): Promise<ImageResult> {
    const parameters: Record<string, unknown> = {
      size: this.defaultSize,
      n: 1,
    };
    if (style) {
      parameters.style = style;
    }

    const body = JSON.stringify({
      model: this.model,
      input: { prompt },
      parameters,
    });

    try {
      const res = await this.fetchImpl(SUBMIT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-DashScope-Async': 'enable',
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const errMsg = `万相提交任务失败 HTTP ${res.status}: ${text.slice(0, 200)}`;
        this.logger.error(errMsg);
        return { url: null, error: errMsg };
      }

      const data = (await res.json()) as SubmitResponse;
      if (data.code && data.code !== 'Success') {
        const errMsg = `万相提交任务错误: ${data.code} - ${data.message ?? ''}`;
        this.logger.error(errMsg);
        return { url: null, error: errMsg };
      }

      const taskId = data.output?.task_id;
      if (!taskId) {
        return { url: null, error: '万相响应缺少 task_id' };
      }

      this.logger.log(`[wanxiang] 任务已提交 taskId=${taskId}`);
      return { url: null, taskId };
    } catch (err) {
      const errMsg = `万相提交任务异常: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(errMsg);
      return { url: null, error: errMsg };
    }
  }

  /** 轮询任务状态直到成功或超时 */
  private async pollTask(taskId: string): Promise<ImageResult> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      await this.sleep(this.pollIntervalMs);

      try {
        const res = await this.fetchImpl(`${TASK_URL_PREFIX}${taskId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          this.logger.warn(`[wanxiang] 轮询失败 HTTP ${res.status}: ${text.slice(0, 100)}`);
          continue;
        }

        const data = (await res.json()) as TaskResponse;
        const status = data.output?.task_status;

        this.logger.log(`[wanxiang] 轮询 attempt=${attempt + 1} status=${status}`);

        if (status === 'SUCCEEDED') {
          const url = data.output?.results?.[0]?.url ?? null;
          if (!url) {
            return { url: null, taskId, error: '任务成功但结果缺少 URL' };
          }
          return { url, taskId };
        }

        if (status === 'FAILED') {
          const errMsg = data.message ?? data.code ?? '任务执行失败';
          return { url: null, taskId, error: `万相任务失败: ${errMsg}` };
        }

        // PENDING / RUNNING → 继续轮询
      } catch (err) {
        this.logger.warn(
          `[wanxiang] 轮询异常 attempt=${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { url: null, taskId, error: `万相任务超时：轮询 ${this.maxPollAttempts} 次未完成` };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
