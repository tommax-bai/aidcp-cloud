/**
 * CommentScheduler — 按需评论任务的触发器与装配中枢（change comment-search-command，task 3.1/3.3 最终装配）。
 *
 * 飞书 /comment 命令式触发：解析到账号后调 triggerManual(accountId)。
 *  - 同步：账号边端在线且无在跑任务 → 启动任务（异步）并**立即**回结构化「触发」回执（开跑绿）；
 *    边端离线 → 红；已有任务在跑 → 黄（不并发抢边端）。
 *  - 异步任务：接管该账号边端（结束自动浏览）→ 跑有界换词重试（runCommentTask）→ finally 恢复浏览 →
 *    据最终结果补发结果卡片（评了绿 / 没合适黄 / 失败红，绝不染绿）。
 *
 * 装配：角色①搜索词生成 + 角色②强相关甄选 + 边端步骤（edge-steps）+ 撰写人审（compose-approve）→ CommentTaskSteps。
 * 全部依赖经构造注入（账号绑定 LLM / 人设 / 精选 / 去重 / 人审口 / 接管恢复钩子 / 结果卡片），便于单测。
 *
 * 红线：边端离线 / 任一步失败 honest-fail；按账号串行；人审保留（在 compose-approve 内）。
 */

import type { EventBus } from '../event-bus/index.js';
import type { Soul } from '../kernel/soul-types.js';
import type { PersonaBinding } from '../kernel/persona-binding.js';
import { PERSONA_UNAVAILABLE_REASON } from '../config/mirror-stop-work.js';
import { CommentSearchTermGenerator, type RoleLlmLike } from '../agents/comment-search-term-generator.js';
import { CommentTargetPicker, type CommentCandidateCard } from '../agents/comment-target-picker.js';
import { CommentComposer } from '../agents/comment-composer.js';
import type { CommentApprovalPort } from '../agents/comment-approval-gate.js';
import type { CommentCommandReceipt } from '../comm/feishu-card-contract.js';
import {
  type CommentPostResult,
  type CommentTaskResult,
  type NoteForComment,
  type TargetedCommentResult,
} from './comment-task-runner.js';
import { buildEdgeCommentSteps, type EdgePusher, type CommentDedup } from './edge-steps.js';
import { buildFacebookEdgeSteps } from './facebook-edge-steps.js';
import { buildComposeAndApprove, type AutoApproveCommentNotification, type PostProcessorLike } from './compose-approve.js';
import { sendAutoApproveNotificationBestEffort } from './auto-approve-notification.js';
import type { ContentScheduleApprovalMode } from '../kernel/content-schedule-mode.js';
import type { CuratedSampleForTerms } from '../agents/comment-search-term-generator.js';
import type { CuratedContentTypeFilter } from '../kernel/curated-content-types.js';
import {
  XHS_COMMENT_PROFILE,
  commentProfileForPlatform,
  defaultCommentSearchLabel,
  type PlatformId,
  type CommentPlatformProfile,
} from '../platform/index.js';
import { validateFacebookComment } from './facebook-comment-validators.js';
import type { EffectiveFacebookCommentConfig } from '../config/facebook-comment-config-store.js';
import type { FacebookCommentAuditRow, FacebookCommentOutcome } from './facebook-comment-audit-store.js';
import { EdgeTaskLeaseError, type EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';
import type { EdgeTaskPriority } from '../comm/protocol.js';

export interface FacebookCoverageCommentConfig extends EffectiveFacebookCommentConfig {
  coverageEnabled: boolean;
  /**
   * 放开时限兜底命中标记（change facebook-coverage-relax-and-keyword-space）：正常预热/冷却约束下无可评群、
   * 降级放开时限选出的群 → true。仅用于在飞书人审卡标注「未满足冷却/预热」，不改变任何其它闸（日上限/人审照旧）。
   */
  relaxed?: boolean;
}

export interface CommentResultReceipt {
  ok: boolean;
  level: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

/**
 * runFacebookTargetedTask 的终态（change facebook-manual-join-comment）：供「加群 + 评论」合并结果卡取用。
 * 非 override 调用者（普通 /comment、排期评论）可忽略返回值——沿用既有 void 语义、零回归。
 */
export interface FacebookCommentRunResult {
  outcome: FacebookCommentOutcome;
  reason?: string;
  container?: string;
}

/** Stable terminal observation used by queued delegated tasks; only verified `commented` is a success. */
export type CommentTerminalObservation = CommentTaskResult | FacebookCommentRunResult;

/**
 * 人类可读群名（回执/审计一律用群名、绝不显裸群 id/URL，见 facebook-scheduled-comment 约定）：
 * 已解析出真名则用之；候选是裸 URL / 群链接 / 缺失 → 中性占位「目标群」。
 */
export function humanGroupLabel(candidate?: string): string {
  const c = (candidate ?? '').trim();
  if (!c || /^https?:\/\//i.test(c) || /facebook\.com\/groups\//i.test(c)) return '目标群';
  return c;
}

/** 加群未成会员（未触发 / gated / pending / ambiguous / 失败）→ 诚实结果卡（不评论、绝不染绿；不显裸群 id/URL）。 */
export function joinOnlyReceipt(join: {
  triggered: boolean;
  reason?: string;
  groupUrl?: string;
  outcome?: string;
}): CommentResultReceipt {
  if (!join.triggered) {
    switch (join.reason) {
      case 'disabled':
        return { ok: false, level: 'warning', title: '未加群', message: '账号自动加群配置未开启；未加群也未评论。' };
      case 'edge_offline':
        return { ok: false, level: 'error', title: '未加群', message: '该账号暂无在线边端；未加群也未评论。' };
      case 'running':
        return { ok: false, level: 'warning', title: '未加群', message: '该账号已有加群任务在跑，请等其结束；本次未加群也未评论。' };
      case 'quota_denied':
        return { ok: false, level: 'warning', title: '未加群', message: '加群配额已用尽（风控 日/时/分 上限）；未加群也未评论。' };
      case 'session_budget':
        return { ok: false, level: 'warning', title: '未加群', message: '本场会话加群额度已用尽；未加群也未评论。' };
      case 'no_targets':
        return { ok: false, level: 'warning', title: '未加群', message: '没有可加入的新群目标（目标库为空、均已加入或被排除）；未加群也未评论。' };
      case 'not_facebook_account':
        return { ok: false, level: 'warning', title: '未加群', message: '该账号非 Facebook 账号；加群评论仅支持 Facebook。' };
      case 'invalid_group_url':
        return { ok: false, level: 'warning', title: '未加群', message: '提供的群链接不是有效的 Facebook 群地址；未加群也未评论。' };
      case 'owned_by_other_account':
        return { ok: false, level: 'warning', title: '未加群', message: '该群已归属其他账号，无法为本账号加入同一群；未加群也未评论。' };
      default:
        return { ok: false, level: 'error', title: '未加群', message: `加群未触发（${join.reason ?? 'unknown'}）；未加群也未评论。` };
    }
  }
  switch (join.outcome) {
    case 'gated_skip':
      return { ok: false, level: 'warning', title: '未加入该群', message: `目标群需审批加入，判定为「审批门」已诚实跳过（不点、绝不留悬挂请求）；未评论。` };
    case 'pending':
      return { ok: false, level: 'warning', title: '加群待审批', message: `已点「加入」但该群需管理员审批，状态 pending；通过后可再评论。本次未评论。` };
    case 'ambiguous_skip':
      return { ok: false, level: 'warning', title: '未加入该群', message: `加群前观察结果不明确，fail-closed 跳过（绝不误点）；未评论。` };
    case 'no_button':
      return { ok: false, level: 'warning', title: '未加入该群', message: `未在群页找到「加入」按钮；未评论。` };
    case 'login_required':
    case 'blocked_by_captcha':
      return { ok: false, level: 'error', title: '加群受阻', message: `账号需要登录或遇到验证码，已按流程暂停加群；未评论。` };
    case 'nav_error':
      return { ok: false, level: 'error', title: '加群失败', message: `打开群页失败；未评论。` };
    default:
      return { ok: false, level: 'error', title: '加群失败', message: `加群未成功（${join.outcome ?? join.reason ?? 'unknown'}）；未评论。` };
  }
}

/** 已加群，将评论终态映射为人话原因（用于「已加群但未评论」黄卡）。 */
export function commentOutcomeReason(c: FacebookCommentRunResult): string {
  switch (c.outcome) {
    case 'no_targets':
      return c.reason === 'no_keywords' ? '该账号未配置 Facebook 评论关键词' : '群内无可评论目标';
    case 'no_strong_candidate':
      return '群内未找到合适的可评论帖子';
    case 'compose_skipped':
      if (c.reason === 'contact_info_missing') return '未配置联系方式';
      if (c.reason === 'approval_rejected_or_timeout') return '人审未通过或超时';
      if (c.reason === 'empty_compose') return '评论撰写为空';
      return `评论未通过校验（${c.reason ?? ''}）`;
    case 'login_required':
      return '账号需要登录或遇到验证码';
    case 'verification_ambiguous':
      return '提交后无法确认评论已上墙';
    case 'pending_group_approval':
      return '该群需管理员批准参与后才能评论（评论未上墙，待人工处理）';
    case 'comment_rejected':
      return 'Facebook 已拒绝该评论（未上墙，需人工处理）';
    case 'quota_denied':
      return c.reason === 'daily_cap' ? '当日评论已达上限' : '评论配额不足';
    default:
      return `评论失败（${c.outcome}${c.reason ? ':' + c.reason : ''}）`;
  }
}

/** 已加群 → 合并「加群 + 评论」结果卡（评上=绿；加了群没评上=黄，部分成功绝不染绿）。 */
export function joinCommentReceipt(
  join: { outcome?: string; groupUrl?: string },
  comment: FacebookCommentRunResult,
  withContact: boolean,
): CommentResultReceipt {
  // 群名优先用评论侧回填的真名；裸 URL / 缺失 → 中性占位（回执绝不显裸群 id/URL）。join.groupUrl 恒为裸链接故不入回执。
  const groupLabel = humanGroupLabel(comment.container);
  const joinedWord = join.outcome === 'already_member' ? '（已是该群成员）' : '已加入新群';
  if (comment.outcome === 'commented') {
    return {
      ok: true,
      level: 'success',
      title: '加群 + 评论成功',
      message: `${joinedWord}「${groupLabel}」，并已在群内发出一条${withContact ? '带联系方式的' : ''}评论（服务器已确认）。`,
    };
  }
  return {
    ok: false,
    level: 'warning',
    title: '已加群，但未评论',
    message: `${joinedWord}「${groupLabel}」，但群内评论未发出：${commentOutcomeReason(comment)}。`,
  };
}

export interface CommentSchedulerDeps {
  /** 解析该账号的连接运行时（私有总线 + 在线 edgeId）；null / 无 edgeId = 边端离线（honest 拒绝）。 */
  resolveConnection: (accountId: string) => { bus: EventBus; edgeId?: string } | null;
  pusher: EdgePusher;
  edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  getSoul: (accountId: string) => Soul;
  /** 人设绑定判定（persona-driven-content-pipeline）：注入则触发前闸——未绑人设的账号不接管边端、不启动评论任务，绝不以默认人设代评。缺省→不闸（向后兼容旧构造 / 测试桩）。 */
  /**
   * 人设绑定判据（**三态**，change config-mirror-cross-process-invalidation task 4.4）：
   * 只有权威的 `unbound` 才允许说「该账号未绑定人设」；`unknown` 是云端读不到，须说另一句话。
   */
  personaBinding?: (accountId: string) => PersonaBinding;
  /**
   * 读账号「联系方式」（change account-group-chat-injection）：/comment --contact 时任务开始处**解析一次**，
   * 缺联系方式 → fail-closed（触发闸回黄色告警、本次不发）；有则同一个已解析值一路带到注入（gate 与注入同源，无 TOCTOU）。
   * 缺省 → 无法取值（--contact 时一律 fail-closed）。
   */
  getContactInfo?: (accountId: string) => Promise<string | null>;
  /** 取精选样本喂搜索词生成（按账号；出错回 []）。 */
  selectCurated: (accountId: string, contentType: CuratedContentTypeFilter, limit: number) => Promise<CuratedSampleForTerms[]>;
  /** 账号绑定 LLM（计 token 归属该账号）。 */
  llmFor: (accountId: string) => RoleLlmLike;
  /** 该账号每笔记去重（InteractionDedup）。 */
  dedupFor: (accountId: string) => CommentDedup;
  /** 评论人审口（复用发帖 /tmp 信号机制）；未接线 → compose-approve 一律不发。 */
  approval?: CommentApprovalPort;
  /** 免审旁路通知口；未接线或发送失败只记日志，不参与授权。 */
  autoApproveNotify?: AutoApproveCommentNotification;
  /** 账号全局评论审批覆盖；所有命令式/定向来源在授权前统一现读。 */
  resolveApprovalMode?: (
    accountId: string,
    sourceMode: ContentScheduleApprovalMode,
  ) => Promise<ContentScheduleApprovalMode>;
  /** 去 AI 味处理器（可带账号 rewrite）；缺省仅扫描。窄口见 compose-approve 的 PostProcessorLike（automation 侧 port）。 */
  postProcessorFor?: (accountId: string) => PostProcessorLike;
  /** @deprecated 页面执行权改由 edgeTaskLeases 管理；保留可选形状兼容旧测试构造。 */
  onTakeoverStart?: (accountId: string) => void;
  /** @deprecated 不再由评论 finally 无条件恢复浏览。 */
  onTakeoverEnd?: (accountId: string) => void;
  /**
   * 任务跑完补发结果卡片（level 按结果，绝不染绿）。`source` 标注触发来源用于回执可辨识
   * （change comment-keep-open-through-approval）：人工 `/comment` vs 自动排期评论——缺省视为 `/comment`。
   */
  postResultCard?: (
    accountId: string,
    receipt: CommentResultReceipt,
    source?: string,
    /**
     * 命令来源会话（change unify-card-routing-origin-then-team）：手动 `/comment` 的终态结果卡回下命令的
     * 那个会话，与其审批卡同投一处（防「两卡两群」）。缺省（自动排期）→ 回落账号团队群 → 默认群。
     */
    originChatId?: string,
  ) => Promise<void> | void;
  /**
   * 排期任务「根本没开始」（未接管边端：浏览器停泊唤不醒 / acquire 超时 / 边端掉线）时回调一次
   * （change browser-slot-scheduling）。排期调度器据此**归还这一小时的名额**并在小时内有界重试。
   * 只对自动排期任务回调；手动 /comment 与排期名额无关。
   */
  /** 返回 true 表示排期器已接管本次自动任务的重试与最终放弃通知，可抑制逐次结果卡。 */
  onScheduledTaskNotStarted?: (accountId: string, action: 'comment' | 'contact_comment', reason: string) => boolean | void;
  /** 原生筛选（缺省 most_collected / one_day）。 */
  sort?: string;
  timeWindow?: string;
  /** 平台评论 profile；缺省 xhs，后续 Facebook 由账号平台注入。 */
  platformProfile?: CommentPlatformProfile;
  /** 账号平台事实源（accounts.platform）；注入后按账号选择 comment profile。 */
  getPlatform?: (accountId: string) => Promise<PlatformId> | PlatformId;
  /** 换词尝试上限 K（缺省 5）。 */
  maxTerms?: number;
  /** 边端单步超时（缺省 edge-steps 默认 28s）。 */
  stepTimeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;

  // ── facebook-scheduled-comment 2.2/2.3：Facebook 定向评论执行（缺省全不注入 → FB 分支继续诚实拒绝，零回归） ──
  /** 读该账号 FB 定向评论配置（关键词 + 正文模式 / 模板；目标群由 joined ledger 另选）。 */
  facebookConfigFor?: (accountId: string) => EffectiveFacebookCommentConfig;
  /**
   * FB 评论撰写（无人值守，不走人审）：**读了再写**（change facebook-comment-read-before-write）——
   * 按关键词/容器 + **帖子正文（图片帖常空）+ 顶部他人评论** 产草稿，顺着讨论、用**内容语言**写；返回 null=撰写失败。
   */
  facebookCompose?: (
    accountId: string,
    ctx: { keyword: string; container: string; postText?: string; comments?: string[] },
  ) => Promise<string | null>;
  /** 真发路径风控闸：canDo('comment')。 */
  facebookCanComment?: (accountId: string) => Promise<boolean>;
  /** 真发路径日上限（当日已评数 / 上限）。 */
  facebookCommentedToday?: (accountId: string) => Promise<number>;
  facebookDailyCap?: (accountId: string) => number;
  /** best-effort 审计 sink（每次触发一行，含影子）。 */
  facebookAudit?: (row: FacebookCommentAuditRow) => void;
  /** 回填容器真实群名（change facebook-container-display-name）：边缘搜索时读出真名 → 刷新配置容器名（人只看群名）。 */
  facebookResolveContainerName?: (accountId: string, url: string, name: string) => Promise<void> | void;
  /**
   * Facebook joined-group selector。正常 FB 评论的唯一容器来源；若 enabled=false 则必须 no-op，
   * 不能回退 legacy 配置容器或全站搜索。
   */
  facebookCoverageConfigFor?: (accountId: string) => FacebookCoverageCommentConfig | Promise<FacebookCoverageCommentConfig>;
  facebookCoverageOnCommented?: (accountId: string, groupUrl: string) => Promise<void> | void;
  facebookCoverageOnFailure?: (accountId: string, groupUrl: string, reason: string) => Promise<void> | void;
  /**
   * Facebook 手动「加群再评论」（change facebook-manual-join-comment）：让该账号加入**一个新群**并返回结果。
   * 复用云端加群调度器 triggerScheduled（含 kill switch / 判定 fail-closed / 账本）；outcome ∈
   * {joined, already_member, gated_skip, pending, ambiguous_skip, join_failed, nav_error, no_button, ...}，triggered=false 时带 reason
   * （disabled / edge_offline / running / no_targets / not_facebook_account；opts.manual=false 时另有 quota_denied / session_budget）。
   * opts.manual=true（手动 /comment --join，change manual-comment-bypass-quota）：加群跳过配额闸（会话额度 + 风控速率/状态），
   *   故手动路径**绝不**再回 quota_denied / session_budget；只守物理闸。缺省未注入 → /comment --join 诚实拒（加群未接线），绝不静默降级为普通评论。
   */
  facebookJoinNewGroup?: (
    accountId: string,
    opts?: { manual?: boolean },
  ) => Promise<{ triggered: boolean; reason?: string; groupUrl?: string; outcome?: string }>;
  /**
   * Facebook 手动「加入指定群再评论」（change facebook-comment-review-and-targeted-join，`/comment --join=<url>`）：
   * 加入**该指定 url** 的群，只归该账号（per-account 成员行、target 以 enabled=false 兜 FK，绝不外泄成公共自动加群目标）。
   * 已是成员 → 直接返回 already_member 快路（不走边端回合）；结果 shape 同 facebookJoinNewGroup。
   * triggered=false 另有 reason：invalid_group_url（链接非法）/ owned_by_other_account（该群已归属别的账号）。
   * 缺省未注入 → `/comment --join=<url>` 诚实拒（加群未接线），**绝不**回落到 facebookJoinNewGroup 的「下一个库内群」。
   */
  facebookJoinSpecificGroup?: (
    accountId: string,
    groupUrl: string,
    opts?: { manual?: boolean },
  ) => Promise<{ triggered: boolean; reason?: string; groupUrl?: string; outcome?: string }>;
  /** 选关键词/容器的随机源（测试注入定值；缺省 Math.random）。 */
  random?: () => number;
}

// ── Facebook 边端步骤诚实非成功原因 → 审计 outcome 映射（reason 原文另存审计行 reason 字段供取证）──

/** 搜索步骤失败 → outcome。阻断态（登录/验证码）归 login_required（触发跳过账号 + 告警）；容器不可用归 no_targets。 */
function mapFacebookBlockOutcome(reason?: string): FacebookCommentOutcome {
  switch (reason) {
    case 'login_required':
    case 'blocked_by_captcha':
      return 'login_required';
    case 'permission_gated':
      return 'no_targets'; // 容器非成员/门槛 = 无可用目标（fail-closed）
    default:
      return 'submit_failed'; // timeout / nav_error / 未知
  }
}

/** 开帖步骤失败 → outcome。阻断态归 login_required；候选帖不可用（无评论框/开帖失败）归 no_strong_candidate。 */
function mapFacebookOpenOutcome(reason?: string): FacebookCommentOutcome {
  switch (reason) {
    case 'login_required':
    case 'blocked_by_captcha':
      return 'login_required';
    default:
      return 'no_strong_candidate'; // editor_not_found / open_failed / not_facebook / timeout
  }
}

/** 提交步骤失败 → outcome。阻断态归 login_required；确认不了归 verification_ambiguous；其余归 submit_failed。 */
function mapFacebookSubmitOutcome(reason?: string): FacebookCommentOutcome {
  switch (reason) {
    case 'login_required':
    case 'blocked_by_captcha':
      return 'login_required';
    case 'verification_ambiguous':
      return 'verification_ambiguous';
    case 'pending_group_approval':
      // 群参与审批入群闸：评论未上墙、待管理员批准。**绝不**塌进 verification_ambiguous（那读作「可能已发出」+ 写去重）——
      // 这里评论确未发出，须自成一档诚实终态（不染绿、不去重、可待批准后重试）。
      return 'pending_group_approval';
    case 'comment_rejected':
      // 平台已拒绝（change facebook-comment-lifecycle-verify；真机 2026-07-17 坐实被拒行 `… 已拒绝 查看反馈`）：
      // 评论**确定未上墙、终局**。**绝不**塌进 verification_ambiguous——那读作「可能已发出」**且会打去重**，
      // 等于把一个确定失败当成可能成功、还顺手把目标帖永久烧掉；也**绝不**塌进 pending_group_approval（那是可等、
      // 批准后可重试，而被拒是终局、重试无意义）。自成一档：不染绿、不去重（`reallySubmitted` 白名单不含本档）、留人工。
      return 'comment_rejected';
    default:
      return 'submit_failed'; // identity_unknown / editor_not_found / submit_control_* / marker_not_accepted / timeout
  }
}

export class CommentScheduler {
  private readonly running = new Set<string>();

  constructor(private readonly deps: CommentSchedulerDeps) {}

  private async platformProfileFor(accountId: string): Promise<CommentPlatformProfile> {
    if (!this.deps.getPlatform) return this.deps.platformProfile ?? XHS_COMMENT_PROFILE;
    return commentProfileForPlatform(await this.deps.getPlatform(accountId));
  }

  private async effectiveApprovalMode(
    accountId: string,
    sourceMode: ContentScheduleApprovalMode = 'review',
  ): Promise<ContentScheduleApprovalMode> {
    if (!this.deps.resolveApprovalMode) return sourceMode;
    try {
      return await this.deps.resolveApprovalMode(accountId, sourceMode);
    } catch (error) {
      (this.deps.logger ?? console).warn(
        `[comment-scheduler] 账号评论审批策略解析失败，回落来源模式 account=${accountId} mode=${sourceMode}: ${(error as Error).message}`,
      );
      return sourceMode;
    }
  }

  /** 是否该账号已有任务在跑（观测用）。 */
  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  /** 飞书 /comment 触发：返回「触发态」结构化回执；最终结果异步补发结果卡片。 */
  async triggerManual(
    accountId: string,
    options?: {
      injectContact?: boolean;
      priority?: EdgeTaskPriority;
      joinFirst?: boolean;
      joinGroupUrl?: string;
      manualOverride?: boolean;
      force?: boolean;
      fastReturnToFeed?: boolean;
      approvalMode?: ContentScheduleApprovalMode;
      /** 命令来源会话（change unify-card-routing-origin-then-team）：审批卡 / 终态卡回下命令的会话；缺省 → 账号团队群 → 默认群。 */
      originChatId?: string;
      /** Async terminal observation. Existing callers may omit it; queued tasks use it for honest accounting. */
      onResult?: (result: CommentTerminalObservation) => Promise<void> | void;
    },
  ): Promise<CommentCommandReceipt> {
    if (!accountId || accountId === 'default') {
      return { ok: false, level: 'error', title: '按需评论触发失败', message: '未解析到有效账号（绝不回落 default）' };
    }
    const binding = this.deps.personaBinding?.(accountId) ?? 'bound';
    if (binding === 'unbound') {
      return { ok: false, level: 'warning', title: '未触发按需评论', message: '该账号未绑定人设——请先到后台「人设」页设置；未绑人设不启动评论任务，绝不以默认人设代评。' };
    }
    if (binding === 'unknown') {
      // 人设副本陈旧：MUST NOT 说「未绑定人设」——那是对运营的错误指认，会让人去补一份早就存在的配置。
      return { ok: false, level: 'warning', title: '未触发按需评论', message: '云端暂时读不到该账号的人设配置（配置副本陈旧），本次不发；稍后自动恢复，无需改配置。' };
    }
    // 联系方式闸（change account-group-chat-injection）：--contact 时**解析一次**——缺联系方式 fail-closed（本次不发，
    // 绝不静默降级成无联系方式评论，镜像上面的 isPersonaBound 闸）；有则用同一个已解析值注入（gate 与注入同源，无 TOCTOU）。
    let contactInfo: string | null = null;
    if (options?.injectContact) {
      contactInfo = this.deps.getContactInfo ? await this.deps.getContactInfo(accountId) : null;
      if (!contactInfo) {
        return {
          ok: false,
          level: 'warning',
          title: '未触发按需评论',
          message: '该账号未配置「联系方式」——请先到后台账号页设置；要求带联系方式但未配，本次不发（绝不发无联系方式评论）。',
        };
      }
    }
    if (this.running.has(accountId)) {
      return { ok: false, level: 'warning', title: '未触发按需评论', message: '该账号已有评论任务在跑，请等其结束' };
    }
    const conn = this.deps.resolveConnection(accountId);
    if (!conn || !conn.edgeId) {
      // 瞬时失败：边端可能马上回来（重连 / 冷待机唤醒中）。code 让排期调度器归还小时格、在本小时内有界重试。
      return { ok: false, level: 'error', title: '按需评论触发失败', message: '该账号暂无在线边端', code: 'edge_offline' };
    }
    let platformProfile: CommentPlatformProfile;
    try {
      platformProfile = await this.platformProfileFor(accountId);
    } catch (err) {
      return {
        ok: false,
        level: 'error',
        title: '按需评论触发失败',
        message: `该账号平台暂不支持评论调度：${(err as Error).message}`,
      };
    }
    const approvalMode = await this.effectiveApprovalMode(accountId, options?.approvalMode ?? 'review');

    // 加群评论（change facebook-manual-join-comment）：--join 仅 Facebook 有效。非 FB 账号诚实拒——绝不静默降级成普通评论。
    if (options?.joinFirst && platformProfile.platform !== 'facebook') {
      return {
        ok: false,
        level: 'warning',
        title: '未触发加群评论',
        message: '「加群评论」（--join）仅支持 Facebook 账号；该账号平台不支持，未加群也未评论。',
      };
    }

    // facebook-scheduled-comment 2.2：Facebook 走独立定向评论路径（关键词+容器，绝不回落 xhs 搜索）。
    // FB deps 注入时路由到 runFacebookTargetedTask（影子先行）；未注入则维持诚实拒绝（零回归）。
    if (platformProfile.platform === 'facebook') {
      if (!this.deps.facebookConfigFor) {
        return {
          ok: false,
          level: 'error',
          title: '按需评论触发失败',
          message: 'Facebook 定向评论执行尚未接入（facebook-scheduled-comment 2.2 待实装）；不回落 xhs 搜索流程',
        };
      }
      // 加群评论（change facebook-manual-join-comment / facebook-comment-review-and-targeted-join）：
      // 先加群、加入成功后在群内评论。--join（无 url）加下一个库内群；--join=<url> 加入**指定群**（只归该账号）。人工授权、单飞、异步补合并结果卡。
      if (options?.joinFirst) {
        const targetedUrl = options?.joinGroupUrl;
        // --join=<url> 走「加入指定群」路径，需 facebookJoinSpecificGroup 接线；未接线诚实拒，**绝不**回落到「下一个库内群」。
        if (targetedUrl && !this.deps.facebookJoinSpecificGroup) {
          return {
            ok: false,
            level: 'error',
            title: '未触发加群评论',
            message: '「加入指定群」能力未接线（facebookJoinSpecificGroup 未注入）；本次不加群也不评论，绝不改加其它群。',
          };
        }
        if (!targetedUrl && !this.deps.facebookJoinNewGroup) {
          return {
            ok: false,
            level: 'error',
            title: '未触发加群评论',
            message: '加群能力未接线（facebookJoinNewGroup 未注入）；本次不加群也不评论。',
          };
        }
        this.running.add(accountId);
        void this.runFacebookJoinThenComment(accountId, {
          injectContact: options?.injectContact,
          contactInfo,
          ...(targetedUrl ? { joinGroupUrl: targetedUrl } : {}),
          manualOverride: options?.manualOverride === true,
          force: options?.force === true,
          fastReturnToFeed: options?.fastReturnToFeed === true,
          approvalMode,
          ...(options?.originChatId ? { originChatId: options.originChatId } : {}),
        })
          .then((result) => options?.onResult?.(result))
          .catch((err) =>
            (this.deps.logger ?? console).warn(
              `[comment-scheduler] FB 加群评论任务异常 account=${accountId}：${(err as Error).message}`,
            ),
          )
          .finally(() => this.running.delete(accountId));
        return {
          ok: true,
          level: 'success',
          title: '已触发「加群 + 评论」',
          message: `已触发 Facebook 加群 + 评论：${
            targetedUrl ? '加入指定群' : '先加入一个新群'
          }，加入成功（或已是成员）后在该群里发一条评论${
            options?.injectContact
              ? approvalMode === 'auto_approve' ? '（带联系方式，全局免审）' : '（带联系方式，走飞书人审）'
              : ''
          }${options?.force ? '（--force：跳过相关性/去重）' : ''}；结果稍后回报。`,
        };
      }
      this.running.add(accountId);
      // 手动 /comment（本方法为飞书手动出口）：manualOverride 透传到评论体 → 真发路径跳过评论配额 / 日上限闸。
      // 自动排期评论走独立入口（triggerTargeted / ContentScheduler），不带此旗标、配额照旧。
      void this.runFacebookTargetedTask(accountId, {
        injectContact: options?.injectContact,
        contactInfo,
        manualOverride: options?.manualOverride === true,
        force: options?.force === true,
        fastReturnToFeed: options?.fastReturnToFeed === true,
        approvalMode,
        ...(options?.originChatId ? { originChatId: options.originChatId } : {}),
      })
        .then((result) => options?.onResult?.(result))
        .catch((err) =>
          (this.deps.logger ?? console).warn(
            `[comment-scheduler] FB 定向评论任务异常 account=${accountId}：${(err as Error).message}`,
          ),
        )
        .finally(() => this.running.delete(accountId));
      return { ok: true, level: 'success', title: '已触发 Facebook 定向评论', message: `已触发 Facebook 定向评论 · 按账号审批/风控/冷却/上限执行${options?.force ? ' · --force（跳过相关性/去重）' : ''}；结果稍后回报` };
    }

    this.running.add(accountId);
    const edgeId = conn.edgeId;
    const bus = conn.bus;
    // 异步跑任务，命令立即回执（任务含人审轮询，不可同步等）。contactInfo 已解析一次，带进任务用于注入（gate 同源）。
    // catch：runTask 内部已兜任务期异常；此处兜「任务启动前」的防御性抛（如 gate 后人设被解绑 → getSoul 抛
    // no_persona，persona-driven-content-pipeline）——诚实记日志、不让未处理拒绝炸进程，绝不假成功。
    void this.runTask(
      accountId,
      bus,
      edgeId,
      contactInfo,
      platformProfile,
      options?.priority ?? 'human',
      options?.force === true,
      options?.fastReturnToFeed === true,
      approvalMode,
      options?.onResult,
      options?.originChatId,
    )
      .catch((err) =>
        (this.deps.logger ?? console).warn(
          `[comment-scheduler] 任务未能启动/异常中止 account=${accountId}：${(err as Error).message}`,
        ),
      )
      .finally(() => this.running.delete(accountId));

    return {
      ok: true,
      level: 'success',
      title: '已触发按需评论',
      message: options?.force
        ? `已启动按需评论任务（--force：跳过「强相关」甄选与已评过去重——没强相关目标则选收藏最高的一篇、已评过的也可再评；${approvalMode === 'auto_approve' ? '账号全局免审' : '评论前仍需飞书人审 approved=true'}；结果稍后回报）`
        : `已启动按需评论任务（搜「${defaultCommentSearchLabel(platformProfile)}」的强相关、未评过笔记；${approvalMode === 'auto_approve' ? '账号全局免审' : '评论前仍需飞书人审 approved=true'}；结果稍后回报）`,
    };
  }

  /**
   * 定向评论触发（change curated-note-actions）：管理后台精选页对指定笔记评论。
   * 与 triggerManual 守卫同构（账号/人设/联系方式 fail-closed/单飞/边端在线），另加**去重前置**（已评过 → 诚实拒绝）。
   * 目标定位为搜索驱动（标题截断作搜索词、综合排序+不限时间窗、结果内按 noteId 精确匹配），绝不导航存量 URL。
   */
  async triggerTargeted(
    accountId: string,
    target: { noteId: string; title: string },
    options?: {
      injectContact?: boolean;
      /** 已经处于目标笔记详情页时传入：直接评论当前笔记，不走标题搜索兜底。 */
      currentNote?: NoteForComment;
      /** 异步任务最终结果回调；用于自动联系评论在真正 commented 后再记风控配额。 */
      onResult?: (result: TargetedCommentResult) => Promise<void> | void;
      /** 自动排期/热度触发用 automatic；人工入口缺省 human。 */
      priority?: EdgeTaskPriority;
      approvalMode?: ContentScheduleApprovalMode;
      /** 命令来源会话（change unify-card-routing-origin-then-team）：审批卡 / 终态卡回下命令的会话；缺省 → 账号团队群 → 默认群。 */
      originChatId?: string;
    },
  ): Promise<CommentCommandReceipt & { reason?: string }> {
    if (!accountId || accountId === 'default') {
      return { ok: false, level: 'error', title: '定向评论触发失败', message: '未解析到有效账号（绝不回落 default）', reason: 'account_required' };
    }
    if (!target.noteId || !target.title.trim()) {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '目标笔记缺 noteId 或标题为空，无法搜索定位', reason: 'bad_target' };
    }
    const binding = this.deps.personaBinding?.(accountId) ?? 'bound';
    if (binding === 'unbound') {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '该账号未绑定人设——请先到后台「人设」页设置；未绑人设不启动评论任务，绝不以默认人设代评。', reason: 'needs_persona' };
    }
    if (binding === 'unknown') {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '云端暂时读不到该账号的人设配置（配置副本陈旧），本次不发；稍后自动恢复，无需改配置。', reason: PERSONA_UNAVAILABLE_REASON };
    }
    let contactInfo: string | null = null;
    if (options?.injectContact) {
      contactInfo = this.deps.getContactInfo ? await this.deps.getContactInfo(accountId) : null;
      if (!contactInfo) {
        return {
          ok: false,
          level: 'warning',
          title: '未触发定向评论',
          message: '该账号未配置「联系方式」——请先到后台账号页设置；要求带联系方式但未配，本次不发（绝不发无联系方式评论，也不降级为内容评论）。',
          reason: 'contact_info_missing',
        };
      }
    }
    // 去重前置：已评过该笔记 → 诚实拒绝，不发起边端任务（PG 出错按未评处理，与 /comment 去重同容错取向）。
    // 位置铁律：这个 await 必须排在下面的单飞闸「has→add」之前——否则闸的检查与置位被 await 切开、
    // 事件循环里被并发触发插入，两个触发都过闸并发驱动同一边端（对抗审查确诊的 TOCTOU）。triggerManual 亦守此序。
    const alreadyCommented = await this.deps
      .dedupFor(accountId)
      .hasInteracted(target.noteId, 'comment')
      .catch(() => false);
    if (alreadyCommented) {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '该账号已评论过这篇笔记（去重账本命中），不重复评论', reason: 'already_commented' };
    }
    // 单飞闸 + 起跑：has 检查、resolveConnection、add 三步全同步、其间无 await，事件循环内原子，杜绝并发双触发。
    if (this.running.has(accountId)) {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '该账号已有评论任务在跑，请等其结束', reason: 'running' };
    }
    const conn = this.deps.resolveConnection(accountId);
    if (!conn || !conn.edgeId) {
      return { ok: false, level: 'error', title: '定向评论触发失败', message: '该账号暂无在线边端', reason: 'edge_offline' };
    }
    let platformProfile: CommentPlatformProfile;
    try {
      platformProfile = await this.platformProfileFor(accountId);
    } catch (err) {
      return {
        ok: false,
        level: 'error',
        title: '定向评论触发失败',
        message: `该账号平台暂不支持评论调度：${(err as Error).message}`,
        reason: 'unsupported_platform',
      };
    }
    const approvalMode = await this.effectiveApprovalMode(accountId, options?.approvalMode ?? 'review');

    // facebook-scheduled-comment 2.2：FB 走独立定向评论路径（关键词+容器），绝不回落 xhs 定位流程。
    // 注：面板定向入口的具体 target 对 FB 不适用（FB 由配置的关键词/容器驱动），故 target 被忽略。
    if (platformProfile.platform === 'facebook') {
      if (!this.deps.facebookConfigFor) {
        return {
          ok: false,
          level: 'error',
          title: '定向评论触发失败',
          message: 'Facebook 定向评论执行尚未接入（facebook-scheduled-comment 2.2 待实装）；不回落 xhs 流程',
          reason: 'unsupported_platform',
        };
      }
      this.running.add(accountId);
      void this.runFacebookTargetedTask(accountId, {
        injectContact: options?.injectContact,
        contactInfo,
        approvalMode,
        ...(options?.originChatId ? { originChatId: options.originChatId } : {}),
      })
        .catch((err) =>
          (this.deps.logger ?? console).warn(
            `[comment-scheduler] FB 定向评论任务异常 account=${accountId}：${(err as Error).message}`,
          ),
        )
        .finally(() => this.running.delete(accountId));
      return { ok: true, level: 'success', title: '已触发 Facebook 定向评论', message: '已触发 Facebook 定向评论 · 按账号审批/风控/冷却/上限执行；结果稍后回报' };
    }

    this.running.add(accountId);
    void this.runTargetedTask(
      accountId,
      conn.bus,
      conn.edgeId,
      { ...target, currentNote: options?.currentNote },
      contactInfo,
      platformProfile,
      options?.priority ?? 'human',
      options?.onResult,
      approvalMode,
      options?.originChatId,
    )
      .catch((err) =>
        (this.deps.logger ?? console).warn(
          `[comment-scheduler] 定向任务未能启动/异常中止 account=${accountId}：${(err as Error).message}`,
        ),
      )
      .finally(() => this.running.delete(accountId));

    return {
      ok: true,
      level: 'success',
      title: '已触发定向评论',
      message: options?.currentNote
        ? `已启动定向评论任务（复用当前笔记上下文→撰写→${approvalMode === 'auto_approve' ? '全局免审' : '飞书人审 approved=true 才会真发'}；结果稍后回报）`
        : `已启动定向评论任务（搜索定位目标笔记→撰写→${approvalMode === 'auto_approve' ? '全局免审' : '飞书人审 approved=true 才会真发'}；结果稍后回报）`,
    };
  }

  /**
   * Facebook 定向评论执行（facebook-scheduled-comment 2.2/2.3 + 真发接线 task 4.x）。
   * 闸链 → 随机选关键词/容器 → 撰写 → 只拒不修校验：
   * - 真发路径：过账号审批策略、canDo + 日上限闸后，经边端评论能力真发——
   *   容器内搜索 → 选未评候选 → 开帖 → 提交并「服务器确认」。每步有界超时（此路径无巡视看门狗）。
   *
   * 红线：
   * - 绝不走 onCommentTakeoverStart（那会把账号塞进 manualCommentAccounts）。**注意本条的理由已经换了**
   *   （change risk-record-actuated-facts）：该集合**不再跳过风控计数**（手动跳过的是闸、不是账），
   *   如今它只抑制节奏饱和告警。故本红线不再是「防漏计」，而是「本路径是**自动**真发、不是运营手动，
   *   不该冒充人工来源去吞掉告警」。结论不变，依据变了——别按旧理由推翻它。
   * - 真发成功的风控计数走 interaction.occurred → RiskController.record('comment') 自动路径（handler.ts），
   *   **绝不在此重复 record**；本方法只在**提交派发前**打 attempted 去重标记（防重复真发 §5.4，与成功计数解耦）。
   */
  private async runFacebookTargetedTask(
    accountId: string,
    options: {
      injectContact?: boolean;
      contactInfo?: string | null;
      overrideContainerUrl?: string;
      manualOverride?: boolean;
      force?: boolean;
      fastReturnToFeed?: boolean;
      approvalMode?: ContentScheduleApprovalMode;
      /** 命令来源会话（change unify-card-routing-origin-then-team）：审批卡 / 终态卡回下命令的会话；缺省 → 账号团队群 → 默认群。 */
      originChatId?: string;
    } = {},
  ): Promise<FacebookCommentRunResult> {
    // 终态捕获（change facebook-manual-join-comment）：包一层把「最后一次审计」升级为返回值，供「加群 + 评论」
    // 合并结果卡取用；body 内所有 return; 保持 void 语义不动（普通 /comment / 排期路径零回归、只是丢弃返回值）。
    let last: FacebookCommentRunResult = { outcome: 'no_targets' };
    const audit = (row: FacebookCommentAuditRow) => {
      last = {
        outcome: row.outcome,
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.container ? { container: row.container } : last.container ? { container: last.container } : {}),
      };
      try {
        this.deps.facebookAudit?.(row);
      } catch {
        /* best-effort：审计绝不波及主链路 */
      }
    };
    try {
      await this.runFacebookTargetedTaskBody(accountId, options, audit);
    } catch (err) {
      // 评论阶段意外抛出（如 PG 配额/风控读 reject、pusher 同步抛）→ 绝不静默丢：记一个诚实终态，
      // 让调用方永远拿到 closure（加群评论合并卡不会在真加群后凭空消失）。普通 /comment 路径的 void().catch 照旧不炸进程。
      (this.deps.logger ?? console).warn?.(
        `[comment-scheduler] FB 评论任务异常 account=${accountId}：${(err as Error).message}`,
      );
      last = { outcome: 'submit_failed', reason: 'exception' };
    }
    return last;
  }

  private async runFacebookTargetedTaskBody(
    accountId: string,
    options: {
      injectContact?: boolean;
      contactInfo?: string | null;
      overrideContainerUrl?: string;
      manualOverride?: boolean;
      force?: boolean;
      fastReturnToFeed?: boolean;
      approvalMode?: ContentScheduleApprovalMode;
      /** 命令来源会话（change unify-card-routing-origin-then-team）：审批卡 / 终态卡回下命令的会话；缺省 → 账号团队群 → 默认群。 */
      originChatId?: string;
    },
    audit: (row: FacebookCommentAuditRow) => void,
  ): Promise<void> {
    const d = this.deps;
    const rand = d.random ?? Math.random;
    const manualTarget = options.overrideContainerUrl?.trim() || undefined;
    const shadow = false;

    const cfg = d.facebookConfigFor!(accountId);
    if (cfg.keywords.length === 0) {
      audit({ accountId, outcome: 'no_targets', reason: 'no_keywords', shadow, ...(manualTarget ? { container: manualTarget } : {}) });
      return;
    }
    if (cfg.commentMode === 'template' && cfg.commentTemplates.length === 0) {
      audit({ accountId, outcome: 'compose_skipped', reason: 'empty_template', shadow, ...(manualTarget ? { container: manualTarget } : {}) });
      return;
    }

    const keyword = cfg.keywords[Math.floor(rand() * cfg.keywords.length)] ?? cfg.keywords[0];
    let containerUrl: string;
    let container: string;
    let coverageCfg: FacebookCoverageCommentConfig | undefined;
    const usingCoverage = true;
    if (manualTarget) {
      containerUrl = manualTarget; // 功能主键：刚加入的群 url（边缘据此站内搜）
      container = manualTarget; // 真名由 search.containerName 回填
    } else {
      coverageCfg = await d.facebookCoverageConfigFor?.(accountId);
      if (!coverageCfg?.enabled || coverageCfg.containers.length === 0) {
        audit({ accountId, outcome: 'no_targets', shadow, keyword });
        return;
      }
      const chosen = coverageCfg.containers[Math.floor(rand() * coverageCfg.containers.length)] ?? coverageCfg.containers[0];
      containerUrl = chosen.url; // 功能主键：边缘据此站内搜（含群 id）
      // 人类可读容器标签：已解析出的群名优先，否则暂用 url（下次搜索会自动回填真名）。审计/回执一律用它、不用裸 id。
      container = chosen.name ?? chosen.url;
    }

    // ── 读了再写（change facebook-comment-read-before-write）：撰写挪到开帖之后，吃到帖子正文+他人评论+内容语言 ──
    // 影子与真发都需要「搜 → 开帖」读上下文；影子做只读浏览、到校验为止绝不提交，真发再往后走。

    // 边端在线（连接可能在 trigger 后掉线；此路径无看门狗，靠每步有界超时兜底）。影子同样需要边端读帖。
    const conn = d.resolveConnection(accountId);
    if (!conn || !conn.edgeId) {
      audit({ accountId, outcome: 'submit_failed', reason: 'edge_offline', shadow, keyword, container });
      return;
    }

    // 真发路径先过风控 + 日上限闸（在浏览之前收口——被限额则不白跑一趟浏览）。影子跳过这两闸。
    // 手动操作员命令（manualOverride，飞书 /comment）跳过这两个配额闸——含风控状态 + 速率配额 + 评论日上限，
    // 与手动加群侧一致（用户定案 2026-07-10：手动命令不受配额限制、硬风控状态也强行）。自动排期评论 manualOverride=false、配额照旧。
    // 注：成功的风控计数仍走 interaction.occurred → RiskController.record 自动路径（handler.ts），绕的是**前置闸**、不漏计。
    if (!shadow && !options.manualOverride) {
      if (d.facebookCanComment && !(await d.facebookCanComment(accountId))) {
        audit({ accountId, outcome: 'quota_denied', reason: 'canDo', shadow: false, keyword, container });
        return;
      }
      if (d.facebookDailyCap && d.facebookCommentedToday) {
        const cap = d.facebookDailyCap(accountId);
        const done = await d.facebookCommentedToday(accountId);
        if (cap > 0 && done >= cap) {
          audit({ accountId, outcome: 'quota_denied', reason: 'daily_cap', shadow: false, keyword, container });
          return;
        }
      }
    }

    // ── keep-open 边端租约（change facebook-manual-comment-keepopen-lease）──
    // 把「搜索 → 开帖 → 撰写 → 飞书人审 → 提交」整段包进一个持续持有的租约，**贯穿人审等待窗口不释放边端**——
    // 否则同一会话并发的自治浏览闭环会在审批阻塞期把页面滚回首页（其 page.scroll/返回无 taskId、边端空闲时放行），
    // 审批通过后目标帖已不在页 → 提交时 own-identity 收窄评论框失败 editor_not_found（真机事故 2026-07-15）。
    // priority 按手动/排期派生（与小红书 keep-open 同口径）。steps **必须**用 lease.taskId 构建：边端 FB 命令入口
    // 按 canExecute(payload.taskId) 无差别门控——持租约期无 taskId 命令一律被挡，评论自己的命令不带 taskId 会被自锁挡死。
    // leaseMs 必须**严格覆盖**持锁期最坏的纯云耗时——否则边端 idle 计时（只由到达的 FB 命令 touch，见 canExecute/armExpiry）
    // 会在 note.open 与 interaction.comment 之间过期、finishActive('expired') 解冻自治浏览 → 页面被滚走、已授权评论的
    // 提交命令被挡（对抗复核 wf_933f178c 确证）。窗内两段纯云无命令：撰写（成功可逼近 LLM 天花板 ~180s）+ 飞书人审（≤90s）。
    // 故取 6min 严格 > (撰写 ~180s + 人审 90s + 搜索/开帖 + 往返余量)，远低于边端 30min 绝对上限。
    // 注：小红书 keep-open（:1307 的 4min）同样只按 ~150s 预算、未含撰写，存在同一薄裕度隐患——本 change 不动它（越界），登记 backlog。
    const FB_KEEP_OPEN_LEASE_MS = 6 * 60_000;
    const priority: EdgeTaskPriority = options.manualOverride ? 'human' : 'automatic';
    // conn.edgeId / conn.bus 在此已过 `!conn || !conn.edgeId` 守卫（narrowed 为非空）；捕成 const 供闭包用——
    // 控制流收窄不穿透嵌套闭包，闭包内直接读 conn.edgeId 会被 TS 当 string|undefined。
    const leaseEdgeId = conn.edgeId;
    const connBus = conn.bus;
    try {
      await this.deps.edgeTaskLeases.withLease(
        { edgeId: leaseEdgeId, kind: 'comment_prepare', priority, leaseMs: FB_KEEP_OPEN_LEASE_MS },
        async (lease) => {
          const steps = buildFacebookEdgeSteps({
            bus: connBus,
            pusher: d.pusher,
            edgeId: leaseEdgeId,
            taskId: lease.taskId,
            ...(typeof d.stepTimeoutMs === 'number' ? { stepTimeoutMs: d.stepTimeoutMs } : {}),
            logger: d.logger ?? console,
          });
          const dedup = d.dedupFor(accountId);

          // 1) 容器内搜索候选帖（边端只在 joined/pinned 群内搜、绝不全站）。用 url 下发。
          const search = await steps.searchInContainer(keyword, containerUrl);
          // 边缘回传的真实群名 → 回填配置容器名（人只看群名、不看 id）；本轮后续审计也改用真名。
          if (search.containerName) {
            container = search.containerName;
            void d.facebookResolveContainerName?.(accountId, containerUrl, search.containerName);
          }
          if (!search.ok) {
            audit({ accountId, outcome: mapFacebookBlockOutcome(search.reason), reason: search.reason, shadow, keyword, container });
            if (usingCoverage && search.reason) void d.facebookCoverageOnFailure?.(accountId, containerUrl, search.reason);
            return;
          }
          // 2) 选一个未评过的候选（防重复真发：跳过 dedup 已标记的 permalink）。
          // --force（manual-comment-force-flag）：放开每帖去重，直接取第一个候选（已评过的也可再评）；否则跳过已评过的。
          let target: string | undefined;
          if (options.force) {
            target = search.candidates[0]?.permalink;
          } else {
            for (const c of search.candidates) {
              const seen = await dedup.hasInteracted(c.permalink, 'comment').catch(() => false);
              if (!seen) {
                target = c.permalink;
                break;
              }
            }
          }
          if (!target) {
            audit({
              accountId,
              outcome: 'no_strong_candidate',
              reason: search.candidates.length === 0 ? 'no_candidates' : 'all_deduped',
              shadow,
              keyword,
              container,
            });
            return;
          }
          // 3) 开帖（permalink 直驱详情页），读回帖子正文（图片帖常空）+ 顶部他人评论。
          const open = await steps.openPost(target);
          if (!open.ok) {
            audit({ accountId, outcome: mapFacebookOpenOutcome(open.reason), reason: open.reason, shadow, keyword, container });
            if (usingCoverage && open.reason) void d.facebookCoverageOnFailure?.(accountId, containerUrl, open.reason);
            return;
          }
          const postText = open.postText;
          const comments = open.comments ?? [];

          // 4) 正文来源：生成评论读了再写；模板评论只选账号模板，不调用 LLM。
          const draft = cfg.commentMode === 'template'
            ? (cfg.commentTemplates[Math.floor(rand() * cfg.commentTemplates.length)] ?? cfg.commentTemplates[0] ?? null)
            : d.facebookCompose
              ? await d.facebookCompose(accountId, { keyword, container, ...(postText ? { postText } : {}), ...(comments.length > 0 ? { comments } : {}) })
              : null;
          if (!draft || !draft.trim()) {
            audit({ accountId, outcome: 'compose_skipped', reason: 'empty_compose', shadow, keyword, container });
            return;
          }
          // 只拒不修的确定性校验（llm-output-honesty）：相关性以「关键词 + 帖子正文 + 他人评论」为语境
          //（评论既由这些产出、天然相关；仍守零重叠即拒的兜底）。任一违规 → compose_skipped 终局，绝不修复后发。
          // --force（manual-comment-force-flag）：传空 targetKeywords → 校验器 keywords.length>0 守卫使相关性分支 no-op；
          // 但 url/联系方式/@提及/刷屏/长度/低信号等**安全校验**在其之前、照常执行（force 绝不放开安全校验）。
          const relevanceCtx = options.force ? [] : [keyword, ...(postText ? [postText] : []), ...comments].filter(Boolean);
          const v = validateFacebookComment(draft, { targetKeywords: relevanceCtx });
          if (!v.ok) {
            audit({ accountId, outcome: 'compose_skipped', reason: v.reason, shadow, keyword, container, textLength: draft.length });
            return;
          }

          // 4a) 联系方式 fail-closed：--contact 但账号没配联系方式 → 诚实退，绝不发无码评论。
          let groupChatCode: string | undefined;
          let contactInfo: string | null = null;
          if (options.injectContact) {
            contactInfo = options.contactInfo ?? null;
            if (!contactInfo) {
              audit({ accountId, outcome: 'compose_skipped', reason: 'contact_info_missing', shadow, keyword, container, textLength: v.text.length });
              return;
            }
          }

          // 5) 结构化账号/来源审批策略是唯一审批授权；未接线/超时/拒绝均不提交。
          const approved = await this.approveFacebookComment(accountId, {
            permalink: target,
            text: v.text,
            ...(contactInfo ? { contactInfo } : {}),
            container,
            ...(usingCoverage && coverageCfg?.relaxed ? { coverageRelaxed: true } : {}),
          }, options.approvalMode, options.originChatId);
          if (!approved) {
            audit({ accountId, outcome: 'compose_skipped', reason: 'approval_rejected_or_timeout', shadow: false, keyword, container, textLength: v.text.length });
            return;
          }
          if (contactInfo) groupChatCode = approved.contactInfo;

          // 6) 提交评论 + 服务器确认（边端 own-identity 收窄）。成功记风控走 interaction.occurred 自动路径，绝不在此重复 record。
          // 提交被更高优先级任务抢占 / 边端失配 taskId 静默丢弃 → submitComment 超时回 ok:false → 走 else 诚实非提交（不打去重、可重试）。
          const submit = await steps.submitComment(target, v.text, groupChatCode, options.fastReturnToFeed === true);
          // 防重复真发（BLOCKING §5.4）：仅在**真提交了**（成功 或 提交后确认不了 verification_ambiguous）时打去重标记——
          // 硬失败（权限门/找不到评论框/被拦/身份未知）没真点提交、无重复真发风险，不打标记（可重试、不白占当日上限）。
          // 该标记同时使 facebookCommentedToday 计入当日配额；仅计「真发过一次」的目标，不误伤硬失败重试。
          //
          // 🔴 这是**白名单**（只有列出的两档打去重），新增 outcome 默认落在闸外 = 不去重（安全侧）。
          // `comment_rejected` MUST NOT 进这个白名单：平台已明确拒绝该评论、它**没有上墙**，打去重等于
          // 把目标帖永久烧掉（再不会重试）却什么都没发出去。加档时请守住这条（change facebook-comment-lifecycle-verify）。
          const reallySubmitted = submit.ok || submit.reason === 'verification_ambiguous';
          if (reallySubmitted) await dedup.recordInteraction(target, 'comment').catch(() => {});
          if (submit.ok) {
            audit({ accountId, outcome: 'commented', shadow: false, keyword, container, textLength: v.text.length });
            if (usingCoverage) void d.facebookCoverageOnCommented?.(accountId, containerUrl);
          } else {
            audit({
              accountId,
              outcome: mapFacebookSubmitOutcome(submit.reason),
              reason: submit.reason,
              shadow: false,
              keyword,
              container,
              textLength: v.text.length,
            });
            if (usingCoverage && submit.reason) void d.facebookCoverageOnFailure?.(accountId, containerUrl, submit.reason);
          }
        },
      );
    } catch (err) {
      // 拿不到边端租约（边端无响应/被占，acquire 超时）→ 诚实非提交终态，不打去重、可重试（绝不静默假成功）。
      // 其它异常（含 release_timeout：work 已跑完、评论可能已发）交外层 runFacebookTargetedTask wrapper 记诚实终态。
      if (isEdgeTaskAcquireFailure(err)) {
        audit({ accountId, outcome: 'submit_failed', reason: `edge_lease_${leaseFailureDetail(err)}`, shadow, keyword, container });
        return;
      }
      throw err;
    }
  }

  /**
   * 加群 + 评论（change facebook-manual-join-comment）：先加入一个新群，加入确认成功（joined / already_member）后
   * 在该新群里发一条评论（容器 pin 到该群、强制真发但仍过校验/验证/人审）。未成会员 → 不评论、诚实回卡。合并一张结果卡。
   */
  private async runFacebookJoinThenComment(
    accountId: string,
    options: {
      injectContact?: boolean;
      contactInfo?: string | null;
      joinGroupUrl?: string;
      manualOverride?: boolean;
      force?: boolean;
      fastReturnToFeed?: boolean;
      approvalMode?: ContentScheduleApprovalMode;
      /** 命令来源会话（change unify-card-routing-origin-then-team）：审批卡 / 终态卡回下命令的会话；缺省 → 账号团队群 → 默认群。 */
      originChatId?: string;
    } = {},
  ): Promise<FacebookCommentRunResult> {
    const d = this.deps;
    let join: { triggered: boolean; reason?: string; groupUrl?: string; outcome?: string };
    try {
      // manual=true：手动 /comment --join 加群跳过配额闸（会话额度 + 风控速率/状态）。见 triggerScheduled 契约。
      // --join=<url>：加入**指定群**（只归该账号）；缺 url 时加下一个库内群。已在 triggerManual 保证对应 dep 已接线。
      join = options.joinGroupUrl
        ? await d.facebookJoinSpecificGroup!(accountId, options.joinGroupUrl, { manual: options.manualOverride === true })
        : await d.facebookJoinNewGroup!(accountId, { manual: options.manualOverride === true });
    } catch (err) {
      await d.postResultCard?.(accountId, {
        ok: false,
        level: 'error',
        title: '加群失败',
        message: `加群调度异常：${(err as Error).message}；未评论。`,
      }, undefined, options.originChatId);
      return { outcome: 'submit_failed', reason: `join_exception:${(err as Error).message}` };
    }
    const isMember =
      join.triggered && (join.outcome === 'joined' || join.outcome === 'already_member') && !!join.groupUrl;
    if (!isMember) {
      await d.postResultCard?.(accountId, joinOnlyReceipt(join), undefined, options.originChatId);
      return { outcome: 'no_targets', reason: `join_${join.reason ?? join.outcome ?? 'not_completed'}` };
    }
    // 已加入（或已是成员）→ 在该新群里发一条评论。override 容器强制真发；contactInfo 已在 triggerManual 解析一次（gate 同源）。
    // manualOverride 透传 → 群内评论亦跳过评论配额 / 日上限闸（整条链一致，绝不「加了群却被评论配额拦住」）。
    const comment = await this.runFacebookTargetedTask(accountId, {
      injectContact: options.injectContact,
      contactInfo: options.contactInfo ?? null,
      overrideContainerUrl: join.groupUrl,
      manualOverride: options.manualOverride === true,
      force: options.force === true,
      fastReturnToFeed: options.fastReturnToFeed === true,
      approvalMode: options.approvalMode,
      ...(options.originChatId ? { originChatId: options.originChatId } : {}),
    });
    await d.postResultCard?.(accountId, joinCommentReceipt(join, comment, options.injectContact === true), undefined, options.originChatId);
    return comment;
  }

  /**
   * FB 评论飞书人审（change facebook-comment-review-and-targeted-join）：泛化自原联系评论人审——
   * contactInfo 可选：无则人审卡只显正文（绝不留尾部空行），有则显「正文 + 换行 + 联系方式」（审=发）。
   * 未接线/发卡失败/超时/拒 → 返回 null（绝不裸发）。返回值仅在有联系方式时带回 contactInfo。
   */
  private async approveFacebookComment(
    accountId: string,
    input: { permalink: string; text: string; contactInfo?: string | null; container: string; coverageRelaxed?: boolean },
    approvalMode: ContentScheduleApprovalMode = 'review',
    originChatId?: string,
  ): Promise<{ text: string; contactInfo?: string } | null> {
    const log = this.deps.logger ?? console;
    const now = this.deps.now ?? (() => Date.now());
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const requestId = `facebook-comment-${now()}`;
    const reviewText = input.contactInfo ? `${input.text}\n${input.contactInfo}` : input.text;
    // 放开时限兜底选出的群 → 在标题标注，提醒审核人「这条是在无合规冷却/预热群时放开时限选的」，由人决定发或不发。
    const title = input.coverageRelaxed
      ? `Facebook 群组评论：${input.container}（⚠️ 未满足冷却/预热期，已放开时限选群，请人工确认）`
      : `Facebook 群组评论：${input.container}`;
    if (approvalMode === 'auto_approve') {
      sendAutoApproveNotificationBestEffort({
        notify: this.deps.autoApproveNotify,
        payload: {
          requestId,
          noteId: input.permalink,
          text: reviewText,
          title,
          authorName: 'Facebook',
          accountId,
          contactIncluded: input.contactInfo != null,
          ...(originChatId ? { originChatId } : {}),
        },
        context: `[fb-comment] account=${accountId} requestId=${requestId} `,
        logger: log,
      });
      log.log?.(`[fb-comment] 免审已授权 account=${accountId} requestId=${requestId}`);
      return input.contactInfo ? { text: input.text, contactInfo: input.contactInfo } : { text: input.text };
    }

    const approval = this.deps.approval;
    if (!approval) {
      log.warn('[fb-comment] 评论人审口未接线 → 不发（绝不裸发）');
      return null;
    }
    try {
      await approval.request({
        requestId,
        noteId: input.permalink,
        text: reviewText,
        title,
        authorName: 'Facebook',
        accountId,
        ...(originChatId ? { originChatId } : {}),
      });
    } catch (err) {
      log.warn(`[fb-comment] 评论审批卡发送失败 account=${accountId}：${(err as Error).message}`);
      return null;
    }
    const timeoutMs = approval.timeoutMs ?? 90_000;
    const pollMs = approval.pollMs ?? 2_000;
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      let approved = false;
      try {
        approved = await approval.isApproved(requestId);
      } catch {
        approved = false;
      }
      if (approved) return input.contactInfo ? { text: input.text, contactInfo: input.contactInfo } : { text: input.text };
      await sleep(pollMs);
    }
    return null;
  }

  private async runTargetedTask(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    target: { noteId: string; title: string; currentNote?: NoteForComment },
    contactInfo: string | null,
    platformProfile: CommentPlatformProfile,
    priority: EdgeTaskPriority,
    onResult?: (result: TargetedCommentResult) => Promise<void> | void,
    approvalMode: ContentScheduleApprovalMode = 'review',
    originChatId?: string,
  ): Promise<void> {
    const log = this.deps.logger ?? console;
    const soul = this.deps.getSoul(accountId);
    const llm = this.deps.llmFor(accountId);
    const composer = new CommentComposer({ eventBus: bus, soul, llm, getNoteData: () => null, platformProfile });

    const composeAndApprove = buildComposeAndApprove({
      composer,
      approval: this.deps.approval,
      approvalMode,
      ...(originChatId ? { originChatId } : {}),
      autoApproveNotify: this.deps.autoApproveNotify,
      accountId,
      postProcessor: this.deps.postProcessorFor?.(accountId),
      contactInfo,
      now: this.deps.now,
      logger: log,
    });

    // 搜索词：标题截 ≤20 字（拟人逐字输入须守单步时限）；第二次尝试放宽为前 12 字。
    const searchTerm = target.title.trim().slice(0, TARGETED_SEARCH_TERM_MAX_LEN);
    const fallbackTerm = target.title.trim().slice(0, TARGETED_SEARCH_FALLBACK_LEN);
    let result: TargetedCommentResult;
    try {
      const dedup = this.deps.dedupFor(accountId);
      const edgeFor = (taskId: string) =>
        buildEdgeCommentSteps({
          bus,
          pusher: this.deps.pusher,
          edgeId,
          taskId,
          dedup,
          // Targeted title search relies on exact noteId matching; native filters add no value here.
          stepTimeoutMs: this.deps.stepTimeoutMs,
          logger: log,
        });

      let searchAttempts = 0;
      const prepared = await this.deps.edgeTaskLeases.withLease(
        { edgeId, kind: 'comment_prepare', priority, leaseMs: 2 * 60_000 },
        async (lease) => {
          const edge = edgeFor(lease.taskId);
          if (target.currentNote) {
            if (target.currentNote.noteId !== target.noteId) return null;
            return edge.readCurrentNote(target.currentNote);
          }
          for (const term of [searchTerm, fallbackTerm]) {
            searchAttempts++;
            const cards = await edge.searchAndHarvest(term);
            const card = cards.find((candidate) => candidate.noteId === target.noteId);
            if (card) return edge.readNote(card);
          }
          return null;
        },
      );

      if (!prepared || prepared.note.noteId !== target.noteId) {
        result = target.currentNote
          ? { outcome: 'read_failed', noteId: target.noteId, noteTitle: target.title, searchAttempts, reason: 'current note context unavailable' }
          : { outcome: 'note_not_found', noteId: target.noteId, noteTitle: target.title, searchAttempts, reason: 'target not found during prepare' };
      } else {
        // LLM 撰写 + 飞书人审为 cloud-only；prepare 租约已经由 withLease finally 释放。
        const composed = await composeAndApprove(prepared.note, prepared.comments);
        if (!composed.approved) {
          result = {
            outcome: 'compose_skipped',
            noteId: target.noteId,
            noteTitle: prepared.note.title || target.title,
            searchAttempts,
            reason: composed.reason,
          };
        } else {
          const displayText = composed.contactInfo ? `${composed.text}\n${composed.contactInfo}` : composed.text;
          const posted = await this.withManualCommitMarker<CommentPostResult>(
            accountId,
            priority,
            () => this.deps.edgeTaskLeases.withLease(
              { edgeId, kind: 'comment_commit', priority, leaseMs: 2 * 60_000 },
              async (lease): Promise<CommentPostResult> => {
                if (await dedup.hasInteracted(target.noteId, 'comment').catch(() => false)) {
                  return { status: 'not_dispatched', reason: 'already_commented_before_commit' };
                }
                const edge = edgeFor(lease.taskId);
                // 人审期间页面已可继续浏览；commit 不信旧 DOM，必须重新搜索、打开并核对稳定 noteId。
                for (const term of [searchTerm, fallbackTerm]) {
                  const cards = await edge.searchAndHarvest(term);
                  const card = cards.find((candidate) => candidate.noteId === target.noteId);
                  if (!card) continue;
                  const reopened = await edge.readNote(card);
                  if (!reopened || reopened.note.noteId !== target.noteId) {
                    return { status: 'not_dispatched', reason: 'detail_note_mismatch_on_commit' };
                  }
                  return edge.post(target.noteId, composed.text, composed.contactInfo);
                }
                return { status: 'not_dispatched', reason: 'target_not_found_on_commit' };
              },
            ),
          );
          const base = { noteId: target.noteId, noteTitle: prepared.note.title || target.title, text: displayText, searchAttempts } as const;
          if (posted.status === 'preempted') {
            // 7.6：提交前被抢占 → 放弃本轮（不写去重、不重建重搜、不本轮重试），运营需重敲一次。
            result = { outcome: 'preempted', ...base, reason: `preempted:${posted.reason}` };
          } else if (posted.status === 'not_dispatched') {
            result = { outcome: 'post_failed', ...base, reason: posted.reason ?? 'comment not verified posted' };
          } else {
            // confirmed ∪ submitted_unconfirmed = 提交已派发 → 必写去重（防重复评论）。
            await dedup.recordInteraction(target.noteId, 'comment');
            result = posted.status === 'submitted_unconfirmed'
              ? { outcome: 'submitted_unconfirmed', ...base, reason: 'comment submitted but unconfirmed' }
              : { outcome: 'commented', ...base };
          }
        }
      }
    } catch (err) {
      log.warn(`[comment-scheduler] 定向任务异常 account=${accountId}：${(err as Error).message}`);
      // 租约没拿到 = 零命令下发：未搜索、未定位目标、未发布。与排期链同口径判「未开始」，
      // 绝不复用「已定位/发布未确认」那套措辞——那会让运营去目标笔记下找一条根本不存在的评论。
      result = isEdgeTaskAcquireFailure(err)
        ? { outcome: 'not_started', noteId: target.noteId, searchAttempts: 0, reason: leaseFailureDetail(err) }
        : { outcome: 'post_failed', noteId: target.noteId, searchAttempts: 0, reason: (err as Error).message };
    }

    try {
      await onResult?.(result);
    } catch (err) {
      log.warn(`[comment-scheduler] 定向结果回调失败 account=${accountId}：${(err as Error).message}`);
    }

    try {
      await this.deps.postResultCard?.(accountId, targetedOutcomeToReceipt(result, contactInfo != null), commentSourceLabel(priority), originChatId);
    } catch (err) {
      log.warn(`[comment-scheduler] 定向结果卡片发送失败 account=${accountId}：${(err as Error).message}`);
    }
  }

  private async runTask(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    contactInfo: string | null,
    platformProfile: CommentPlatformProfile,
    priority: EdgeTaskPriority,
    // change manual-comment-force-flag：--force 时放开「强相关甄选」与「每笔记去重」两道软筛选（仅手动路径）。
    // 缺省 false → 默认/自动路径行为逐字不变（零回归）。仍守人审、边端诚实闸（发布前就地核对 noteId）、账号隔离。
    force = false,
    fastReturnToFeed = false,
    approvalMode: ContentScheduleApprovalMode = 'review',
    onResult?: (result: CommentTerminalObservation) => Promise<void> | void,
    originChatId?: string,
  ): Promise<void> {
    const log = this.deps.logger ?? console;
    const soul = this.deps.getSoul(accountId);
    const llm = this.deps.llmFor(accountId);

    const generator = new CommentSearchTermGenerator({ llm, soul, maxTerms: this.deps.maxTerms, platformProfile });
    const picker = new CommentTargetPicker({ llm, soul, platformProfile });
    // 命令路径不走 composer 的事件链，getNoteData 仅事件路径用 → 给空桩。
    const composer = new CommentComposer({ eventBus: bus, soul, llm, getNoteData: () => null, platformProfile });

    const composeAndApprove = buildComposeAndApprove({
      composer,
      approval: this.deps.approval,
      approvalMode,
      ...(originChatId ? { originChatId } : {}),
      autoApproveNotify: this.deps.autoApproveNotify,
      accountId,
      postProcessor: this.deps.postProcessorFor?.(accountId),
      // 联系方式（change account-group-chat-injection）：已在 triggerManual 解析一次（同源），非 null 时注入。
      contactInfo,
      now: this.deps.now,
      logger: log,
    });

    let result: CommentTaskResult;
    /** 接管边端失败时的机器可读码（change browser-slot-scheduling），供排期调度器判是否归还小时格。 */
    let leaseFailureCode: string | undefined;
    try {
      const dedup = this.deps.dedupFor(accountId);
      const edgeFor = (taskId: string) =>
        buildEdgeCommentSteps({
          bus,
          pusher: this.deps.pusher,
          edgeId,
          taskId,
          dedup,
          sort: this.deps.sort ?? platformProfile.search.defaultSort,
          timeWindow: this.deps.timeWindow ?? platformProfile.search.defaultTimeWindow,
          stepTimeoutMs: this.deps.stepTimeoutMs,
          logger: log,
        });

      // 搜索词生成是 cloud-only LLM，边缘租约尚未申请。
      const samples = await this.deps.selectCurated(accountId, 'source_post', 8).catch(() => []);
      const terms = (await generator.generate(samples)).terms;
      if (!terms.length) {
        result = { outcome: 'no_terms', termsTried: 0 };
      } else {
        const maxTerms = this.deps.maxTerms ?? 5;
        // keep-open（change comment-keep-open-through-approval）：一条评论对每个词只搜一次（发现）。
        // 搜到合格候选后，在【同一个持有中的边端租约】内完成 pick → 读正文 → 撰写/飞书人审 → 发布——
        // 审批期间【不释放边端】：EdgeTaskCoordinator 保证持锁期间自治浏览命令(canExecute(undefined)=false)
        // 拿不到浏览器、不会把页面带走，故发布前无需再复搜关键词（根治 target_not_found_on_commit / read_failed，
        // 见 2026-07-11 Tmax 故障）。「commit 不信旧 DOM」的新鲜度改由边端发布前【就地重读当前详情页 noteId】保证。
        // leaseMs 覆盖 搜索(~30s)+pick(~5s)+读正文(~10s)+人审超时(90s)+发布(~15s) 最坏 ≈ 150s，留足 TTL 余量。
        const KEEP_OPEN_LEASE_MS = 4 * 60_000;
        let tried = 0;
        let final: CommentTaskResult | undefined;
        for (const term of terms) {
          if (tried >= maxTerms) break;
          tried++;
          // withManualCommitMarker 仅对 priority='human' 生效：发布期间把账号并入 manualCommentAccounts，
          // 标记「这条评论来自运营手动命令」。**它不再让评论跳过风控计数**（change risk-record-actuated-facts：
          // 人工授权豁免的是配额闸、不是那本账 —— 平台照样看见了这条评论，它照常计入、照常吃自治评论预算）；
          // 如今该标记只抑制节奏饱和告警。标记覆盖整段持锁无副作用（仅 comment 互动事件受影响，只在发布时刻发生）。
          const attempt = await this.withManualCommitMarker(
            accountId,
            priority,
            () => this.deps.edgeTaskLeases.withLease<{ next: true } | { next: false; result: CommentTaskResult }>(
              { edgeId, kind: 'comment_prepare', priority, leaseMs: KEEP_OPEN_LEASE_MS },
              async (lease) => {
                const edge = edgeFor(lease.taskId);
                // 唯一一次真搜索（发现）。搜不到候选 → 换下一个词（多次搜索仅在此触发）。
                const cards = await edge.searchAndHarvest(term);
                const fresh: Array<CommentCandidateCard & { index: number }> = [];
                for (const card of cards) {
                  if (!card.noteId) continue;
                  // --force（manual-comment-force-flag）：放开每笔记去重，已评过的仍入候选；否则跳过已评过的。
                  if (!force && (await dedup.hasInteracted(card.noteId, 'comment').catch(() => false))) continue;
                  fresh.push({ ...card, index: fresh.length });
                }
                if (!fresh.length) return { next: true };

                // 甄选：有强相关候选就用甄选角色的最优（收藏最高的强相关篇）。
                // --force 且无强相关候选时，兜底在全体候选里按收藏数降序取第一（收藏最高的一篇），继续开帖而非换词/本次不评。
                const picked = await picker.pick(fresh);
                let selected: (CommentCandidateCard & { index: number }) | undefined;
                if (picked.pickIndex != null) {
                  selected = fresh.find((card) => card.index === picked.pickIndex);
                } else if (force) {
                  selected = [...fresh].sort((a, b) => (b.collectCount ?? 0) - (a.collectCount ?? 0))[0];
                }
                if (!selected?.noteId) return { next: true };

                // —— 选中即定：以下任何失败都结束任务（MUST NOT 复搜、换词或改评他篇）——
                // 打开仍在当前搜索结果页 DOM 里的这张卡（note.open{noteId}），不复搜。
                const prepared = await edge.readNote(selected);
                if (!prepared || prepared.note.noteId !== selected.noteId) {
                  return { next: false, result: {
                    outcome: 'read_failed', term, noteId: selected.noteId, noteTitle: selected.title, termsTried: tried,
                    reason: '开笔记/读正文失败（当前页未命中目标）',
                  } };
                }

                // 撰写/去 AI 味/飞书人审——持锁不释放，浏览器停在该详情页等待。超时/被拒 → 结束。
                const composed = await composeAndApprove(prepared.note, prepared.comments);
                if (!composed.approved) {
                  return { next: false, result: {
                    outcome: 'compose_skipped', term, noteId: selected.noteId, noteTitle: prepared.note.title,
                    termsTried: tried, reason: composed.reason,
                  } };
                }
                const displayText = composed.contactInfo ? `${composed.text}\n${composed.contactInfo}` : composed.text;

                // --force（manual-comment-force-flag）：跳过发布前去重复检，允许再评已评过的笔记；否则命中即诚实终止。
                if (!force && (await dedup.hasInteracted(selected.noteId, 'comment').catch(() => false))) {
                  return { next: false, result: {
                    outcome: 'post_failed', term, noteId: selected.noteId, noteTitle: prepared.note.title,
                    text: displayText, termsTried: tried, reason: 'already_commented_before_commit',
                  } };
                }
                // 发布：边端在提交前【就地核对当前详情页 noteId】（interaction.comment 带 noteId），
                // 页面被弹层顶掉/被导航离开/笔记已删 → 边端诚实回 ok:false → 不发（绝不在错笔记上发）。
                const posted = await edge.post(selected.noteId, composed.text, composed.contactInfo, fastReturnToFeed);
                const pbase = { term, noteId: selected.noteId, noteTitle: prepared.note.title, text: displayText, termsTried: tried } as const;
                if (posted.status === 'preempted') {
                  // 7.6：提交前被抢占 → 放弃本轮（不写去重、不换词重试）。
                  return { next: false, result: { outcome: 'preempted', ...pbase, reason: `preempted:${posted.reason}` } };
                }
                if (posted.status === 'not_dispatched') {
                  return { next: false, result: { outcome: 'post_failed', ...pbase, reason: posted.reason ?? 'comment not verified posted' } };
                }
                // confirmed ∪ submitted_unconfirmed = 提交已派发 → 必写去重（防重复评论）。
                await dedup.recordInteraction(selected.noteId, 'comment');
                return { next: false, result: posted.status === 'submitted_unconfirmed'
                  ? { outcome: 'submitted_unconfirmed', ...pbase, reason: 'comment submitted but unconfirmed' }
                  : { outcome: 'commented', ...pbase } };
              },
            ),
          );
          if (attempt.next) continue; // 该词无合格候选 → 换下一个词
          final = attempt.result;
          break; // 选中即定：成功/失败都结束本次任务
        }
        result = final ?? { outcome: 'no_strong_candidate', termsTried: Math.min(terms.length, maxTerms) };
      }
    } catch (err) {
      log.warn(`[comment-scheduler] 任务异常 account=${accountId}：${(err as Error).message}`);
      if (isEdgeTaskAcquireFailure(err)) {
        leaseFailureCode = err.code;
        result = { outcome: 'not_started', termsTried: 0, reason: leaseFailureDetail(err) };
      } else {
        result = { outcome: 'post_failed', termsTried: 0, reason: (err as Error).message };
      }
    }

    // 「根本没开始」回流给排期调度器（change browser-slot-scheduling）。
    //
    // 为什么必须在这里而不是触发回执那儿：接管边端失败（浏览器停泊唤不醒 / acquire 超时 / 边端掉线）发生在
    // **任务已经异步跑起来之后**——那时触发回执早就回了 ok、小时格早就被记为已消耗了。不回流，这一小时就白白
    // 烧掉；而排期开火窗口每小时只有固定的那一分钟，相位不利时账号会整天一次都触发不了。
    let scheduledNotStartedHandled = false;
    if (result.outcome === 'not_started' && priority === 'automatic') {
      try {
        // contactInfo 非空 = 本次是联系评论（injectContact），两者的排期名额是分开的小时格。
        scheduledNotStartedHandled = this.deps.onScheduledTaskNotStarted?.(
          accountId,
          contactInfo ? 'contact_comment' : 'comment',
          leaseFailureCode ?? 'not_started',
        ) === true;
      } catch (err) {
        log.warn(`[comment-scheduler] onScheduledTaskNotStarted 回调异常：${(err as Error).message}`);
      }
    }


    try {
      await onResult?.(result);
    } catch (err) {
      log.warn(`[comment-scheduler] 终态观察回调失败 account=${accountId}：${(err as Error).message}`);
    }

    // 自动 not_started 若已由 ContentScheduler 接管，就由小时格预算用尽时统一发一张放弃卡。
    // 手动任务、跨小时迟到结果或未接线排期器仍照常发即时结果卡，避免静默吞掉真实失败。
    if (!scheduledNotStartedHandled) {
      try {
        await this.deps.postResultCard?.(accountId, outcomeToReceipt(result), commentSourceLabel(priority), originChatId);
      } catch (err) {
        log.warn(`[comment-scheduler] 结果卡片发送失败 account=${accountId}：${(err as Error).message}`);
      }
    }
  }

  /**
   * 人工评论标记：只覆盖真 commit，不整段停止/恢复浏览。
   *
   * **语义已变**（change risk-record-actuated-facts）：人工评论**照常消耗**自动评论配额——手动跳过的是
   * 配额**闸**（不被 canDo('comment') 阻断），不是那本**账**。本标记如今只用于抑制节奏饱和告警。
   */
  private async withManualCommitMarker<T>(
    accountId: string,
    priority: EdgeTaskPriority,
    work: () => Promise<T>,
  ): Promise<T> {
    if (priority !== 'human') return work();
    this.deps.onTakeoverStart?.(accountId);
    try {
      return await work();
    } finally {
      this.deps.onTakeoverEnd?.(accountId);
    }
  }
}

