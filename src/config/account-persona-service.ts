import type { PersonaGenerator } from '../agents/persona-generator.js';
import type { PanelPersonaConfig } from '../panel/types.js';
import type { PersonaBinding } from '../kernel/persona-binding.js';
import { normalizePlatformId } from '../platform/index.js';
import { loadSoulFromYaml } from '../soul/index.js';
import { resolveLikeAffinity } from '../kernel/like-affinity.js';
import { isWritingLanguage } from '../soul/writing-language.js';
import type { WritingLanguage } from '../kernel/soul-types.js';

export const MAX_PERSONA_BYTES = 32 * 1024;
// Renderer caps visible content preferences at 24, but the request also carries derived
// category/affinity markers. Keep transport validation bounded without rejecting that expansion.
export const MAX_PERSONA_KEYWORDS = 64;
export const MAX_PERSONA_KEYWORD_LENGTH = 40;
const MAX_GENERATION_IDEMPOTENCY_ENTRIES = 1024;

export interface AccountPersonaSummary {
  name: string;
  role: string;
  background: string;
  tone: string;
  writingLanguage: WritingLanguage | null;
  primaryInterests: string[];
  secondaryInterests: string[];
  seedKeywords: string[];
  likeAffinity: 'normal' | 'like_more' | 'like_most';
}

export type AccountPersonaView =
  | { state: 'missing'; persona: null }
  | {
      state: 'configured';
      persona: {
        soulYaml: string;
        summary: AccountPersonaSummary;
        updatedAt: string | null;
      };
    };

export type AccountPersonaReadResult =
  | { ok: true; view: AccountPersonaView }
  | { ok: false; reason: 'unknown_account' | 'persona_invalid' | 'unavailable' };

export type AccountPersonaGenerateResult =
  | { ok: true; soulYaml: string; identitySummary: string; summary: AccountPersonaSummary }
  | {
      ok: false;
      reason:
        | 'unavailable'
        | 'unknown_account'
        | 'unsupported_platform'
        | 'writing_language_required'
        | 'writing_language_invalid'
        | 'writing_language_not_supported'
        | 'missing_idempotency_key'
        | 'input_too_large'
        | 'no_keywords'
        | 'generation_failed'
        | 'persona_invalid';
    };

export type AccountPersonaPersistResult =
  | { ok: true; view: Extract<AccountPersonaView, { state: 'configured' }>; firstPostOnboarding: boolean }
  | { ok: false; reason: 'persona_required' | 'input_too_large' | 'unknown_account' | 'persona_invalid' | 'persist_failed' };

export interface AccountPersonaServiceDeps {
  generator: Pick<PersonaGenerator, 'generate'>;
  facade: Pick<PanelPersonaConfig, 'getDetail' | 'setPersona'>;
  firstPostOnboarding?: { armFirstBind(accountId: string): Promise<boolean> };
  /**
   * 人设绑定态的**三态**判据（change config-mirror-cross-process-invalidation task 4.2/4.3）。
   *
   * 为什么 HTTP 拉取面也必须问它：当代客户端的人设绑定态**根本不经 WS 下发**（`ui-snapshot` 对
   * 拉取型客户端直接 return），它唯一的来源就是本服务经 `GET /my-environments` 回的 `personaBound`。
   * WS 面把「未知」做成了「不下发该字段」；拉取面若照旧回 `state:'missing'` + `personaBound:false`，
   * 那条不变量在**真正的落地面上**并没有兑现——客户端拿到一个权威的「你没绑人设」，当场弹人设向导，
   * 而账号可能早就绑好了。缺省（未注入）= 不做三态判定，行为逐位退回本 change 之前。
   */
  personaBinding?: (accountId: string) => PersonaBinding;
  logger?: Pick<Console, 'warn'>;
}

function boundedText(value: string, max = 500): string {
  return value.slice(0, max);
}

function boundedList(values: string[]): string[] {
  return values.slice(0, 12).map((value) => boundedText(value, 80));
}

export function summarizePersona(soulYaml: string): AccountPersonaSummary {
  const soul = loadSoulFromYaml(soulYaml);
  return {
    name: boundedText(soul.identity.name, 160),
    role: boundedText(soul.identity.role, 240),
    background: boundedText(soul.identity.background),
    tone: boundedText(soul.identity.tone, 240),
    writingLanguage: soul.writing_language ?? null,
    primaryInterests: boundedList(soul.interests.primary),
    secondaryInterests: boundedList(soul.interests.secondary),
    seedKeywords: boundedList(soul.interests.seed_keywords),
    likeAffinity: resolveLikeAffinity(soul),
  };
}

export class AccountPersonaService {
  private readonly logger: Pick<Console, 'warn'>;
  private readonly generateInflight = new Map<string, Promise<AccountPersonaGenerateResult>>();

  constructor(private readonly deps: AccountPersonaServiceDeps) {
    this.logger = deps.logger ?? console;
  }

  async get(accountId: string): Promise<AccountPersonaReadResult> {
    try {
      const detail = await this.deps.facade.getDetail(accountId);
      if (!detail) return { ok: false, reason: 'unknown_account' };
      if (detail.source === 'none') {
        // 三态：副本里没有这一行 ≠ 库里没有。副本陈旧时回**不可用**（契约里本就有的诚实态），
        // 绝不回一个权威的 `missing`——调用方会把它翻成 `personaBound:false` 并弹人设向导。
        // 判据只加在这一支（source==='none'）：副本里**有**人设时照常返回，读到一份稍旧的人设文本
        // 不构成「未知压成否」，而 503 掉一个我们答得出来的读只会把人设编辑器无谓地打断。
        if (this.deps.personaBinding?.(accountId) === 'unknown') {
          this.logger.warn(`[persona] 人设副本陈旧 account=${accountId}：回 unavailable，绝不回权威的「未绑」`);
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, view: { state: 'missing', persona: null } };
      }
      return {
        ok: true,
        view: {
          state: 'configured',
          persona: {
            soulYaml: detail.persona,
            summary: summarizePersona(detail.persona),
            updatedAt: detail.updatedAt,
          },
        },
      };
    } catch (error) {
      this.logger.warn(`[persona] read failed account=${accountId}: ${(error as Error).message}`);
      return { ok: false, reason: error instanceof Error && /soul\./.test(error.message) ? 'persona_invalid' : 'unavailable' };
    }
  }

