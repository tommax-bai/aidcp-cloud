/**
 * 进程内配置镜像注册表（change config-mirror-cross-process-invalidation，task 1.1）。
 *
 * ## 这张表要解决的问题
 *
 * 云端有 15 处进程内配置镜像，全部只在 `init()` 与**本进程写入**时刷新——全仓无 watch、无
 * `setInterval` 刷配置、无 `LISTEN/NOTIFY`。dev 与 ol 是两个进程共用同一个 PostgreSQL 库，
 * 其中 8 张是无 `execution_target` 列的全局配置表：在 dev 控制台改一个全局安全限额，ol 进程的
 * 镜像**到重启才可见**，中间零日志、零告警、后台还回显写入成功。拆成三服务后，同一缺陷会从
 * 「跨 target 不可见」放大成「跨服务永远不可见」。
 *
 * ## 穷举防漂移
 *
 * `CONFIG_MIRRORS` 是 `Record<ConfigMirrorKey, …>`：新增一处镜像却不登记 → typecheck 失败。
 * 档位为 `gate` 的条目**必须**给出 `staleMs` 数值（判别联合，写 `null` 即类型错），
 * 档位为 `parameter` 的**必须**写 `staleMs: null`——「闸门镜像无陈旧上限」在类型上就构造不出来。
 *
 * ## 档位判据（按字段语义，不按 store）
 *
 * 一个镜像字段若其取值可以让系统**开始或继续对真实平台下发动作**，即为**闸门镜像**；只改变动作
 * 参数、不决定是否动作的，为**参数镜像**。闸门镜像陈旧即停手（不放行**新的**平台动作，已在跑的
 * 会话走自然结束路径收敛）；参数镜像陈旧继续用最后已知良值 + 告警。
 *
 * ## 四类限频配置为什么登记成 `parameter`（唯一一处需要解释的判定）
 *
 * `quota_config` / `pacing_floor_config` / `session_config_global` / `resume_config_global` 的取值
 * **当然**能决定是否动作（配额为 0 即 `canDo` 恒拒）。它们登记成 `parameter` 不是对语义的判断，
 * 而是对**副本形态**的判断：design 决策 1 把这四个 store 判给自动化服务（依据：`src/risk/` 对
 * `src/config/` 的 import 为 0、反向 13 处，依赖方向已单向倒置），归属对齐后**消费方与写入方同进程**
 * ——不存在跨服务副本，镜像是本进程写透的全量投影，`never-brick`（缺行/值非法回落 `quotas.ts`
 * 写死默认）的适用面逐字不变。design 决策 3 的分档清单也把这四项显式排除在闸门集合之外。
 *
 * 它们**仍然登记进本表并接版本通道**：dev 与 ol 是两个自动化进程共库，一次面板写入只到达其中一个
 * 进程的镜像，跨 target 可见性问题不因归属对齐而消失（design 决策 1 的第二条连带约束）。
 *
 * ## 归属（`owner`）
 *
 * 指**写入权**归属的目标服务（`docs/cloud-service-decomposition-proposal.md` §5.1）。
 * 阶段 1 只划线、不拆进程，故 `owner` 今天只用于文档与断言，不影响运行时装配。
 */

import type { ConfigMirrorKey } from '../config-mirror-freshness.js';

export type { ConfigMirrorKey };

/** 目标态服务归属（阶段 1 只划线）。 */
export type ConfigMirrorOwner = 'api' | 'automation' | 'content';

/** 档位。判据见头注。 */
export type ConfigMirrorTier = 'gate' | 'parameter';

interface ConfigMirrorDescriptorBase {
  mirrorKey: ConfigMirrorKey;
  /** 写入权归属服务。 */
  owner: ConfigMirrorOwner;
  /** 运行时消费方（读镜像的一侧）。 */
  consumers: readonly ConfigMirrorOwner[];
  /** 底表 / 事实源（人读用，非 SQL 拼接输入）。 */
  source: string;
  /** 该镜像今天所在的取值口（`文件` 级，便于回到现场）。 */
  holder: string;
}

/**
 * 闸门镜像：**必须**声明具体陈旧上限（毫秒）。默认 60000 = 12 × 默认轮询周期 5000，
 * 即容忍连续 11 次拉取失败后才停手。
 */
export interface GateConfigMirrorDescriptor extends ConfigMirrorDescriptorBase {
  tier: 'gate';
  staleMs: number;
}

/** 参数镜像：陈旧不停手，故**必须**写 `staleMs: null`（不留「上限待定」的口子）。 */
export interface ParameterConfigMirrorDescriptor extends ConfigMirrorDescriptorBase {
  tier: 'parameter';
  staleMs: null;
}

export type ConfigMirrorDescriptor = GateConfigMirrorDescriptor | ParameterConfigMirrorDescriptor;

/** 闸门镜像默认陈旧上限（毫秒）。 */
export const DEFAULT_GATE_STALE_MS = 60_000;

