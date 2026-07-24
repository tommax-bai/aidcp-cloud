import type { PipelineFields, ReferenceImageSnapshot } from './publish-pipeline-types.js';

export const REFERENCE_IMAGE_MAX_COUNT = 9;

export function referenceImagesFromSnapshot(snapshot: Partial<PipelineFields>): ReferenceImageSnapshot[] {
  return snapshot.trigger?.generateInput?.referenceNote?.images ?? [];
}

export function referenceImageUrl(img: ReferenceImageSnapshot): string | null {
  const url = (img.ossUrl ?? img.sourceUrl ?? '').trim();
  return url ? url : null;
}

export function referenceImagesForGeneration(images: ReferenceImageSnapshot[]): ReferenceImageSnapshot[] {
  return images.filter((img) => referenceImageUrl(img)).slice(0, REFERENCE_IMAGE_MAX_COUNT);
}

export function buildReferenceImageGuidance(snapshot: Partial<PipelineFields>): string | null {
  const images = referenceImagesForGeneration(referenceImagesFromSnapshot(snapshot))
    .map((img) => ({ img, url: referenceImageUrl(img)! }));
  if (images.length === 0) return null;

  const lines = images.map(({ img, url }, i) => {
    const size = img.width && img.height ? `, size ${img.width}x${img.height}` : '';
    const alt = img.alt ? `, alt: ${img.alt}` : '';
    return `${i + 1}. ${url}${size}${alt}`;
  });
  return [
    'Reference images from the source note are available as visual guidance only.',
    'Do not copy, reuse, watermark, or publish the original images directly.',
    'Use them only to infer composition, subject framing, scene details, color/material cues, and information density.',
    ...lines,
  ].join('\n');
}
