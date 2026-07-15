/**
 * Unified image generation provider contract.
 */

export interface ImageResult {
  /** Generated image URL; null means no real image was produced. */
  url: string | null;
  /** Optional async task id from the provider. */
  taskId?: string;
  /** Provider or generation error. */
  error?: string;
  referenceUsed?: boolean;
  referenceStatus?: 'used' | 'unsupported' | 'unavailable' | 'skipped';
}

export interface ImageGenerateOptions {
  /** Public or provider-readable reference images, used only as generation guidance. */
  referenceImages?: string[];
  /** 与 referenceImages 同序的显式角色；不支持的 provider 可忽略，但不得伪报已使用。 */
  referenceRoles?: Array<{ url: string; role: 'style' | 'identity' | 'primary'; sourceIndex: number }>;
}

export interface ImageProvider {
  generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult>;
}
