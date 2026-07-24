/**
 * 参考图视觉分析的**纯文本指令构建段**（change decouple-behavior-class-ports 析出）。
 *
 * 从 src/publish-agent/visual-reference-analyzer.ts（content）抬出：`buildVisualReferenceSetPrompt`
 * 与 `buildVisualReferenceSpecialistPrompt` 两个纯函数（入参→视觉模型文本指令，零 LLM 调用 / 零连库 /
 * 零进程内活状态），仅 import kernel 视觉参考类型/枚举。分析服务 `createVisualReferenceAnalyzer`、
 * 多模态调用、解析/缓存留原文件（content），并从 kernel 等值再导出、行为逐字不变。
 * 供 api 侧静态 prompt 预览跨边界共导，消 1 条 api->content 边。满足 §4.7 kernel 准入。
 */
import { REFERENCE_VISUAL_KINDS, type VisualFrameDetails } from './visual-reference-types.js';

export function buildVisualReferenceSetPrompt(): string {
  return `你是整组视觉参考分析师。分析按顺序给出的图片，严格只输出一个 JSON 对象。
目标：轻量判断整组视觉语言、风格簇、顺序角色和每张视觉类型。逐图构图细节由下一阶段专家补齐，本轮禁止输出 common/details，以降低大图集延迟。禁止 OCR，禁止抄写或概括图片中的具体文字/数值/账号/水印；禁止猜摄影师、相机型号或精确 EXIF。

视觉类型只能是：${REFERENCE_VISUAL_KINDS.join(' | ')}。
输出：
{"setStyleBible":{"summary":"","palette":[],"colorTemperature":"warm|cool|neutral|mixed","contrast":"low|medium|high|mixed","visualDensity":"sparse|balanced|dense|mixed","whitespace":"","hierarchy":"","mood":[],"texture":[],"continuityRules":[],"avoid":[]},"styleClusters":[{"id":"c1","label":"","frameIndexes":[0],"summary":"","palette":[],"traits":[]}],"frames":[{"sourceArrayIndex":0,"kind":"...","confidence":0.0,"clusterId":"c1","sequenceRole":"cover|detail|step|comparison|summary|support"}]}
frames 必须与输入图片等量且 sourceArrayIndex 覆盖 0..N-1。`;
}

export function buildVisualReferenceSpecialistPrompt(family: VisualFrameDetails['family'], indexes: number[]): string {
  const schemas: Record<VisualFrameDetails['family'], string> = {
    photo: '{"family":"photo","cameraAngle":"","focalLengthFeel":"只给观感/区间，不猜型号","depthOfField":"","focus":"","light":"自然光/硬光/柔光/逆光等","colorGrade":"","grainSharpness":"","facialExpression":"人物可观察眉眼与嘴角；无人则写无人物","gazeDirection":"视线方向；无人则写不适用","headAngle":"头部角度；无人则写不适用","bodyPose":"身体姿态；无人则写不适用","gesture":"手势/动作；无人则写不适用","poseEnergy":"静态/松弛/紧绷/动态等可观察能量","emotionalValence":"正向/中性/负向的可观察效价，不猜内心","emotionalArousal":"低/中/高唤醒度的可观察表现"}',
    illustration: '{"family":"illustration","medium":"","strokeOrRender":"","shapeLanguage":"","outline":"","materials":"","lightingModel":"","perspective":"","detailLevel":""}',
    text_layout: '{"family":"text_layout","grid":"","textBlockRatio":"","hierarchy":"","alignment":"","weightContrast":"","colorBlocks":"","decorations":""}',
    ui_document: '{"family":"ui_document","viewport":"","grid":"","componentDensity":"","bordersRadius":"","informationZones":"","depth":"","background":""}',
    infographic: '{"family":"infographic","chartType":"","encodings":[],"axesLegend":"","annotationDensity":"","dataInkRatio":"","narrativeOrder":""}',
    collage: '{"family":"collage","regions":[{"region":"","kind":"视觉类型枚举","role":""}],"layering":"","overlap":"","unifyingTreatment":""}',
  };
  const common = '{"aspectRatio":"","subject":"只描述视觉主体，不引用图中文字","composition":"","focalHierarchy":"","palette":[],"lightingOrContrast":"","negativeSpace":"","texture":"","mood":"","avoid":[]}';
  return `你是 ${family} 视觉结构专家。只分析标签中的 sourceArrayIndex=${indexes.join(',')}，严格返回 JSON：{"frames":[{"sourceArrayIndex":0,"common":${common},"details":${schemas[family]}}]}。
禁止 OCR、禁止输出图片具体文字/数值/账号/水印。摄影只能描述可观察观感，不猜相机型号、摄影师或精确 EXIF。frames 必须与本组图片等量。`;
}
