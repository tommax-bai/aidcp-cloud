import type {
  ContentVisualBrief,
  ContentVisualCategoryBrief,
  ContentVisualCategoryKind,
  PortraitContentBrief,
} from './visual-reference-types.js';

export interface ContentVisualFallbackInput {
  subject: string;
  intent?: string;
  title: string;
  content: string;
  tone: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compactString(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function stringList(value: unknown, maxItems = 8, maxChars = 120): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => compactString(item, maxChars))
    .filter((item): item is string => !!item)
    .slice(0, maxItems);
}

function nonEmptyStringList(value: unknown, maxItems = 8, maxChars = 120): string[] | null {
  const list = stringList(value, maxItems, maxChars);
  return list?.length ? list : null;
}

function requiredStrings(o: Record<string, unknown>, keys: string[]): Record<string, string> | null {
  const entries = keys.map((key) => [key, compactString(o[key])] as const);
  return entries.some(([, value]) => !value) ? null : Object.fromEntries(entries) as Record<string, string>;
}

export function normalizeContentVisualCategoryBrief(value: unknown): ContentVisualCategoryBrief | undefined {
  const o = record(value);
  const kind = compactString(o?.kind, 40) as ContentVisualCategoryKind | null;
  if (!o || !kind) return undefined;
  switch (kind) {
    case 'portrait_photo': {
      const fields = requiredStrings(o, ['facialExpression', 'gazeDirection', 'headAngle', 'bodyLanguage', 'gesture', 'poseEnergy']);
      return fields ? { kind, ...fields } as PortraitContentBrief : undefined;
    }
    case 'text_layout': {
      const fields = requiredStrings(o, ['coreMessage', 'readingOrder', 'informationDensity', 'cardStructure']);
      const informationHierarchy = nonEmptyStringList(o.informationHierarchy, 6);
      const emphasisTerms = stringList(o.emphasisTerms, 8, 40);
      return fields && informationHierarchy && emphasisTerms
        ? { kind, ...fields, informationHierarchy, emphasisTerms } as ContentVisualCategoryBrief
        : undefined;
    }
    case 'infographic_chart': {
      const fields = requiredStrings(o, ['claim', 'relationship', 'direction', 'dataPolicy']);
      const entities = nonEmptyStringList(o.entities, 8);
      const steps = stringList(o.steps, 8);
      return fields && entities && steps ? { kind, ...fields, entities, steps } as ContentVisualCategoryBrief : undefined;
    }
    case 'scene_photo': {
      const fields = requiredStrings(o, ['timeAndWeather', 'location', 'humanPresence', 'eventTrace', 'spatialRelationship', 'motionLevel']);
      return fields ? { kind, ...fields } as ContentVisualCategoryBrief : undefined;
    }
    case 'still_life_photo': {
      const fields = requiredStrings(o, ['usageState', 'objectRelationship', 'lifeTrace', 'materialFocus', 'handInteraction']);
      const primaryObjects = nonEmptyStringList(o.primaryObjects, 8);
      return fields && primaryObjects ? { kind, ...fields, primaryObjects } as ContentVisualCategoryBrief : undefined;
    }
    case 'illustration_3d': {
      const fields = requiredStrings(o, ['coreMetaphor', 'characterRelationship', 'motionDirection', 'exaggerationLevel', 'storyStage']);
      const symbols = stringList(o.symbols, 8);
      return fields && symbols ? { kind, ...fields, symbols } as ContentVisualCategoryBrief : undefined;
    }
    case 'ui_document': {
      const fields = requiredStrings(o, ['userTask', 'interfaceState', 'informationFocus', 'fidelityLabel']);
      const componentHierarchy = nonEmptyStringList(o.componentHierarchy, 8);
      const interactionPath = nonEmptyStringList(o.interactionPath, 8);
      return fields && componentHierarchy && interactionPath
        ? { kind, ...fields, componentHierarchy, interactionPath } as ContentVisualCategoryBrief
        : undefined;
    }
    case 'collage_mixed': {
      const fields = requiredStrings(o, ['readingOrder', 'primarySecondaryRatio']);
      const continuityElements = stringList(o.continuityElements, 8);
      const rawRegions = Array.isArray(o.regions) ? o.regions : null;
      if (!fields || !continuityElements || !rawRegions) return undefined;
      const regions = rawRegions.slice(0, 8).map((item) => {
        const region = record(item);
        const values = region ? requiredStrings(region, ['role', 'content', 'priority']) : null;
        return values ? { role: values.role, content: values.content, priority: values.priority } : null;
      }).filter((item): item is { role: string; content: string; priority: string } => !!item);
      return regions.length > 0 ? { kind, ...fields, regions, continuityElements } as ContentVisualCategoryBrief : undefined;
    }
    default:
      return undefined;
  }
}

