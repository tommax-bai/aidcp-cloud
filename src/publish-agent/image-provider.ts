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
}

export interface ImageProvider {
  generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult>;
}