/** 定向搜索词上限：拟人逐字输入约 110ms/字，20 字 ≈ 2-3s，稳守 28s 单步预算（XHS 标题上限亦 20 字）。 */
export const TARGETED_SEARCH_TERM_MAX_LEN = XHS_COMMENT_PROFILE.search.targetedSearchTermMaxLength;
/** 第二次尝试的放宽搜索词长度（前 12 字）。 */
export const TARGETED_SEARCH_FALLBACK_LEN = XHS_COMMENT_PROFILE.search.targetedSearchFallbackLength;

/**
 * 结果卡触发来源标注（change comment-keep-open-through-approval）：`priority='automatic'` = 自动排期评论，
 * 其余（`human`）= 人工 `/comment`。让终态回执可辨识来源，不再把自动排期一律标为「/comment」。
 */
export function commentSourceLabel(priority: EdgeTaskPriority): string {
  return priority === 'automatic' ? '排期评论（自动）' : '/comment';
}

function noteLabel(title: string | undefined, prefix: string): string {
  const clean = title?.trim();
  return clean ? `${prefix}《${clean}》` : `${prefix}（未获取标题）`;
}

/**
 * compose_skipped 的判别原因 → 人话回执片段（change comment-keep-open-through-approval 收尾）。
 * 诚实区分「撰写阶段就没稿」与「已出稿送审但没获批」——绝不再把后者误说成"撰写为空"（观测性红线：假归因）。
 * 「拒绝」与「超时」在授权口层不可区分（先到先得信号只看 approved===true），合并表述为"超时或被拒"。
 * reason 缺省（老结果 / 未知值）→ 回落旧的三合一措辞，向后兼容不炸。
 */