  async generate(input: {
    accountId: string;
    platform: string | null | undefined;
    keywordSelections: unknown;
    writingLanguage?: unknown;
    idempotencyKey: string;
  }): Promise<AccountPersonaGenerateResult> {
    if (typeof input.platform !== 'string' || !input.platform.trim()) {
      return { ok: false, reason: 'unsupported_platform' };
    }
    let platform: ReturnType<typeof normalizePlatformId>;
    try {
      platform = normalizePlatformId(input.platform);
    } catch {
      return { ok: false, reason: 'unsupported_platform' };
    }
    if (platform === 'facebook') {
      if (input.writingLanguage === undefined) return { ok: false, reason: 'writing_language_required' };
      if (!isWritingLanguage(input.writingLanguage)) return { ok: false, reason: 'writing_language_invalid' };
    } else if (input.writingLanguage !== undefined) {
      return { ok: false, reason: 'writing_language_not_supported' };
    }

    const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (!idempotencyKey) return { ok: false, reason: 'missing_idempotency_key' };
    const keywords = Array.isArray(input.keywordSelections)
      ? input.keywordSelections.filter((keyword): keyword is string => typeof keyword === 'string')
      : [];
    if (
      !Array.isArray(input.keywordSelections)
      || keywords.length !== input.keywordSelections.length
      || keywords.length > MAX_PERSONA_KEYWORDS
      || keywords.some((keyword) => keyword.length > MAX_PERSONA_KEYWORD_LENGTH)
    ) {
      return { ok: false, reason: 'input_too_large' };
    }

    const account = await this.get(input.accountId);
    if (!account.ok) return { ok: false, reason: account.reason };

    const cacheKey = `${input.accountId}:${idempotencyKey}`;
    let inflight = this.generateInflight.get(cacheKey);
    if (!inflight) {
      while (this.generateInflight.size >= MAX_GENERATION_IDEMPOTENCY_ENTRIES) {
        const oldest = this.generateInflight.keys().next().value;
        if (oldest === undefined) break;
        this.generateInflight.delete(oldest);
      }
      inflight = this.runGenerate({
        accountId: input.accountId,
        keywordSelections: keywords,
        writingLanguage: platform === 'facebook' ? input.writingLanguage as WritingLanguage : undefined,
        idempotencyKey,
      }).then((result) => {
        if (!result.ok) this.generateInflight.delete(cacheKey);
        return result;
      }).catch((error) => {
        this.generateInflight.delete(cacheKey);
        this.logger.warn(`[persona] generation failed account=${input.accountId}: ${(error as Error).message}`);
        return { ok: false, reason: 'generation_failed' } as const;
      });
      this.generateInflight.set(cacheKey, inflight);
    }
    return inflight;
  }

  private async runGenerate(input: {
    accountId: string;
    keywordSelections: string[];
    writingLanguage?: WritingLanguage;
    idempotencyKey: string;
  }): Promise<AccountPersonaGenerateResult> {
    const outcome = await this.deps.generator.generate({
      accountId: input.accountId,
      keywordSelections: input.keywordSelections,
      writingLanguage: input.writingLanguage,
      diversitySeed: `account:${input.accountId}|nonce:${input.idempotencyKey}`,
    });
    if (!outcome.ok) return outcome;
    try {
      return {
        ok: true,
        soulYaml: outcome.soulYaml,
        identitySummary: outcome.identitySummary,
        summary: summarizePersona(outcome.soulYaml),
      };
    } catch {
      return { ok: false, reason: 'persona_invalid' };
    }
  }

  async persist(accountId: string, soulYaml: string, updatedBy: string): Promise<AccountPersonaPersistResult> {
    if (!soulYaml.trim()) return { ok: false, reason: 'persona_required' };
    if (Buffer.byteLength(soulYaml, 'utf8') > MAX_PERSONA_BYTES) return { ok: false, reason: 'input_too_large' };
    let summary: AccountPersonaSummary;
    try {
      summary = summarizePersona(soulYaml);
    } catch {
      return { ok: false, reason: 'persona_invalid' };
    }

    try {
      const result = await this.deps.facade.setPersona(accountId, soulYaml, updatedBy);
      if (!result.ok) return result;
      const row = result.view.accounts.find((account) => account.accountId === accountId);
      let firstPostOnboarding = false;
      if (this.deps.firstPostOnboarding) {
        try {
          firstPostOnboarding = await this.deps.firstPostOnboarding.armFirstBind(accountId);
        } catch (error) {
          this.logger.warn(`[persona] first-post arm failed account=${accountId}: ${(error as Error).message}`);
        }
      }
      return {
        ok: true,
        view: {
          state: 'configured',
          persona: { soulYaml, summary, updatedAt: row?.updatedAt ?? null },
        },
        firstPostOnboarding,
      };
    } catch (error) {
      this.logger.warn(`[persona] persist failed account=${accountId}: ${(error as Error).message}`);
      return { ok: false, reason: 'persist_failed' };
    }
  }
}