function mirrorPortrait(brief: ContentVisualBrief): ContentVisualBrief {
  const category = brief.categoryBrief;
  if (category?.kind !== 'portrait_photo') return brief;
  return {
    ...brief,
    facialExpression: category.facialExpression,
    gazeDirection: category.gazeDirection,
    headAngle: category.headAngle,
    bodyLanguage: category.bodyLanguage,
  };
}

export function normalizeContentVisualBrief(value: unknown): ContentVisualBrief | undefined {
  const o = record(value);
  if (!o) return undefined;
  const narrativeMoment = compactString(o.narrativeMoment);
  const emotion = compactString(o.emotion);
  const action = compactString(o.action);
  const environment = compactString(o.environment);
  const intensity = Number(o.emotionIntensity);
  if (!narrativeMoment || !emotion || !action || !environment || !Number.isFinite(intensity)) return undefined;
  const avoid = stringList(o.avoid, 8) ?? [];
  const optional = (key: string): string | undefined => compactString(o[key]) ?? undefined;
  const facialExpression = optional('facialExpression');
  const gazeDirection = optional('gazeDirection');
  const headAngle = optional('headAngle');
  const bodyLanguage = optional('bodyLanguage');
  const categoryBrief = normalizeContentVisualCategoryBrief(o.categoryBrief);
  return mirrorPortrait({
    narrativeMoment,
    emotion,
    emotionIntensity: Math.max(0, Math.min(1, intensity)),
    action,
    environment,
    ...(facialExpression ? { facialExpression } : {}),
    ...(gazeDirection ? { gazeDirection } : {}),
    ...(headAngle ? { headAngle } : {}),
    ...(bodyLanguage ? { bodyLanguage } : {}),
    ...(categoryBrief ? { categoryBrief } : {}),
    avoid,
  });
}

export function inferContentVisualKind(context: string): ContentVisualCategoryKind {
  if (/文字卡|知识卡|海报|卡片|大标题|金句|清单|要点排版|图文页/.test(context)) return 'text_layout';
  if (/信息图|图表|曲线|柱状|趋势|数据可视化|流程图|关系图|对比图/.test(context)) return 'infographic_chart';
  if (/UI|界面|页面|应用截图|软件截图|文档截图|控制台|仪表盘|操作路径/i.test(context)) return 'ui_document';
  if (/拼贴|混合排版|多栏|分镜|九宫格|分区画面/.test(context)) return 'collage_mixed';
  if (/插画|手绘|3D|三维|卡通|概念隐喻|视觉隐喻/.test(context)) return 'illustration_3d';
  if (/静物|产品图|物件|桌面摆放|餐具|食物特写|器材|好物/.test(context)) return 'still_life_photo';
  if (/人物|人像|访谈|肖像|男生|女生|男人|女人|主人公|面部|表情/.test(context)) return 'portrait_photo';
  return 'scene_photo';
}

function nonEmpty(values: Array<string | undefined>, max = 8): string[] {
  return [...new Set(values.map((item) => item?.trim()).filter((item): item is string => !!item))].slice(0, max);
}