function composeSkipDetail(reason?: string): string {
  switch (reason) {
    case 'empty_compose':
      return '模型未产出评论或清洗后为空，未发';
    case 'overlaps_reference':
      return '拟评与精选参考高度重合，弃发（绝不照搬）';
    case 'approval_not_wired':
      return '飞书人审口未接线，未发（绝不裸发）';
    case 'approval_send_failed':
      return '飞书审批卡发送失败，未发';
    case 'approval_unapproved':
      return '已撰写并送飞书人审，但审批时限内未点「同意发布」（超时或被拒），未发';
    default:
      return '撰写为空/未授权/超时，未发';
  }
}

/** TargetedCommentResult → 结果卡片回执（change curated-note-actions；卡面可辨识为定向来源，绝不染绿）。 */
export function targetedOutcomeToReceipt(r: TargetedCommentResult, withContact: boolean): CommentResultReceipt {
  const kind = withContact ? '定向联系评论' : '定向内容评论';
  const target = noteLabel(r.noteTitle, '目标笔记');
  const positioning = r.searchAttempts > 0 ? `${r.searchAttempts} 次搜索定位` : '复用当前笔记上下文';
  const currentContext = r.searchAttempts === 0;
  switch (r.outcome) {
    case 'commented':
      return { ok: true, level: 'success', title: `${kind}已发出`, message: `已在${target}下发表评论：「${r.text ?? ''}」（${positioning}）` };
    case 'not_started':
      // 零命令下发。**刻意不带 target**：报出一个具体的目标笔记，会让运营以为那篇笔记下可能已经有评论了。
      return { ok: false, level: 'error', title: `${kind}未开始`, message: `浏览器未能接管，本次未搜索、未定位目标笔记、未发布评论${r.reason ? `（${r.reason}）` : ''}` };
    case 'note_not_found':
      return { ok: false, level: 'warning', title: `${kind}未产出`, message: `搜索定位 ${r.searchAttempts} 次均未在结果中找到${target}（可能未被搜索收录），本次不评、绝不评「相似」笔记` };
    case 'compose_skipped':
      return { ok: false, level: 'warning', title: `${kind}未发出`, message: `${currentContext ? '已确认当前' : '已定位'}${target}，但${composeSkipDetail(r.reason)}` };
    case 'read_failed':
      return {
        ok: false,
        level: 'error',
        title: `${kind}失败`,
        message: currentContext
          ? `${target}当前上下文不可用，本次不搜索兜底${r.reason ? `（${r.reason}）` : ''}`
          : `已定位${target}，但开笔记/读正文失败${r.reason ? `（${r.reason}）` : ''}`,
      };
    case 'submitted_unconfirmed':
      // 提交已派发但未确认：可能已发出——不染绿、也不误判失败，明确不重试（7.6，防双发）。
      return { ok: false, level: 'warning', title: `${kind}已提交待确认`, message: `${target}评论已提交但未能确认成功，可能已发出——本次不重试${r.reason ? `（${r.reason}）` : ''}` };
    case 'preempted':
      // 提交前被更高优先任务抢占：本轮放弃（未发出），运营可稍后重敲（7.6）。
      return { ok: false, level: 'warning', title: `${kind}被打断`, message: `${target}被更高优先任务打断，本轮放弃、稍后可重试${r.reason ? `（${r.reason}）` : ''}` };
    case 'post_failed':
      return { ok: false, level: 'error', title: `${kind}失败`, message: `${target}评论发布未确认成功${r.reason ? `（${r.reason}）` : ''}` };
  }
}