/**
 * 15 处镜像的穷举登记表。**新增镜像未登记即 typecheck 失败。**
 *
 * 映射类型 `{ [K in ConfigMirrorKey]: … & { mirrorKey: K } }` 额外保证「键与 `mirrorKey` 字段一致」，
 * 复制粘贴改错 key 也会当场报错。
 */
export const CONFIG_MIRRORS: {
  readonly [K in ConfigMirrorKey]: ConfigMirrorDescriptor & { mirrorKey: K };
} = {
  // ── 1–4：四类限频配置（归 automation；本地写透镜像，档位说明见头注） ───────────────
  quota_config: {
    mirrorKey: 'quota_config',
    owner: 'automation',
    consumers: ['automation'],
    source: 'quota_config',
    holder: 'src/config/quota-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  pacing_floor_config: {
    mirrorKey: 'pacing_floor_config',
    owner: 'automation',
    consumers: ['automation'],
    source: 'pacing_floor_config',
    holder: 'src/config/pacing-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  session_config_global: {
    mirrorKey: 'session_config_global',
    owner: 'automation',
    consumers: ['automation', 'api'],
    source: 'session_config_global',
    holder: 'src/config/session-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  resume_config_global: {
    mirrorKey: 'resume_config_global',
    owner: 'automation',
    consumers: ['automation'],
    source: 'resume_config_global',
    holder: 'src/config/resume-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },

  // ── 5–6、11–15：闸门镜像（陈旧即停手） ────────────────────────────────────────────
  persona_config: {
    mirrorKey: 'persona_config',
    owner: 'api',
    consumers: ['automation', 'content'],
    source: 'persona_config',
    holder: 'src/config/persona-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  content_schedule: {
    mirrorKey: 'content_schedule',
    owner: 'api',
    consumers: ['automation'],
    source: 'content_schedule_global / content_schedule_account',
    holder: 'src/config/content-schedule-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  facebook_comment_config: {
    mirrorKey: 'facebook_comment_config',
    owner: 'api',
    consumers: ['automation'],
    source: 'facebook_comment_config',
    holder: 'src/config/facebook-comment-config-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  facebook_group_join_automation_config: {
    mirrorKey: 'facebook_group_join_automation_config',
    owner: 'api',
    consumers: ['automation'],
    source: 'facebook_group_join_automation_config',
    holder: 'src/config/facebook-group-join-automation-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  account_status: {
    mirrorKey: 'account_status',
    owner: 'api',
    consumers: ['automation'],
    source: 'accounts.status / accounts.paused_at',
    holder: 'src/account-state.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  client_environment_slow_start: {
    mirrorKey: 'client_environment_slow_start',
    owner: 'api',
    consumers: ['automation'],
    source: 'client_environments.slow_start_since',
    holder: 'src/client-auth/client-user-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },
  client_environment_automation_gate: {
    mirrorKey: 'client_environment_automation_gate',
    owner: 'api',
    consumers: ['automation'],
    source: 'client_environments.lifecycle_state',
    holder: 'src/client-auth/client-user-store.ts',
    tier: 'gate',
    staleMs: DEFAULT_GATE_STALE_MS,
  },

  // ── 7–10：参数镜像（陈旧继续用最后已知良值 + 告警） ───────────────────────────────
  model_config: {
    mirrorKey: 'model_config',
    owner: 'api',
    consumers: ['content', 'automation'],
    source: 'model_config',
    holder: 'src/config/model-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  role_config: {
    mirrorKey: 'role_config',
    owner: 'api',
    consumers: ['content', 'automation'],
    source: 'role_config',
    holder: 'src/config/role-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  category_config: {
    mirrorKey: 'category_config',
    owner: 'api',
    consumers: ['content'],
    source: 'category_config',
    holder: 'src/config/category-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  hot_lead_config: {
    mirrorKey: 'hot_lead_config',
    owner: 'api',
    consumers: ['automation'],
    source: 'hot_lead_config',
    holder: 'src/config/hot-lead-config-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
  facebook_operation_policy: {
    mirrorKey: 'facebook_operation_policy',
    owner: 'api',
    consumers: ['automation'],
    source: 'facebook_operation_policy',
    holder: 'src/config/facebook-operation-policy-store.ts',
    tier: 'parameter',
    staleMs: null,
  },
};

/** 全部 mirrorKey（稳定顺序，供刷新器与健康投影遍历）。 */
export const CONFIG_MIRROR_KEYS = Object.keys(CONFIG_MIRRORS) as ConfigMirrorKey[];

/** 是否闸门镜像。 */
export function isGateMirror(mirrorKey: ConfigMirrorKey): boolean {
  return CONFIG_MIRRORS[mirrorKey].tier === 'gate';
}

/** 某镜像的陈旧上限；参数镜像返回 null（不停手）。 */
export function staleMsOf(mirrorKey: ConfigMirrorKey): number | null {
  return CONFIG_MIRRORS[mirrorKey].staleMs;
}
