/**
 * Soul 配置加载器：读取 soul 文本 → 校验 → 强类型 Soul。
 *
 * - 默认从本模块同目录的 soul.yaml 读取（随源码分发）。注意（persona-driven-content-pipeline）：
 *   soul.yaml 已不是任何账号的默认/兜底人设——仅作面板编辑起点模板与 prompt 预览示例人设；
 * - 解析用自带的极简 YAML 解析器（yaml.ts），不引第三方依赖；
 * - 严格校验必填字段与类型，缺失/类型错直接抛错（fail-fast，避免运行期人设残缺）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYaml, type YamlValue } from '../kernel/yaml.js';
import type {
  Soul,
  SoulIdentity,
  SoulInterests,
  EngagementRules,
  MandatoryInteractionAction,
  MandatoryCommentApproval,
  MandatoryInteractionRule,
  BrowsePatterns,
  BrowseStateDef,
  StateTransition,
  SessionLimits,
  SearchSource,
  BehaviorGuidelines,
  LikeAffinity,
  WritingLanguage,
} from '../kernel/soul-types.js';
import { LIKE_AFFINITY_VALUES } from '../kernel/like-affinity.js';
import { isWritingLanguage } from './writing-language.js';

const MANDATORY_INTERACTION_ACTIONS = new Set<MandatoryInteractionAction>(['like', 'comment']);
const MANDATORY_COMMENT_APPROVALS = new Set<MandatoryCommentApproval>(['review', 'auto_approve']);
const MAX_MANDATORY_INTERACTION_RULES = 8;
const MAX_MANDATORY_RULE_TEXT_LENGTH = 500;
const LIKE_AFFINITIES = new Set<LikeAffinity>(LIKE_AFFINITY_VALUES);

const SEARCH_SOURCES: SearchSource[] = [
  'extract_from_liked',
  'random_from_interests',
  'new_concept',
];

function isRecord(v: YamlValue): v is { [k: string]: YamlValue } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function reqString(obj: { [k: string]: YamlValue }, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`soul 配置缺少字符串字段 ${path}.${key}`);
  }
  return v;
}

function reqNumber(obj: { [k: string]: YamlValue }, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`soul 配置缺少数字字段 ${path}.${key}`);
  }
  return v;
}

function reqStringArray(obj: { [k: string]: YamlValue }, key: string, path: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`soul 配置字段 ${path}.${key} 必须是字符串数组`);
  }
  return v as string[];
}

function reqObject(
  obj: { [k: string]: YamlValue },
  key: string,
  path: string,
): { [k: string]: YamlValue } {
  const v = obj[key];
  if (!isRecord(v)) {
    throw new Error(`soul 配置字段 ${path}.${key} 必须是对象`);
  }
  return v;
}

function parseIdentity(v: YamlValue): SoulIdentity {
  if (!isRecord(v)) throw new Error('soul.identity 必须是对象');
  return {
    name: reqString(v, 'name', 'identity'),
    role: reqString(v, 'role', 'identity'),
    background: reqString(v, 'background', 'identity'),
    tone: reqString(v, 'tone', 'identity'),
  };
}

function parseInterests(v: YamlValue): SoulInterests {
  if (!isRecord(v)) throw new Error('soul.interests 必须是对象');
  return {
    primary: reqStringArray(v, 'primary', 'interests'),
    secondary: reqStringArray(v, 'secondary', 'interests'),
    seed_keywords: reqStringArray(v, 'seed_keywords', 'interests'),
  };
}

function parseEngagementRules(v: YamlValue): EngagementRules {
  if (!isRecord(v)) throw new Error('soul.engagement_rules 必须是对象');
  return {
    like: reqStringArray(v, 'like', 'engagement_rules'),
    skip: reqStringArray(v, 'skip', 'engagement_rules'),
    comment_trigger: reqStringArray(v, 'comment_trigger', 'engagement_rules'),
  };
}

function parseMandatoryInteractions(v: YamlValue): MandatoryInteractionRule[] {
  if (!Array.isArray(v)) throw new Error('soul.mandatory_interactions 必须是数组');
  if (v.length > MAX_MANDATORY_INTERACTION_RULES) {
    throw new Error(`soul.mandatory_interactions 最多 ${MAX_MANDATORY_INTERACTION_RULES} 条`);
  }

  const ids = new Set<string>();
  return v.map((raw, index) => {
    const path = `mandatory_interactions[${index}]`;
    if (!isRecord(raw)) throw new Error(`soul.${path} 必须是对象`);
    const id = reqString(raw, 'id', path);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`soul.${path}.id 必须匹配 [a-z0-9][a-z0-9_-]{0,63}`);
    }
    if (ids.has(id)) throw new Error(`soul.mandatory_interactions id 重复: ${id}`);
    ids.add(id);

    const when = reqString(raw, 'when', path).trim();
    if (!when) throw new Error(`soul.${path}.when 不得为空白`);
    if (when.length > MAX_MANDATORY_RULE_TEXT_LENGTH) {
      throw new Error(`soul.${path}.when 最长 ${MAX_MANDATORY_RULE_TEXT_LENGTH} 字符`);
    }

    const actionStrings = reqStringArray(raw, 'actions', path);
    if (actionStrings.length === 0) throw new Error(`soul.${path}.actions 不得为空`);
    const actions = actionStrings as MandatoryInteractionAction[];
    if (actions.some((action) => !MANDATORY_INTERACTION_ACTIONS.has(action))) {
      throw new Error(`soul.${path}.actions 只允许 like/comment`);
    }
    if (new Set(actions).size !== actions.length) throw new Error(`soul.${path}.actions 不得重复`);

    const hasComment = actions.includes('comment');
    if (hasComment && !actions.includes('like')) {
      throw new Error(`soul.${path} 含 comment 时必须同时含 like`);
    }

    const guidanceRaw = raw.comment_guidance;
    const commentGuidance = typeof guidanceRaw === 'string' ? guidanceRaw.trim() : undefined;
    if (hasComment && !commentGuidance) throw new Error(`soul.${path}.comment_guidance 为 comment 规则必填`);
    if (commentGuidance && commentGuidance.length > MAX_MANDATORY_RULE_TEXT_LENGTH) {
      throw new Error(`soul.${path}.comment_guidance 最长 ${MAX_MANDATORY_RULE_TEXT_LENGTH} 字符`);
    }

    const approvalRaw = raw.comment_approval;
    const commentApproval = typeof approvalRaw === 'string' ? approvalRaw as MandatoryCommentApproval : undefined;
    if (hasComment && !commentApproval) throw new Error(`soul.${path}.comment_approval 为 comment 规则必填`);
    if (commentApproval && !MANDATORY_COMMENT_APPROVALS.has(commentApproval)) {
      throw new Error(`soul.${path}.comment_approval 只允许 review/auto_approve`);
    }
    if (!hasComment && (guidanceRaw !== undefined || approvalRaw !== undefined)) {
      throw new Error(`soul.${path} 不含 comment 时不得配置 comment_guidance/comment_approval`);
    }

    return {
      id,
      when,
      actions: [...actions],
      ...(commentGuidance ? { comment_guidance: commentGuidance } : {}),
      ...(commentApproval ? { comment_approval: commentApproval } : {}),
    };
  });
}

function parseTransition(v: YamlValue, statePath: string): StateTransition {
  if (!isRecord(v)) throw new Error(`${statePath} 的 transition 必须是对象`);
  const t: StateTransition = {
    trigger: reqString(v, 'trigger', `${statePath}.transition`),
    to: reqString(v, 'to', `${statePath}.transition`),
  };
  const src = v.search_source;
  if (typeof src === 'string') {
    if (!SEARCH_SOURCES.includes(src as SearchSource)) {
      throw new Error(`${statePath} 的 search_source 非法: ${src}`);
    }
    t.search_source = src as SearchSource;
  }
  return t;
}

function parseStateDef(name: string, v: YamlValue): BrowseStateDef {
  if (!isRecord(v)) throw new Error(`soul.browse_patterns.states.${name} 必须是对象`);
  const transitionsRaw = v.transitions;
  if (!Array.isArray(transitionsRaw)) {
    throw new Error(`soul.browse_patterns.states.${name}.transitions 必须是数组`);
  }
  const def: BrowseStateDef = {
    action: reqString(v, 'action', `browse_patterns.states.${name}`),
    transitions: transitionsRaw.map((t) => parseTransition(t, `states.${name}`)),
  };
  if (typeof v.max_results_to_browse === 'number') {
    def.max_results_to_browse = v.max_results_to_browse;
  }
  return def;
}

function parseSession(v: YamlValue): SessionLimits {
  if (!isRecord(v)) throw new Error('soul.browse_patterns.session 必须是对象');
  const cd = v.cooldown_between_actions_sec;
  if (!Array.isArray(cd) || cd.length !== 2 || typeof cd[0] !== 'number' || typeof cd[1] !== 'number') {
    throw new Error('soul.browse_patterns.session.cooldown_between_actions_sec 必须是 [min, max] 数字数组');
  }
  return {
    max_duration_min: reqNumber(v, 'max_duration_min', 'browse_patterns.session'),
    max_likes: reqNumber(v, 'max_likes', 'browse_patterns.session'),
    max_searches: reqNumber(v, 'max_searches', 'browse_patterns.session'),
    cooldown_between_actions_sec: [cd[0], cd[1]],
  };
}

function parseBrowsePatterns(v: YamlValue): BrowsePatterns {
  if (!isRecord(v)) throw new Error('soul.browse_patterns 必须是对象');
  const statesRaw = reqObject(v, 'states', 'browse_patterns');
  const states: Record<string, BrowseStateDef> = {};
  for (const [name, def] of Object.entries(statesRaw)) {
    states[name] = parseStateDef(name, def);
  }
  if (Object.keys(states).length === 0) {
    throw new Error('soul.browse_patterns.states 至少要有一个状态');
  }
  return {
    mode: reqString(v, 'mode', 'browse_patterns'),
    states,
    session: parseSession(reqObject(v, 'session', 'browse_patterns')),
  };
}

function parseBehaviorGuidelines(v: YamlValue): BehaviorGuidelines {
  if (!isRecord(v)) throw new Error('soul.behavior_guidelines 必须是对象');
  const rawAffinity = v.like_affinity;
  let likeAffinity: LikeAffinity | undefined;
  if (rawAffinity !== undefined) {
    if (typeof rawAffinity !== 'string' || !LIKE_AFFINITIES.has(rawAffinity as LikeAffinity)) {
      throw new Error(`soul.behavior_guidelines.like_affinity 非法: ${String(rawAffinity)}`);
    }
    likeAffinity = rawAffinity as LikeAffinity;
  }
  return {
    style: reqString(v, 'style', 'behavior_guidelines'),
    privacy: reqString(v, 'privacy', 'behavior_guidelines'),
    collection_principle: reqString(v, 'collection_principle', 'behavior_guidelines'),
    like_principle: reqString(v, 'like_principle', 'behavior_guidelines'),
    ...(likeAffinity ? { like_affinity: likeAffinity } : {}),
  };
}

/** 把已解析的 YAML 值校验并装载为强类型 Soul。 */
export function loadSoulFromValue(value: YamlValue): Soul {
  if (!isRecord(value)) throw new Error('soul 配置根节点必须是对象');
  const writingLanguage = value.writing_language;
  if (writingLanguage !== undefined && !isWritingLanguage(writingLanguage)) {
    throw new Error('soul.writing_language 只允许 zh-CN/en/vi');
  }
  return {
    identity: parseIdentity(value.identity),
    interests: parseInterests(value.interests),
    ...(writingLanguage ? { writing_language: writingLanguage as WritingLanguage } : {}),
    engagement_rules: value.engagement_rules ? parseEngagementRules(value.engagement_rules) : undefined,
    mandatory_interactions: value.mandatory_interactions ? parseMandatoryInteractions(value.mandatory_interactions) : undefined,
    browse_patterns: value.browse_patterns ? parseBrowsePatterns(value.browse_patterns) : undefined,
    behavior_guidelines: value.behavior_guidelines ? parseBehaviorGuidelines(value.behavior_guidelines) : undefined,
  };
}

/** 从 YAML 文本装载 Soul。 */
export function loadSoulFromYaml(text: string): Soul {
  return loadSoulFromValue(parseYaml(text));
}

/** 默认 soul.yaml 路径（与本模块同目录）。 */
export function defaultSoulPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'soul.yaml');
}

/** 从文件装载 Soul（默认读同目录 soul.yaml）。 */
export function loadSoul(path: string = defaultSoulPath()): Soul {
  const text = readFileSync(path, 'utf8');
  return loadSoulFromYaml(text);
}
