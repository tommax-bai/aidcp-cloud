/**
 * 每账号 Facebook 定时评论配置的**纯数据模型类型**（原定义在 src/config/facebook-comment-config-store.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供 automation 侧评论调度器跨边界共导 EffectiveFacebookCommentConfig。
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 * SCHEMA_SQL + FacebookCommentConfigStore 类 + 强制/校验函数留 facebook-comment-config-store.ts。
 */

/**
 * 容器（群/主页）配置项（change facebook-container-display-name）。
 * `url` 是功能主键（边缘据此导航 + 建站内搜索链，含群 id）；`name` 是人类可读群名（边缘从群页自动解析回填），
 * 未解析出前为空。
 */
export interface FacebookContainer {
  url: string;
  name?: string;
}

export type FacebookCommentMode = 'generated' | 'template';

/**
 * 同步读快照上的**线缆写法**（复数 `templates`），与领域写法（单数 `template`）**不同字面量**。
 *
 * 这不是笔误，是两套已经各自落地的词表：库列与领域类型用单数，快照载荷与其校验器用复数。
 * 危险之处在于它**不会报错**——跨进程消费方顺手写 `mode === 'template'` 恒为 false，
 * 结果不是崩溃，而是运营配好的模板被静静换成 AI 生成正文。
 * 故两个方向都收口成具名函数，且快照字段类型由裸 `string` 收窄到本联合，让编译器接住误用。
 */
export const FACEBOOK_COMMENT_MODE_WIRE_VALUES = [
  'generated',
  'templates',
] as const;
export type FacebookCommentModeWire =
  (typeof FACEBOOK_COMMENT_MODE_WIRE_VALUES)[number];

/** 库列 / 面板入参 → 领域写法：只有单数 `template` 算模板，其余一律生成式。 */
export function coerceFacebookCommentMode(raw: unknown): FacebookCommentMode {
  return raw === 'template' ? 'template' : 'generated';
}

/** 领域写法 → 线缆写法（快照发布方唯一出口）。 */
export function facebookCommentModeToWire(
  mode: FacebookCommentMode,
): FacebookCommentModeWire {
  return mode === 'template' ? 'templates' : 'generated';
}

/** 线缆写法 → 领域写法（快照消费方唯一入口）。 */
export function facebookCommentModeFromWire(
  wire: FacebookCommentModeWire,
): FacebookCommentMode {
  return wire === 'templates' ? 'template' : 'generated';
}

/** fail-closed 生效判定：正文模式必须可用；关键词为空表示群内首帖模式（目标群由 joined ledger 另行选择）。 */
export interface EffectiveFacebookCommentConfig {
  enabled: boolean;
  keywords: string[];
  containers: FacebookContainer[];
  commentMode: FacebookCommentMode;
  commentTemplates: string[];
}

/** 生效判定所需的账号侧事实（属主行与同步读快照行都能填出来）。 */
export interface FacebookCommentAccountFacts {
  readonly keywords: readonly string[];
  readonly containers: readonly FacebookContainer[];
  readonly commentMode: FacebookCommentMode;
  readonly commentModeConfigured: boolean;
  readonly commentTemplates: readonly string[];
}

/**
 * 「账号行 → 生效评论配置」的**纯判定段**：**未显式配过模式一律按模板**，
 * 绝不因为列默认值就替运营选了生成式。无行同样按未配处理。
 */
export function resolveEffectiveFacebookCommentConfig(
  facts: FacebookCommentAccountFacts | null | undefined,
): EffectiveFacebookCommentConfig {
  return {
    enabled: true,
    keywords: [...(facts?.keywords ?? [])],
    containers: [...(facts?.containers ?? [])],
    commentMode:
      facts && facts.commentModeConfigured ? facts.commentMode : 'template',
    commentTemplates: [...(facts?.commentTemplates ?? [])],
  };
}