function fallbackCategoryBrief(
  kind: ContentVisualCategoryKind,
  brief: ContentVisualBrief,
  input: ContentVisualFallbackInput,
): ContentVisualCategoryBrief {
  const point = input.intent || brief.narrativeMoment || input.subject;
  switch (kind) {
    case 'portrait_photo':
      return {
        kind,
        facialExpression: brief.facialExpression || '眉眼与嘴角准确呈现正文复合情绪，不使用无关商业微笑',
        gazeDirection: brief.gazeDirection || '视线方向服务叙事，不默认僵硬直视镜头',
        headAngle: brief.headAngle || '头部自然偏转，避免证件照式完全正面',
        bodyLanguage: brief.bodyLanguage || '肩颈和身体重心体现正文张力',
        gesture: '手势与正文动作一致，不做无意义摆拍手势',
        poseEnergy: `姿态能量与“${brief.emotion}”及强度 ${brief.emotionIntensity} 一致`,
      };
    case 'text_layout':
      return {
        kind,
        coreMessage: point,
        informationHierarchy: nonEmpty([input.subject, input.intent, brief.action]),
        emphasisTerms: nonEmpty([input.subject, input.intent], 5),
        readingOrder: '标题→核心结论→支撑要点，顺序阅读即可理解正文主线',
        informationDensity: '与正文信息量匹配，避免只有大标题和无意义大面积留白',
        cardStructure: '封面结论区 + 2~5 个正文要点区，层级清晰且不硬凑',
      };
    case 'infographic_chart':
      return {
        kind,
        claim: point,
        relationship: '只表达正文明确存在的因果、步骤、对比、结构或趋势关系',
        entities: nonEmpty([input.subject, input.intent]),
        direction: '按正文叙事顺序从条件/原因走向结果/结论',
        steps: nonEmpty([brief.action]),
        dataPolicy: '仅使用正文明确出现且语义可靠的数字；没有数字时使用无数值关系图，禁止编造比例和坐标值',
      };
    case 'scene_photo':
      return {
        kind,
        timeAndWeather: '时间与天气服务正文氛围，不随机添加戏剧化天气',
        location: brief.environment,
        humanPresence: '仅在正文叙事需要时出现人物，并说明其与事件的关系',
        eventTrace: brief.action,
        spatialRelationship: '前景事件线索、中景主体、背景环境形成清楚的叙事空间关系',
        motionLevel: `动态程度与情绪强度 ${brief.emotionIntensity} 一致`,
      };
    case 'still_life_photo':
      return {
        kind,
        primaryObjects: nonEmpty([input.subject]),
        usageState: brief.action,
        objectRelationship: '物件之间呈现正文明确的使用或比较关系，不做无关陈列',
        lifeTrace: '保留适度真实使用痕迹，避免样板间式空洞摆拍',
        materialFocus: '材质重点服务核心物件与正文体验',
        handInteraction: '仅在正文动作需要时出现手部互动，手势自然且功能明确',
      };
    case 'illustration_3d':
      return {
        kind,
        coreMetaphor: point,
        characterRelationship: '角色或元素关系对应正文主张，不增加无来源冲突',
        symbols: nonEmpty([input.subject, input.intent]),
        motionDirection: '视觉动势沿正文从问题/冲突走向行动/结论',
        exaggerationLevel: '只为强化正文情绪适度夸张，不改变事实含义',
        storyStage: brief.narrativeMoment,
      };
    case 'ui_document':
      return {
        kind,
        userTask: point,
        interfaceState: brief.action,
        componentHierarchy: nonEmpty([input.subject, input.intent, '主任务区', '状态反馈区']),
        interactionPath: nonEmpty([brief.action]),
        informationFocus: input.intent || input.subject,
        fidelityLabel: '正文未明确证明为真实产品功能时，按概念界面示意，不暗示已上线能力',
      };
    case 'collage_mixed':
      return {
        kind,
        regions: [
          { role: '主叙事区', content: point, priority: 'high' },
          { role: '支撑区', content: brief.action, priority: 'medium' },
        ],
        readingOrder: '先主叙事区，再按正文顺序阅读支撑区',
        primarySecondaryRatio: '主区明显大于支撑区，避免所有区域同权争抢注意力',
        continuityElements: nonEmpty([brief.emotion, input.subject]),
      };
  }
}

export function ensureContentVisualCategory(
  brief: ContentVisualBrief,
  input: ContentVisualFallbackInput,
  forcedKind?: ContentVisualCategoryKind,
): ContentVisualBrief {
  const context = `${input.subject} ${input.intent ?? ''} ${input.title} ${input.content.slice(0, 1000)}`;
  const kind = forcedKind ?? brief.categoryBrief?.kind ?? inferContentVisualKind(context);
  const categoryBrief = brief.categoryBrief?.kind === kind ? brief.categoryBrief : fallbackCategoryBrief(kind, brief, input);
  return mirrorPortrait({ ...brief, categoryBrief });
}