/** CommentTaskResult → 结果卡片回执（level 按结果，失败/未产出绝不染绿）。 */
export function outcomeToReceipt(r: CommentTaskResult): CommentResultReceipt {
  const selected = noteLabel(r.noteTitle, '选中笔记');
  const commented = noteLabel(r.noteTitle, '笔记');
  switch (r.outcome) {
    case 'commented':
      return { ok: true, level: 'success', title: '按需评论已发出', message: `已在${commented}下发表评论：「${r.text ?? ''}」（搜索词「${r.term ?? ''}」，试 ${r.termsTried} 个词）` };
    case 'not_started':
      return { ok: false, level: 'error', title: '按需评论未开始', message: `浏览器未能接管，本次未搜索、未选中笔记、未发布评论${r.reason ? `（${r.reason}）` : ''}` };
    case 'no_terms':
      return { ok: false, level: 'warning', title: '按需评论未产出', message: '未能生成搜索词（人设与精选集都为空），本次不评' };
    case 'no_strong_candidate':
      return { ok: false, level: 'warning', title: '按需评论未产出', message: `试过 ${r.termsTried} 个搜索词，没有「最近一天最多收藏、与人设强相关且没评过」的笔记，本次不评` };
    case 'compose_skipped':
      return { ok: false, level: 'warning', title: '按需评论未发出', message: `${selected}已选中，但${composeSkipDetail(r.reason)}` };
    case 'read_failed':
      // 带真实原因（change comment-search-nav-confirm，对齐 post_failed / targetedOutcomeToReceipt）：
      // 绝不一律硬编码「边端超时或离线」——边端在线的诚实失败绝不误报成离线（假归因红线）。
      return { ok: false, level: 'error', title: '按需评论失败', message: `${selected}已选中，但开笔记/读正文失败${r.reason ? `（${r.reason}）` : ''}` };
    case 'submitted_unconfirmed':
      return { ok: false, level: 'warning', title: '按需评论已提交待确认', message: `${commented}评论已提交但未能确认成功，可能已发出——本次不重试${r.reason ? `（${r.reason}）` : ''}` };
    case 'preempted':
      return { ok: false, level: 'warning', title: '按需评论被打断', message: `${selected}已选中，但被更高优先任务打断，本轮放弃、稍后可重试${r.reason ? `（${r.reason}）` : ''}` };
    case 'post_failed':
      return { ok: false, level: 'error', title: '按需评论失败', message: `${selected}已选中，但发布未确认成功${r.reason ? `（${r.reason}）` : ''}` };
  }
}

