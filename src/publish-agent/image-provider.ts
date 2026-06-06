/**
 * 图片生成抽象接口。
 *
 * 定义统一的图片生成结果与提供者契约，便于替换具体实现
 * （如通义万相、DALL-E 等）。
 */

/** 图片生成结果 */
export interface ImageResult {
  /** 生成的图片 URL，失败为 null */
  url: string | null;
  /** 异步任务 ID */
  taskId?: string;
  /** 错误信息 */
  error?: string;
}

/** 图片提供者接口 */
export interface ImageProvider {
  generate(prompt: string, style?: string): Promise<ImageResult>;
}
