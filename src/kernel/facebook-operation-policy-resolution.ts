/**
 * Facebook 运营策略「基线取用」的**纯判定段 + 纯数据契约**（kernel）。
 *
 * 从 src/config/facebook-operation-policy-store.ts（api 属主）析出。存储残壳继续持库、持缓存、
 * 写 SQL 与审计，但「这个账号今天能不能拿到基线、拿不到时具名原因是什么」只此一份。
 *
 * **为什么非做不可**：这条判定决定**整个 Facebook 浏览模式**。拆进程后接口进程按自己的内存缓存问，
 * 自动化进程按同步读快照问；各写一份的现形方式不是报错，而是某一侧安静地永远答不出基线
 * —— 而「答不出基线」在下游就是**这个账号永远不开始浏览**，日志里只有一行具名 blocker。
 *
 * 零 import、无 SQL、无活状态。MUST NOT 给它一个恒 `unsupported` / `blocked` 的实现把编译过掉。
 */

export type FacebookBaseOperationMode = 'persona' | 'rule' | 'consumption';
export type FacebookPrimaryBrowseSurface = 'feed' | 'reels';
export type FacebookCadenceSource = 'global' | 'environment';

/** 取值表：校验器与投影方一律取这三份，MUST NOT 手抄字面量（抄错也照样编译过）。 */
export const FACEBOOK_BASE_OPERATION_MODES = [
  'persona',
  'rule',
  'consumption',
] as const;
export const FACEBOOK_PRIMARY_BROWSE_SURFACES = ['feed', 'reels'] as const;
export const FACEBOOK_CADENCE_SOURCES = ['global', 'environment'] as const;

export type FacebookRuleOperationParameters = {
  viewsPerLike: number;
  joinEveryNRounds: number;
};

export type FacebookConsumptionOperationParameters = {
  viewsPerLike: number;
  confirmedLikesPerJoin: number;
  confirmedJoinsPerComment: number;
};

export type FacebookGlobalReelCadenceParameters = {
  persona: {
    viewsPerLike: number;
    viewsPerFollow: number;
  };
  slowStart: { viewsPerFollow: number };
  rule: { viewsPerFollow: number };
  consumption: { viewsPerFollow: number };
};

/**
 * 单个环境的基线投影：属主按「全局默认 ← 环境覆盖 ← legacy 回落」合成后的成品。
 *
 * **刻意写成类型别名而不是 interface**：它要作为同步读快照载荷跨进程传输，
 * 而 TS 只给对象字面量**类型别名**隐式索引签名，interface 不满足 JSON 载荷约束。
 * 上面三个参数组同理。
 */
export type FacebookOperationPolicyBaseProjection = {
  envKey: string;
  primarySurface: FacebookPrimaryBrowseSurface;
  surfaceRevision: number;
  baseMode: FacebookBaseOperationMode;
  policyRevision: number;
  cadenceSource: FacebookCadenceSource;
  rule: FacebookRuleOperationParameters;
  consumption: FacebookConsumptionOperationParameters;
  reels: FacebookGlobalReelCadenceParameters;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type FacebookOperationPolicyBaseResolution =
  | ({ ok: true } & FacebookOperationPolicyBaseProjection)
  | { ok: false; blocker: string };

/** 账号 → 环境键。失败一律带具名理由，`binding_unavailable` 是「问不到」不是「没绑」。 */
export type FacebookOperationPolicyEnvironmentResolver = (accountId: string) =>
  | { ok: true; envKey: string }
  | {
      ok: false;
      reason: 'binding_unknown' | 'binding_conflict' | 'binding_unavailable';
    };

/**
 * 三种拿不到基线的具名原因。两个进程 MUST 报同一批串——下游按串分诊，
 * 各写一份会让同一种情况在两个进程里显示成不同故障。
 */
export const FACEBOOK_OPERATION_POLICY_UNAVAILABLE_BLOCKER =
  'facebook_operation_policy_unavailable';
export const FACEBOOK_PRIMARY_BROWSE_SURFACE_UNAVAILABLE_BLOCKER =
  'facebook_primary_browse_surface_unavailable';
export const FACEBOOK_OPERATION_ENVIRONMENT_BLOCKER_PREFIX =
  'operation_environment_';

export interface FacebookOperationBaseInput {
  /** 事实源是否已装载。**未就绪 MUST 报具名 blocker，MUST NOT 回落成某个默认基线。** */
  readonly ready: boolean;
  /** 账号 → 环境键（接口进程读自己的绑定表，自动化进程读同步读镜像）。 */
  readonly resolveEnvironment: FacebookOperationPolicyEnvironmentResolver;
  /**
   * 环境键 → 基线投影；**没有这个环境的浏览面配置时返回 null**。
   * 刻意不接受「给个默认面」——浏览面选错等于让账号在错误的界面上跑一整天。
   */
  readonly baselineForEnv: (
    envKey: string,
  ) => FacebookOperationPolicyBaseProjection | null;
}

/** 拿不到基线时**一律具名**；拿到时逐字段拷贝，绝不把属主缓存里的对象交出去。 */
export function resolveFacebookOperationBase(
  input: FacebookOperationBaseInput,
  accountId: string,
): FacebookOperationPolicyBaseResolution {
  if (!input.ready) {
    return {
      ok: false,
      blocker: FACEBOOK_OPERATION_POLICY_UNAVAILABLE_BLOCKER,
    };
  }
  const resolved = input.resolveEnvironment(String(accountId || '').trim());
  if (!resolved?.ok) {
    return {
      ok: false,
      blocker: `${FACEBOOK_OPERATION_ENVIRONMENT_BLOCKER_PREFIX}${
        resolved?.reason ?? 'binding_unavailable'
      }`,
    };
  }
  const baseline = input.baselineForEnv(resolved.envKey);
  if (!baseline) {
    return {
      ok: false,
      blocker: FACEBOOK_PRIMARY_BROWSE_SURFACE_UNAVAILABLE_BLOCKER,
    };
  }
  return { ok: true, ...cloneBaseline(baseline) };
}

/** 深拷贝到调用方改不动属主缓存的程度（rule / consumption / reels 都是可变对象）。 */
export function cloneBaseline(
  baseline: FacebookOperationPolicyBaseProjection,
): FacebookOperationPolicyBaseProjection {
  return {
    ...baseline,
    rule: { ...baseline.rule },
    consumption: { ...baseline.consumption },
    reels: cloneFacebookReelCadence(baseline.reels),
  };
}

export function cloneFacebookReelCadence(
  reels: FacebookGlobalReelCadenceParameters,
): FacebookGlobalReelCadenceParameters {
  return {
    persona: { ...reels.persona },
    slowStart: { ...reels.slowStart },
    rule: { ...reels.rule },
    consumption: { ...reels.consumption },
  };
}
