/** Cloud-owned Facebook 人设自动补齐编排。 */
import crypto from 'node:crypto';
import type { PersonaGenerator } from './persona-generator.js';
import type { ClientUserStore } from '../client-auth/client-user-store.js';
import type { PersonaStore } from '../config/persona-store.js';
import type { PanelPersonaConfig } from '../panel/types.js';
import type { WritingLanguage } from '../soul/types.js';
import type {
  PersonaAutoFillRun,
  PersonaAutoFillStore,
  PersonaAutoFillTarget,
} from '../config/persona-auto-fill-store.js';

const FACEBOOK_DIRECTIONS = [
  ['生活方式', '居家日常', '生活好物'],
  ['美食探店', '家常料理', '咖啡甜品'],
  ['旅行见闻', '周末出游', '城市散步'],
  ['运动健身', '健康习惯', '户外活动'],
  ['宠物日常', '养宠经验', '萌宠内容'],
  ['亲子生活', '家庭陪伴', '育儿日常'],
  ['数码科技', '实用工具', '产品体验'],
  ['职场成长', '效率方法', '工作日常'],
  ['穿搭审美', '日常搭配', '个人风格'],
  ['影视娱乐', '音乐分享', '文化热点'],
  ['摄影记录', '构图灵感', '影像器材'],
  ['汽车生活', '用车体验', '自驾出行'],
] as const;

export interface PersonaAutoFillServiceDeps {
  store: PersonaAutoFillStore;
  clientUsers: Pick<ClientUserStore, 'resolveBoundAccountForEnv'>;
  personas: Pick<PersonaStore, 'getForAccount'>;
  personaPanel: Pick<PanelPersonaConfig, 'setPersonaIfMissing'>;
  generator: Pick<PersonaGenerator, 'generate'>;
  logger?: Pick<Console, 'log' | 'warn'>;
  maxTargetAttempts?: number;
}

export class PersonaAutoFillService {
  private readonly inflightTargets = new Map<string, Promise<void>>();
  private readonly inflightRuns = new Map<string, Promise<void>>();
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly maxTargetAttempts: number;

  constructor(private readonly deps: PersonaAutoFillServiceDeps) {
    this.logger = deps.logger ?? console;
    this.maxTargetAttempts = Math.max(1, deps.maxTargetAttempts ?? 2);
  }

  async createRun(input: {
    userId: string;
    idempotencyKey: string;
    writingLanguage: WritingLanguage;
  }): Promise<{ run: PersonaAutoFillRun; idempotent: boolean }> {
    const result = await this.deps.store.createRun(input);
    if (result.run.state === 'running') this.scheduleRun(result.run.runId);
    return { run: result.run, idempotent: !result.created };
  }

  /** 启动恢复：只恢复 pending / 超时 running；正常 waiting_binding 等未来真实握手。 */
  async resume(): Promise<void> {
    const runIds = await this.deps.store.recoverRunnableRunIds();
    for (const runId of runIds) this.scheduleRun(runId);
  }

  /** 环境握手绑定落库后调用；只碰创建时已在某 run 快照内的 target。 */
  notifyEnvironmentBound(envKey: string): void {
    void this.deps.store.listWaitingForEnvironment(envKey)
      .then((targets) => Promise.all(targets.map((target) => this.scheduleTarget(target))))
      .catch((err) => this.logger.warn(`[persona-auto-fill] env=${envKey} 绑定续跑失败: ${this.message(err)}`));
  }

  private scheduleRun(runId: string): void {
    if (this.inflightRuns.has(runId)) return;
    const work = this.processRun(runId)
      .catch((err) => this.logger.warn(`[persona-auto-fill] run=${runId} 处理失败: ${this.message(err)}`))
      .finally(() => this.inflightRuns.delete(runId));
    this.inflightRuns.set(runId, work);
  }

  private async processRun(runId: string): Promise<void> {
    // generator 自身有有界重试；target 层再至多重复一次，持久 attempts 防进程重启后无限调用。
    for (;;) {
      const pending = await this.deps.store.listPendingForRun(runId, 20);
      if (!pending.length) break;
      for (let i = 0; i < pending.length; i += 2) {
        await Promise.all(pending.slice(i, i + 2).map((target) => this.scheduleTarget(target)));
      }
    }
    await this.deps.store.refreshRunState(runId);
  }

  private scheduleTarget(target: PersonaAutoFillTarget): Promise<void> {
    const key = `${target.runId}:${target.envKey}`;
    const existing = this.inflightTargets.get(key);
    if (existing) return existing;
    const work = this.processTarget(target)
      .catch((err) => this.logger.warn(`[persona-auto-fill] target=${key} 异常: ${this.message(err)}`))
      .finally(() => this.inflightTargets.delete(key));
    this.inflightTargets.set(key, work);
    return work;
  }

  private async processTarget(target: PersonaAutoFillTarget): Promise<void> {
    let bound;
    try {
      bound = await this.deps.clientUsers.resolveBoundAccountForEnv(target.userId, target.envKey);
    } catch (err) {
      await this.deps.store.markTarget(target.runId, target.envKey, 'failed', `binding_lookup_failed:${this.message(err)}`);
      return;
    }
    if (!bound.ok) {
      if (bound.reason === 'binding_unknown') {
        await this.deps.store.markTarget(target.runId, target.envKey, 'waiting_binding', bound.reason);
      } else {
        await this.deps.store.markTarget(target.runId, target.envKey, 'failed', bound.reason);
      }
      return;
    }
    const accountId = bound.accountId;
    if (this.deps.personas.getForAccount(accountId)) {
      await this.deps.store.markTarget(target.runId, target.envKey, 'skipped_existing', 'persona_already_exists');
      return;
    }
    const claimed = await this.deps.store.claimTarget(target.runId, target.envKey, accountId);
    if (!claimed) return;

    const direction = this.directionFor(accountId);
    const generated = await this.deps.generator.generate({
      accountId,
      keywordSelections: [...direction, 'like_affinity:normal'],
      diversitySeed: `facebook_auto_v1:${accountId}`,
      writingLanguage: claimed.writingLanguage,
    });
    if (!generated.ok) {
      const terminal = claimed.attempts >= this.maxTargetAttempts;
      await this.deps.store.markTarget(
        claimed.runId,
        claimed.envKey,
        terminal ? 'failed' : 'pending',
        generated.reason,
      );
      return;
    }
    const stored = await this.deps.personaPanel.setPersonaIfMissing(
      accountId,
      generated.soulYaml,
      `persona-auto-fill:${claimed.runId}`,
    );
    if (!stored.ok) {
      await this.deps.store.markTarget(claimed.runId, claimed.envKey, 'failed', stored.reason);
      return;
    }
    await this.deps.store.markTarget(
      claimed.runId,
      claimed.envKey,
      stored.created ? 'succeeded' : 'skipped_existing',
      stored.created ? null : 'persona_won_concurrent_race',
    );
  }

  private directionFor(accountId: string): readonly string[] {
    const digest = crypto.createHash('sha256').update(`facebook_auto_v1:${accountId}`, 'utf8').digest();
    return FACEBOOK_DIRECTIONS[digest.readUInt32BE(0) % FACEBOOK_DIRECTIONS.length];
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