export function createFallbackContentVisualBrief(
  input: ContentVisualFallbackInput,
  forcedKind?: ContentVisualCategoryKind,
): ContentVisualBrief {
  const base: ContentVisualBrief = {
    narrativeMoment: input.intent || input.subject,
    emotion: input.tone || '与正文语气一致',
    emotionIntensity: 0.5,
    action: input.intent || `自然呈现${input.subject}`,
    environment: '与正文叙事语境一致',
    avoid: ['与正文无关的摆拍、装饰或功能暗示'],
  };
  const enriched = ensureContentVisualCategory(base, input, forcedKind);
  return enriched.categoryBrief?.kind === 'portrait_photo'
    ? { ...enriched, avoid: ['证件照式正面端坐', '标准商业微笑', '僵硬直视镜头', '与正文无关的摆拍'] }
    : enriched;
}

export const CONTENT_VISUAL_CATEGORY_LABELS: Record<ContentVisualCategoryKind, string> = {
  portrait_photo: '人物摄影',
  text_layout: '文字卡/海报',
  infographic_chart: '图表信息图',
  scene_photo: '场景摄影',
  still_life_photo: '静物摄影',
  illustration_3d: '插画/3D',
  ui_document: 'UI/文档',
  collage_mixed: '混合拼贴',
};

export function formatContentVisualCategoryBrief(category: ContentVisualCategoryBrief): string {
  switch (category.kind) {
    case 'portrait_photo': return `类型=人物摄影；表情=${category.facialExpression}；视线=${category.gazeDirection}；头部=${category.headAngle}；肢体=${category.bodyLanguage}；手势=${category.gesture}；姿态能量=${category.poseEnergy}`;
    case 'text_layout': return `类型=文字卡；核心结论=${category.coreMessage}；信息层级=${category.informationHierarchy.join('→')}；重点词=${category.emphasisTerms.join('、') || '无'}；阅读顺序=${category.readingOrder}；密度=${category.informationDensity}；卡片结构=${category.cardStructure}`;
    case 'infographic_chart': return `类型=图表信息图；主张=${category.claim}；关系=${category.relationship}；对象=${category.entities.join('、')}；方向=${category.direction}；步骤=${category.steps.join('→') || '无'}；数据政策=${category.dataPolicy}`;
    case 'scene_photo': return `类型=场景摄影；时间天气=${category.timeAndWeather}；地点=${category.location}；人物存在=${category.humanPresence}；事件痕迹=${category.eventTrace}；空间关系=${category.spatialRelationship}；动态=${category.motionLevel}`;
    case 'still_life_photo': return `类型=静物摄影；核心物件=${category.primaryObjects.join('、')}；使用状态=${category.usageState}；物件关系=${category.objectRelationship}；生活痕迹=${category.lifeTrace}；材质重点=${category.materialFocus}；手部互动=${category.handInteraction}`;
    case 'illustration_3d': return `类型=插画/3D；核心隐喻=${category.coreMetaphor}；角色关系=${category.characterRelationship}；象征物=${category.symbols.join('、') || '无'}；动势=${category.motionDirection}；夸张度=${category.exaggerationLevel}；叙事阶段=${category.storyStage}`;
    case 'ui_document': return `类型=UI/文档；用户任务=${category.userTask}；界面状态=${category.interfaceState}；组件层级=${category.componentHierarchy.join('→')}；操作路径=${category.interactionPath.join('→')}；信息重点=${category.informationFocus}；真实性边界=${category.fidelityLabel}`;
    case 'collage_mixed': return `类型=混合拼贴；分区=${category.regions.map((item) => `${item.role}:${item.content}(${item.priority})`).join('；')}；阅读顺序=${category.readingOrder}；主次比例=${category.primarySecondaryRatio}；连续元素=${category.continuityElements.join('、') || '无'}`;
  }
}

export function categorySafetyInstruction(category: ContentVisualCategoryBrief): string {
  switch (category.kind) {
    case 'infographic_chart': return '不得编造正文没有的数字、百分比、样本量、坐标或统计结论；无可靠数字时改用无数值关系图。';
    case 'ui_document': return '不得虚构正文未支持的已上线产品能力；概念设计必须保持概念示意语义。';
    case 'text_layout': return '只使用洗稿后正文语义组织信息层级，不读取或复制来源图文字，不用空泛大标题代替正文要点。';
    case 'portrait_photo': return '人物表演服从正文，身份与来源真人/名人彻底解耦。';
    default: return '具体事件、物件状态、隐喻或分区必须来自正文，不添加无来源事实。';
  }
}
