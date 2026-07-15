/**
 * 参照洗稿的整组视觉语义。刻意与 OCR/原图文字转写分离：这里描述视觉结构，不承载原图具体文案。
 */

export const VISUAL_ANALYSIS_SCHEMA_VERSION = 'visual-reference-v3';

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
  /** 人物摄影的可观察表演；无人画面使用“无人物/不适用”，不得猜内心或身份。 */
  facialExpression: string;
  gazeDirection: string;
  headAngle: string;
  bodyPose: string;
  gesture: string;
  poseEnergy: string;
  emotionalValence: string;
  emotionalArousal: string;
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

export type ContentVisualCategoryKind = ReferenceVisualKind;

export const VISUAL_SLOT_ROLES = [
  'cover_hook',
  'context',
  'problem',
  'explanation',
  'evidence',
  'process',
  'contrast',
  'action',
  'conclusion',
] as const;

export type VisualSlotRole = (typeof VISUAL_SLOT_ROLES)[number];

export interface VisualSetBrief {
  narrativeArc: string;
  continuityRules: string[];
  typeMixRationale: string;
  /** model=模型完整返回；fallback=缺失/非法/失败后的确定性保守策略。 */
  source: 'model' | 'fallback';
}

export interface PortraitContentBrief {
  kind: 'portrait_photo';
  facialExpression: string;
  gazeDirection: string;
  headAngle: string;
  bodyLanguage: string;
  gesture: string;
  poseEnergy: string;
}

export interface TextLayoutContentBrief {
  kind: 'text_layout';
  coreMessage: string;
  informationHierarchy: string[];
  emphasisTerms: string[];
  readingOrder: string;
  informationDensity: string;
  cardStructure: string;
}

export interface InfographicContentBrief {
  kind: 'infographic_chart';
  claim: string;
  relationship: string;
  entities: string[];
  direction: string;
  steps: string[];
  dataPolicy: string;
}

export interface ScenePhotoContentBrief {
  kind: 'scene_photo';
  timeAndWeather: string;
  location: string;
  humanPresence: string;
  eventTrace: string;
  spatialRelationship: string;
  motionLevel: string;
}

export interface StillLifeContentBrief {
  kind: 'still_life_photo';
  primaryObjects: string[];
  usageState: string;
  objectRelationship: string;
  lifeTrace: string;
  materialFocus: string;
  handInteraction: string;
}

export interface IllustrationContentBrief {
  kind: 'illustration_3d';
  coreMetaphor: string;
  characterRelationship: string;
  symbols: string[];
  motionDirection: string;
  exaggerationLevel: string;
  storyStage: string;
}

export interface UiDocumentContentBrief {
  kind: 'ui_document';
  userTask: string;
  interfaceState: string;
  componentHierarchy: string[];
  interactionPath: string[];
  informationFocus: string;
  fidelityLabel: string;
}

export interface CollageContentRegion {
  role: string;
  content: string;
  priority: string;
}

export interface CollageContentBrief {
  kind: 'collage_mixed';
  regions: CollageContentRegion[];
  readingOrder: string;
  primarySecondaryRatio: string;
  continuityElements: string[];
}

export type ContentVisualCategoryBrief =
  | PortraitContentBrief
  | TextLayoutContentBrief
  | InfographicContentBrief
  | ScenePhotoContentBrief
  | StillLifeContentBrief
  | IllustrationContentBrief
  | UiDocumentContentBrief
  | CollageContentBrief;

/**
 * 发布正文为单个配图槽给出的视觉导演 brief。参照洗稿时参考图管形式/风格，本 brief 管具体叙事语义；
 * 自主创作时本 brief 与槽位职责共同构成内容真源。所有字段只来自最终正文，不承载来源图片 OCR、身份或像素信息。
 */
export interface ContentVisualBrief {
  narrativeMoment: string;
  emotion: string;
  emotionIntensity: number;
  action: string;
  environment: string;
  facialExpression?: string;
  gazeDirection?: string;
  headAngle?: string;
  bodyLanguage?: string;
  /** 按目标画面类型承载专用内容语义；历史记录可缺省。 */
  categoryBrief?: ContentVisualCategoryBrief;
  avoid: string[];
}

export interface VisualAuditScores {
  form: number;
  subject: number;
  composition: number;
  color: number;
  style: number;
  /** 有 contentVisualBrief 时存在；历史记录与无 brief 路径可缺省。 */
  contentAlignment?: number;
}

export interface VisualAuditRisks {
  recognizableRealPerson: boolean;
  garbledText: boolean;
  watermark: boolean;
  copiedText: boolean;
  /** 无来源图的原创内容审计不能判断“是否复制来源”，必须显式标不适用。历史记录缺省视为 evaluated。 */
  copyCheck?: 'evaluated' | 'not_applicable';
  originalityRisk: 'low' | 'medium' | 'high';
}

export type VisualAuditMode = 'reference_fidelity' | 'content_alignment' | 'skipped';

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
  auditMode: VisualAuditMode;
  /** 本槽在整组叙事中的职责；历史/洗稿旧记录可缺省。 */
  slotRole?: VisualSlotRole;
  route: VisualGenerationRoute;
  styleSource: 'reference_analysis' | 'category_fallback';
  binding: VisualReferenceBinding;
  providerReferenceStatus: 'used' | 'unsupported' | 'unavailable' | 'skipped';
  outputUrl: string | null;
  finalStatus: 'passed' | 'failed' | 'unverified' | 'skipped' | 'discarded';
  attempts: VisualAuditAttempt[];
  /** 本槽正文视觉导演 brief；历史记录可缺省。 */
  contentVisualBrief?: ContentVisualBrief;
}

export interface VisualReferenceAudit {
  analysisStatus: VisualAnalysisStatus;
  analysisCacheKey: string | null;
  bindingMode: 'slot' | 'legacy_all' | 'none';
  auditEnabled: boolean;
  /** 自主创作的文章级图集策略；历史和参照洗稿可缺省。 */
  visualSetBrief?: VisualSetBrief;
  slots: VisualSlotAudit[];
}