/**
 * 租约**没拿到** ⇒ 任务体一行没跑、零命令下发 ⇒「根本没开始」。
 *
 * 判据是「**任务体是否已经执行过**」，不是一张逐码枚举的白名单——白名单在这里漏过两次
 * （`browser_wake_failed`、`edge_unhealthy`），且 typecheck 永远抓不到：往 code 联合类型里加成员是
 * **变宽**，既有的 `===` 比较仍然合法。所以反过来写成**补集**：不认识的码默认按「未开始」处理，
 * 让沉默的遗漏偏向诚实的一侧，而不是偏向「谎称笔记已选中、评论可能已发出」。
 *
 * `release_timeout` 是唯一的排除项：它发生在 `withLease` 的 work **之后**，那时评论**可能已经真的发出去了**。
 * 把它算成「未开始」会是反向的谎，还会错误地归还排期小时格 → 诱发**重复评论**。
 * （实践上它到不了这个 catch——withLease 的 finally 把释放异常吞成 warn——但判定必须自洽，不能靠调用链的偶然性。）
 */
function isEdgeTaskAcquireFailure(err: unknown): err is EdgeTaskLeaseError {
  // 补集判据（不认识的码默认「未开始」偏诚实一侧）。排除项＝那些「任务体可能已执行/绝不可自动重试」的码：
  // - release_timeout：发生在 work 之后，评论可能已发出，判 not_started 会反向说谎 + 错误归还小时格 → 重复评论。
  // - yield_timeout（7.5）：控制面故障，通向人工重启浏览器客户端（§10.4），绝不自动重试——判 not_started 会
  //   归还小时格 + 下轮重触发，对着一台卡死的浏览器空转成环。走 else 分支落 post_failed（诚实错误卡、不重试）。
  return err instanceof EdgeTaskLeaseError && err.code !== 'release_timeout' && err.code !== 'yield_timeout';
}

/**
 * 接管失败原因按**处置语义**分档，而不是按错误码分档：运维看完这句话就知道该去做什么。
 * 「浏览器驱不动」与「边端离线」是相反的两件事——混说会让人去查一个根本没断的连接。
 */
function leaseFailureDetail(err: EdgeTaskLeaseError): string {
  switch (err.code) {
    case 'edge_unhealthy':
      return '该账号边端在线、连接正常，但浏览器控制面不可用（驱不动浏览器）；需检查或重启该环境的客户端';
    case 'browser_wake_failed':
      return '该账号浏览器处于待机、且未能在唤醒死线内起来（可恢复，稍后自动重试）';
    default:
      return err.message;
  }
}
