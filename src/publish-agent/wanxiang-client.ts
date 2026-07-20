/**
 * 通义万相（Wanxiang）HTTP 客户端。
 *
 * 走 DashScope Wan 2.7 异步任务接口：
 * 1. POST 提交生成任务 → 返回 task_id
 * 2. GET 轮询任务状态（最多 6 次，间隔 5s，总超时约 30s）
 * 3. 状态为 SUCCEEDED 时获取结果 URL
 *
 * 文生图时提交 text content；带 referenceImages 时提交 image content + text content，
 * 由 Wan 2.7 真实消费参考图。参考图是否实际使用必须通过 referenceStatus 诚实回报。
 *
 * 仅依赖运行时全局 fetch（Node>=18），不引第三方 SDK，保持轻量。
 * 失败返回 { url: null, error } 不抛异常，调用方无需 try/catch。
 */

import type { ImageGenerateOptions, ImageProvider, ImageResult } from './image-provider.js';

// wan2.7-image-pro 异步文生图：image-generation/generation（messages 入参）；旧 wanx-v1 的 text2image/image-synthesis 已弃用。
const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation';
const TASK_URL_PREFIX = 'https://dashscope.aliyuncs.com/api/v1/tasks/';

export interface WanxiangClientOptions {
  /** API Key（默认读 env WANXIANG_API_KEY） */
  apiKey?: string;
  /** 模型名，默认 wan2.7-image-pro */
  model?: string;
  /**
   * 运行时模型名解析器（优先于 model）。注入后每次调用按需取当前配置，
   * 使后台改图片模型名无需重启即热加载生效（change console-model-provider-config）。
   */
  getModel?: () => string;
  /** 默认尺寸，默认 1024*1024（wan2.7 方式二显式像素，总像素 [768*768,4096*4096]、宽高比 [1:8,8:1]） */
  defaultSize?: string;
  /**
   * 参考图生成尺寸。Wan 2.7 在有图片输入且 size 为 1K/2K 时按最后一张输入图比例输出；
   * 默认 1K，在保持参考图比例的同时降低小红书多图发布的下载/上传负担；可经 env 显式恢复 2K。
   */
  referenceSize?: string;
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

/** 轮询任务响应（wan2.7：结果在 output.choices[].message.content[] 的 image 项） */
interface TaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    choices?: Array<{ message?: { content?: Array<{ image?: string; type?: string }> } }>;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

type WanxiangContentItem = { text: string } | { image: string };

export class WanxiangClient implements ImageProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly getModel?: () => string;
  private readonly defaultSize: string;
  private readonly referenceSize: string;
  private readonly maxPollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WanxiangClientOptions = {}) {
    // 万相文生图与 Qwen 同属百炼、同一 DashScope key；未单设 WANXIANG_API_KEY 时回退 DASHSCOPE_API_KEY。
    this.apiKey = options.apiKey ?? process.env.WANXIANG_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    this.model = options.model ?? 'wan2.7-image-pro';
    this.getModel = options.getModel;
    // 竖版 3:4（如 1152*1536，万相总像素 [768²,4096²] 内）经 env 激活、瞬间可回滚；代码默认保持方图不变。
    this.defaultSize = options.defaultSize ?? process.env.AIDCP_WANXIANG_IMAGE_SIZE ?? '1024*1024';
    this.referenceSize = options.referenceSize ?? process.env.AIDCP_WANXIANG_REFERENCE_IMAGE_SIZE ?? '1K';
    // wan2.7-image-pro 文生图常需 25~40s+（thinking_mode），6×5s=30s 太紧会超时降级；放宽到 18×5s=90s。
    this.maxPollAttempts = options.maxPollAttempts ?? 18;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.logger = options.logger ?? console;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 生成图片：提交任务 + 轮询结果 */
  async generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult> {
    const explicitRoles = Array.isArray(options?.referenceRoles) && options.referenceRoles.length > 0;
    const normalizedRoles = normalizeReferenceRoles(options?.referenceRoles, options?.referenceImages);
    // Wan 的 1K/2K 输出比例跟随最后一张输入图；辅助锚在前、primary 在最后。
    const referenceImages = normalizedRoles.map((item) => item.url);
    const referenceMode = referenceImages.length > 0;
    const withReferenceStatus = (result: ImageResult, status: NonNullable<ImageResult['referenceStatus']>): ImageResult =>
      referenceMode ? { ...result, referenceStatus: status, referenceUsed: status === 'used' } : result;
    if (!this.apiKey) {
      return withReferenceStatus(
        { url: null, error: '图片生成 key 未配置（WANXIANG_API_KEY / DASHSCOPE_API_KEY 均空）' },
        'unavailable',
      );
    }

    // 1. 提交生成任务
    const submitResult = await this.submitTask(prompt, style, normalizedRoles, explicitRoles);
    if (submitResult.error) {
      return withReferenceStatus(submitResult, 'unavailable');
    }
    const taskId = submitResult.taskId!;

    // 2. 轮询任务状态
    const result = await this.pollTask(taskId);
    return withReferenceStatus(result, result.url ? 'used' : 'unavailable');
  }

  /** 提交异步生成任务 */
  private async submitTask(
    prompt: string,
    style: string | undefined,
    references: Array<{ url: string; role: 'style' | 'identity' | 'primary'; sourceIndex: number }>,
    explicitRoles: boolean,
  ): Promise<ImageResult> {
    // wan2.7 无独立 style 参数：风格并入提示词文本。
    const roleGuide = explicitRoles && references.length > 0
      ? `参考图角色：${references.map((item, i) => `图${i + 1}=${item.role === 'primary' ? '本槽主参考，优先保持构图/主体关系' : item.role === 'identity' ? '身份一致性锚' : '整组抽象风格锚'}`).join('；')}。只做原创重构，不复制原图文字、水印或像素细节。`
      : '';
    const styledPrompt = style ? `${prompt}，风格：${style}` : prompt;
    const text = roleGuide ? `${roleGuide}\n${styledPrompt}` : styledPrompt;
    const content: WanxiangContentItem[] = [...references.map((item) => ({ image: item.url })), { text }];
    const parameters: Record<string, unknown> = {
      size: references.length > 0 ? this.referenceSize : this.defaultSize,
      n: 1,
      watermark: false,
    };

    const body = JSON.stringify({
      model: this.getModel?.() ?? this.model,
      input: { messages: [{ role: 'user', content }] },
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
          const content = data.output?.choices?.[0]?.message?.content ?? [];
          const url = content.find((c) => c.image)?.image ?? null;
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

function normalizeReferenceRoles(
  roles: ImageGenerateOptions['referenceRoles'],
  fallbackImages: ImageGenerateOptions['referenceImages'],
): Array<{ url: string; role: 'style' | 'identity' | 'primary'; sourceIndex: number }> {
  if (Array.isArray(roles) && roles.length > 0) {
    const seen = new Set<string>();
    const normalized = roles.flatMap((item, index) => {
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      if (!url || seen.has(url)) return [];
      seen.add(url);
      const role = item.role === 'style' || item.role === 'identity' || item.role === 'primary' ? item.role : 'style';
      const sourceIndex = Number.isInteger(item.sourceIndex) ? item.sourceIndex : index;
      return [{ url, role, sourceIndex }];
    }).slice(0, 9);
    return normalized.sort((a, b) => Number(a.role === 'primary') - Number(b.role === 'primary'));
  }
  return normalizeReferenceImages(fallbackImages).map((url, sourceIndex, all) => ({
    url,
    sourceIndex,
    role: sourceIndex === all.length - 1 ? 'primary' as const : 'style' as const,
  }));
}

function normalizeReferenceImages(images: string[] | undefined): string[] {
  return (images ?? []).map((image) => image.trim()).filter(Boolean).slice(0, 9);
}
