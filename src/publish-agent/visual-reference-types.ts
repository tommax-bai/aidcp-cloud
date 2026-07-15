/**
 * 参照洗稿的整组视觉语义。刻意与 OCR/原图文字转写分离：这里描述视觉结构，不承载原图具体文案。
 */

export const VISUAL_ANALYSIS_SCHEMA_VERSION = 'visual-reference-v2';

export const REFERENCE_VISUAL_KINDS = [
  'portrait_photo',
  'still_life_photo',
  'scene_photo',
  'illustration_3d',
  'text_layout',
  'ui_document',
  'infographic_chart',
  'collage_mixed',
] as const;

export type ReferenceVisualKind = (typeof REFERENCE_VISUAL_KINDS)[number];
export type VisualAnalysisStatus = 'disabled' | 'none' | 'analyzed' | 'partial' | 'unavailable';

export interface VisualStyleBible {
  summary: string;
  palette: string[];
  colorTemperature: 'warm' | 'cool' | 'neutral' | 'mixed';
  contrast: 'low' | 'medium' | 'high' | 'mixed';
  visualDensity: 'sparse' | 'balanced' | 'dense' | 'mixed';
  whitespace: string;
  hierarchy: string;
  mood: string[];
  texture: string[];
  continuityRules: string[];
  avoid: string[];
}

export interface VisualStyleCluster {
  id: string;
  label: string;
  frameIndexes: number[];
  summary: string;
  palette: string[];
  traits: string[];
}

export interface VisualFrameCommon {
  aspectRatio: string;
  subject: string;
  composition: string;
  focalHierarchy: string;
  palette: string[];
  lightingOrContrast: string;
  negativeSpace: string;
  texture: string;
  mood: string;
  avoid: string[];
}

export interface PhotoVisualDetails {
  family: 'photo';
  cameraAngle: string;
  focalLengthFeel: string;
  depthOfField: string;
  focus: string;
  light: string;
  colorGrade: string;
  grainSharpness: string;
}

export interface IllustrationVisualDetails {
  family: 'illustration';
  medium: string;
  strokeOrRender: string;
  shapeLanguage: string;
  outline: string;
  materials: string;
  lightingModel: string;
  perspective: string;
  detailLevel: string;
}

export interface TextLayoutVisualDetails {
  family: 'text_layout';
  grid: string;
  textBlockRatio: string;
  hierarchy: string;
  alignment: string;
  weightContrast: string;
  colorBlocks: string;
  decorations: string;
}

export interface UiDocumentVisualDetails {
  family: 'ui_document';
  viewport: string;
  grid: string;
  componentDensity: string;
  bordersRadius: string;
  informationZones: string;
  depth: string;
  background: string;
}

export interface InfographicVisualDetails {
  family: 'infographic';
  chartType: string;
  encodings: string[];
  axesLegend: string;
  annotationDensity: string;
  dataInkRatio: string;
  narrativeOrder: string;
}

export interface CollageVisualDetails {
  family: 'collage';
  regions: Array<{ region: string; kind: ReferenceVisualKind; role: string }>;
  layering: string;
  overlap: string;
  unifyingTreatment: string;
}

export type VisualFrameDetails =
  | PhotoVisualDetails
  | IllustrationVisualDetails
  | TextLayoutVisualDetails
  | UiDocumentVisualDetails
  | InfographicVisualDetails
  | CollageVisualDetails;

export interface VisualFrameSpec {
  /** 在本次有效参照图数组中的位置；绑定 provider 时以此为准。 */
  sourceArrayIndex: number;
  /** 源快照自带 index，仅作可读审计。 */
  sourceIndex: number;
  kind: ReferenceVisualKind;
  confidence: number;
  clusterId: string;
  sequenceRole: 'cover' | 'detail' | 'step' | 'comparison' | 'summary' | 'support';
  common: VisualFrameCommon;
  details: VisualFrameDetails;
}

export interface ReferenceVisualAnalysis {
  status: VisualAnalysisStatus;
  schemaVersion: string;
  cacheKey: string | null;
  provider: string | null;
  model: string | null;
  analyzedAt: number | null;
  sourceCount: number;
  /** analyzed/partial 时存在；失败时绝不填假摘要。 */
  setStyleBible?: VisualStyleBible;
  styleClusters?: VisualStyleCluster[];
  frameSpecs?: VisualFrameSpec[];
  error?: string;
}

export type VisualReferenceRole = 'style' | 'identity' | 'primary';

export interface VisualReferenceBindingItem {
  sourceArrayIndex: number;
  sourceIndex: number;
  url: string;
  role: VisualReferenceRole;
}

export interface VisualReferenceBinding {
  slot: number;
  mode: 'slot' | 'legacy_all';
  references: VisualReferenceBindingItem[];
  primarySourceArrayIndex: number | null;
  primarySourceIndex: number | null;
}

export type VisualGenerationRoute =
  | 'generative'
  | 'deterministic_text_card'
  | 'specialized_generative'
  | 'region_guided_generative';

export interface VisualAuditScores {
  form: number;
  subject: number;
  composition: number;
  color: number;
  style: number;
}

export interface VisualAuditRisks {
  recognizableRealPerson: boolean;
  garbledText: boolean;
  watermark: boolean;
  copiedText: boolean;
  originalityRisk: 'low' | 'medium' | 'high';
}

export interface VisualAuditAttempt {
  status: 'passed' | 'failed' | 'unverified' | 'skipped';
  scores?: VisualAuditScores;
  risks?: VisualAuditRisks;
  reason: string;
  retryGuidance?: string;
  auditedAt: number;
}

export interface VisualSlotAudit {
  slot: number;
  route: VisualGenerationRoute;
  styleSource: 'reference_analysis' | 'category_fallback';
  binding: VisualReferenceBinding;
  providerReferenceStatus: 'used' | 'unsupported' | 'unavailable' | 'skipped';
  outputUrl: string | null;
  finalStatus: 'passed' | 'failed' | 'unverified' | 'skipped' | 'discarded';
  attempts: VisualAuditAttempt[];
}

export interface VisualReferenceAudit {
  analysisStatus: VisualAnalysisStatus;
  analysisCacheKey: string | null;
  bindingMode: 'slot' | 'legacy_all' | 'none';
  auditEnabled: boolean;
  slots: VisualSlotAudit[];
}
