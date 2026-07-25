/**
 * 人设通道的跨属主窄端口（change cloud-coupling-phase4-runtime-ports）。
 *
 * 为什么在 kernel：`src/comm/handler.ts`（automation）今天直接引 api 的人设写入外观、
 * content 的人设生成角色与 api 的账号人设服务三个**实现**，只为了拿到它们的调用形状。
 * 端口按**调用方视角**收窄：实现侧成功分支上多出来的字段（面板目录视图 / 摘要）刻意不进
 * 端口——把它们搬进来等于把面板契约整坨拖进共享层。结构可赋值方向上多余字段无害。
 *
 * 红线：这里只放形状，不放任何实现、任何默认值。端口拿不到实现时的降级由调用方按
 * 「诚实回 unavailable」处理，MUST NOT 在此提供兜底实现。
 */
import type { WritingLanguage } from './soul-types.js';

/** 人设输入的传输层上限（渲染层可见偏好上限 24，另加派生的品类/倾向标记）。 */
export const MAX_PERSONA_KEYWORDS = 64;
export const MAX_PERSONA_KEYWORD_LENGTH = 40;

/* ── 人设写入外观（实现在 api 的面板人设配置） ─────────────────────────── */

export type PersonaWriteOutcome = { ok: true } | { ok: false; reason: 'unknown_account' | 'persona_invalid' };

export interface PersonaWritePort {
  setPersona(accountId: string, persona: string, updatedBy: string): Promise<PersonaWriteOutcome>;
}

/* ── 人设生成角色（实现在 content 的 PersonaGenerator） ───────────────── */

export interface PersonaGenerateInput {
  /** 账号标识（token 按账号记账；云端已以握手绑定 accountId 为准，本值仅用于记账归属）。 */
  accountId: string;
  /** 客户勾选的垂类/兴趣/语气关键词，以及可选受控 like_affinity 标记。 */
  keywordSelections: string[];
  /** Facebook-only，由 Cloud 入口校验后确定性注入，模型不得决定。 */
  writingLanguage?: WritingLanguage;
  /** 每账号差异化种子（调用方注入，如 accountId + nonce）：拌进 prompt 抗跨账号同质化。 */
  diversitySeed?: string;
}

export type PersonaGenerateOutcome =
  | { ok: true; soulYaml: string; identitySummary: string }
  | { ok: false; reason: 'no_keywords' | 'generation_failed' | 'persona_invalid' };

export interface PersonaGeneratorPort {
  generate(input: PersonaGenerateInput): Promise<PersonaGenerateOutcome>;
}

/* ── 账号人设服务（实现在 api 的 AccountPersonaService） ──────────────── */

export interface AccountPersonaGenerateRequest {
  accountId: string;
  platform: string | null | undefined;
  keywordSelections: unknown;
  writingLanguage?: unknown;
  idempotencyKey: string;
}

export type AccountPersonaGenerateOutcome =
  | { ok: true; soulYaml: string; identitySummary: string }
  | { ok: false; reason: string };

export type AccountPersonaPersistOutcome =
  | { ok: true; firstPostOnboarding: boolean }
  | { ok: false; reason: string };

export interface AccountPersonaPort {
  generate(input: AccountPersonaGenerateRequest): Promise<AccountPersonaGenerateOutcome>;
  persist(accountId: string, soulYaml: string, updatedBy: string): Promise<AccountPersonaPersistOutcome>;
}
