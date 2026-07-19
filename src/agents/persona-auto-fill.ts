/** Cloud-owned Facebook 已选人设补齐编排。 */
import type { ClientUserStore } from '../client-auth/client-user-store.js';
import type { PersonaStore } from '../config/persona-store.js';
import type { PanelPersonaConfig } from '../panel/types.js';
import { loadSoulFromYaml } from '../soul/index.js';
import type {
  PersonaAutoFillRun,
  PersonaAutoFillStore,
  PersonaAutoFillTarget,
} from '../config/persona-auto-fill-store.js';

export interface PersonaAutoFillServiceDeps {
  store: PersonaAutoFillStore;
  clientUsers: Pick<ClientUserStore, 'resolveBoundAccountForEnv'>;
  personas: Pick<PersonaStore, 'getForAccount'>;
  personaPanel: Pick<PanelPersonaConfig, 'setPersonaIfMissing'>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export class PersonaAutoFillService {
  private readonly inflightTargets = new Map<string, Promise<void>>();
  private readonly inflightRuns = new Map<string, Promise<void>>();
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(private readonly deps: PersonaAutoFillServiceDeps) {
    this.logger = deps.logger ?? console;
  }

  async createRun(input: {
    userId: string;
    idempotencyKey: string;
    soulYaml: string;
  }): Promise<{ run: PersonaAutoFillRun; idempotent: boolean }> {
    const soul = loadSoulFromYaml(input.soulYaml);
    if (!soul.writing_language) throw new Error('facebook_writing_language_required');
    const result = await this.deps.store.createRun({
      ...input,
      writingLanguage: soul.writing_language,
    });
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

    // 旧 facebook_auto_v1 运行没有用户确认模板；部署后必须停止模型行为并具名失败。
    if (claimed.strategy !== 'selected_persona_v1' || !claimed.soulYaml) {
      await this.deps.store.markTarget(claimed.runId, claimed.envKey, 'failed', 'selected_persona_required');
      return;
    }
    const stored = await this.deps.personaPanel.setPersonaIfMissing(
      accountId,
      claimed.soulYaml,
      `persona-selected-fill:${claimed.runId}`,
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

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
