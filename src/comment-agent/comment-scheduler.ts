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
import type { Soul } from '../soul/types.js';
import { CommentSearchTermGenerator, type RoleLlmLike } from '../agents/comment-search-term-generator.js';
import { CommentTargetPicker } from '../agents/comment-target-picker.js';
import { CommentComposer } from '../agents/comment-composer.js';
import { PostProcessor } from '../publish-agent/post-processor.js';
import type { CommentApprovalPort } from '../agents/comment-approval-gate.js';
import type { CommentCommandReceipt } from '../feishu/commands.js';
import {
  runCommentTask,
  runTargetedCommentTask,
  type CommentTaskResult,
  type CommentTaskSteps,
  type TargetedCommentResult,
  type TargetedCommentSteps,
} from './comment-task-runner.js';
import { buildEdgeCommentSteps, type EdgePusher, type CommentDedup } from './edge-steps.js';
import { buildFacebookEdgeSteps } from './facebook-edge-steps.js';
import { buildComposeAndApprove } from './compose-approve.js';
import type { CuratedSampleForTerms } from '../agents/comment-search-term-generator.js';
import type { CuratedContentTypeFilter } from '../cache/curated-content-store.js';
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

export interface CommentResultReceipt {
  ok: boolean;
  level: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export interface CommentSchedulerDeps {
  /** 解析该账号的连接运行时（私有总线 + 在线 edgeId）；null / 无 edgeId = 边端离线（honest 拒绝）。 */
  resolveConnection: (accountId: string) => { bus: EventBus; edgeId?: string } | null;
  pusher: EdgePusher;
  getSoul: (accountId: string) => Soul;
  /** 人设绑定判定（persona-driven-content-pipeline）：注入则触发前闸——未绑人设的账号不接管边端、不启动评论任务，绝不以默认人设代评。缺省→不闸（向后兼容旧构造 / 测试桩）。 */
  isPersonaBound?: (accountId: string) => boolean;
  /**
   * 读账号「关联群聊引流码」（change account-group-chat-injection）：/comment group:on 时任务开始处**解析一次**，
   * 缺码 → fail-closed（触发闸回黄色告警、本次不发）；有码 → 同一个已解析值一路带到注入（gate 与注入同源，无 TOCTOU）。
   * 缺省 → 无法取码（group:on 时一律 fail-closed）。
   */
  getGroupChatInfo?: (accountId: string) => Promise<string | null>;
  /** 取精选样本喂搜索词生成（按账号；出错回 []）。 */
  selectCurated: (accountId: string, contentType: CuratedContentTypeFilter, limit: number) => Promise<CuratedSampleForTerms[]>;
  /** 账号绑定 LLM（计 token 归属该账号）。 */
  llmFor: (accountId: string) => RoleLlmLike;
  /** 该账号每笔记去重（InteractionDedup）。 */
  dedupFor: (accountId: string) => CommentDedup;
  /** 评论人审口（复用发帖 /tmp 信号机制）；未接线 → compose-approve 一律不发。 */
  approval?: CommentApprovalPort;
  /** 去 AI 味处理器（可带账号 rewrite）；缺省仅扫描。 */
  postProcessorFor?: (accountId: string) => Pick<PostProcessor, 'process'>;
  /** 接管该账号边端（结束自动浏览，独占）。 */
  onTakeoverStart: (accountId: string) => void;
  /** 任务结束恢复浏览。 */
  onTakeoverEnd: (accountId: string) => void;
  /** 任务跑完补发结果卡片（level 按结果，绝不染绿）。 */
  postResultCard?: (accountId: string, receipt: CommentResultReceipt) => Promise<void> | void;
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
  /** 读该账号 FB 定向评论生效配置（关键词+容器，fail-closed：任一空则 enabled=false）。 */
  facebookConfigFor?: (accountId: string) => EffectiveFacebookCommentConfig;
  /** kill switch（AIDCP_FB_COMMENT_AUTO）：默认关；关且非影子 → 整条 FB 评论不跑。 */
  facebookAutoEnabled?: () => boolean;
  /** 影子模式（AIDCP_FB_COMMENT_SHADOW）：跑选词+撰写+校验+审计，但绝不提交、不记风控/冷却。 */
  facebookShadow?: () => boolean;
  /** FB 评论撰写（无人值守，不走人审）：按关键词/容器产草稿；返回 null=撰写失败。 */
  facebookCompose?: (accountId: string, ctx: { keyword: string; container: string }) => Promise<string | null>;
  /** 真发路径风控闸：canDo('comment')。 */
  facebookCanComment?: (accountId: string) => Promise<boolean>;
  /** 真发路径日上限（当日已评数 / 上限）。 */
  facebookCommentedToday?: (accountId: string) => Promise<number>;
  facebookDailyCap?: (accountId: string) => number;
  /** best-effort 审计 sink（每次触发一行，含影子）。 */
  facebookAudit?: (row: FacebookCommentAuditRow) => void;
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

  /** 是否该账号已有任务在跑（观测用）。 */
  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  /** 飞书 /comment 触发：返回「触发态」结构化回执；最终结果异步补发结果卡片。 */
  async triggerManual(
    accountId: string,
    options?: { injectGroup?: boolean },
  ): Promise<CommentCommandReceipt> {
    if (!accountId || accountId === 'default') {
      return { ok: false, level: 'error', title: '按需评论触发失败', message: '未解析到有效账号（绝不回落 default）' };
    }
    if (this.deps.isPersonaBound && !this.deps.isPersonaBound(accountId)) {
      return { ok: false, level: 'warning', title: '未触发按需评论', message: '该账号未绑定人设——请先到后台「人设」页设置；未绑人设不启动评论任务，绝不以默认人设代评。' };
    }
    // 群聊引流码闸（change account-group-chat-injection）：group:on 时**解析一次**码——缺码 fail-closed（本次不发，
    // 绝不静默降级成无码评论，镜像上面的 isPersonaBound 闸）；有码则用同一个已解析值注入（gate 与注入同源，无 TOCTOU）。
    let groupChatCode: string | null = null;
    if (options?.injectGroup) {
      groupChatCode = this.deps.getGroupChatInfo ? await this.deps.getGroupChatInfo(accountId) : null;
      if (!groupChatCode) {
        return {
          ok: false,
          level: 'warning',
          title: '未触发按需评论',
          message: '该账号未配置「关联群聊信息」——请先到后台账号页设置；要求引流但无码，本次不发（绝不发无码评论）。',
        };
      }
    }
    if (this.running.has(accountId)) {
      return { ok: false, level: 'warning', title: '未触发按需评论', message: '该账号已有评论任务在跑，请等其结束' };
    }
    const conn = this.deps.resolveConnection(accountId);
    if (!conn || !conn.edgeId) {
      return { ok: false, level: 'error', title: '按需评论触发失败', message: '该账号暂无在线边端' };
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
      this.running.add(accountId);
      void this.runFacebookTargetedTask(accountId)
        .catch((err) =>
          (this.deps.logger ?? console).warn(
            `[comment-scheduler] FB 定向评论任务异常 account=${accountId}：${(err as Error).message}`,
          ),
        )
        .finally(() => this.running.delete(accountId));
      const mode = this.deps.facebookShadow?.() ? '影子模式（不真发）' : '真发（按风控/冷却/上限闸）';
      return { ok: true, level: 'success', title: '已触发 Facebook 定向评论', message: `已触发 Facebook 定向评论 · ${mode}；结果稍后回报` };
    }

    this.running.add(accountId);
    const edgeId = conn.edgeId;
    const bus = conn.bus;
    // 异步跑任务，命令立即回执（任务含人审轮询，不可同步等）。groupChatCode 已解析一次，带进任务用于注入（gate 同源）。
    // catch：runTask 内部已兜任务期异常；此处兜「任务启动前」的防御性抛（如 gate 后人设被解绑 → getSoul 抛
    // no_persona，persona-driven-content-pipeline）——诚实记日志、不让未处理拒绝炸进程，绝不假成功。
    void this.runTask(accountId, bus, edgeId, groupChatCode, platformProfile)
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
      message: `已启动按需评论任务（搜「${defaultCommentSearchLabel(platformProfile)}」的强相关、未评过笔记；评论前仍需飞书人审 approved=true 才会真发；结果稍后回报）`,
    };
  }

  /**
   * 定向评论触发（change curated-note-actions）：管理后台精选页对指定笔记评论。
   * 与 triggerManual 守卫同构（账号/人设/群码 fail-closed/单飞/边端在线），另加**去重前置**（已评过 → 诚实拒绝）。
   * 目标定位为搜索驱动（标题截断作搜索词、综合排序+不限时间窗、结果内按 noteId 精确匹配），绝不导航存量 URL。
   */
  async triggerTargeted(
    accountId: string,
    target: { noteId: string; title: string },
    options?: { injectGroup?: boolean },
  ): Promise<CommentCommandReceipt & { reason?: string }> {
    if (!accountId || accountId === 'default') {
      return { ok: false, level: 'error', title: '定向评论触发失败', message: '未解析到有效账号（绝不回落 default）', reason: 'account_required' };
    }
    if (!target.noteId || !target.title.trim()) {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '目标笔记缺 noteId 或标题为空，无法搜索定位', reason: 'bad_target' };
    }
    if (this.deps.isPersonaBound && !this.deps.isPersonaBound(accountId)) {
      return { ok: false, level: 'warning', title: '未触发定向评论', message: '该账号未绑定人设——请先到后台「人设」页设置；未绑人设不启动评论任务，绝不以默认人设代评。', reason: 'needs_persona' };
    }
    let groupChatCode: string | null = null;
    if (options?.injectGroup) {
      groupChatCode = this.deps.getGroupChatInfo ? await this.deps.getGroupChatInfo(accountId) : null;
      if (!groupChatCode) {
        return {
          ok: false,
          level: 'warning',
          title: '未触发定向评论',
          message: '该账号未配置「关联群聊信息」——请先到后台账号页设置；要求带群但无码，本次不发（绝不发无码评论，也不降级为内容评论）。',
          reason: 'group_code_missing',
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
      void this.runFacebookTargetedTask(accountId)
        .catch((err) =>
          (this.deps.logger ?? console).warn(
            `[comment-scheduler] FB 定向评论任务异常 account=${accountId}：${(err as Error).message}`,
          ),
        )
        .finally(() => this.running.delete(accountId));
      const mode = this.deps.facebookShadow?.() ? '影子模式（不真发）' : '真发（按风控/冷却/上限闸）';
      return { ok: true, level: 'success', title: '已触发 Facebook 定向评论', message: `已触发 Facebook 定向评论 · ${mode}；结果稍后回报` };
    }

    this.running.add(accountId);
    void this.runTargetedTask(accountId, conn.bus, conn.edgeId, target, groupChatCode, platformProfile)
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
      message: '已启动定向评论任务（搜索定位目标笔记→撰写→飞书人审 approved=true 才会真发；结果稍后回报）',
    };
  }

  /**
   * Facebook 定向评论执行（facebook-scheduled-comment 2.2/2.3 + 真发接线 task 4.x）。
   * 闸链 → 随机选关键词/容器 → 撰写 → 只拒不修校验：
   * - 影子模式（AIDCP_FB_COMMENT_SHADOW）到「校验通过」即止步，**绝不提交、不记风控/冷却/去重**（物理发不出评论）。
   * - 真发路径（kill switch AIDCP_FB_COMMENT_AUTO 开且非影子）：过 canDo + 日上限闸后，经边端评论能力真发——
   *   容器内搜索 → 选未评候选 → 开帖 → 提交并「服务器确认」。每步有界超时（此路径无巡视看门狗）。
   *
   * 红线：
   * - 绝不走 onCommentTakeoverStart（那会把账号塞进 manualCommentAccounts 跳过风控计数，违反 2.4）。
   * - 真发成功的风控计数走 interaction.occurred → RiskController.record('comment') 自动路径（handler.ts），
   *   **绝不在此重复 record**；本方法只在**提交派发前**打 attempted 去重标记（防重复真发 §5.4，与成功计数解耦）。
   */
  private async runFacebookTargetedTask(accountId: string): Promise<void> {
    const d = this.deps;
    const rand = d.random ?? Math.random;
    const shadow = d.facebookShadow?.() ?? false;
    const autoEnabled = d.facebookAutoEnabled?.() ?? false;
    const audit = (row: FacebookCommentAuditRow) => {
      try {
        d.facebookAudit?.(row);
      } catch {
        /* best-effort：审计绝不波及主链路 */
      }
    };

    // kill switch：既未开真发、也未开影子 → 整条功能关闭，静默不跑（不产审计噪音）。
    if (!autoEnabled && !shadow) return;

    // 配置 fail-closed：关键词或容器任一为空 → 诚实 no-op。
    const cfg: EffectiveFacebookCommentConfig = d.facebookConfigFor!(accountId);
    if (!cfg.enabled || cfg.keywords.length === 0 || cfg.containers.length === 0) {
      audit({ accountId, outcome: 'no_targets', shadow });
      return;
    }

    const keyword = cfg.keywords[Math.floor(rand() * cfg.keywords.length)] ?? cfg.keywords[0];
    const container = cfg.containers[Math.floor(rand() * cfg.containers.length)] ?? cfg.containers[0];

    // 撰写（无人值守，不走人审）。
    const draft = d.facebookCompose ? await d.facebookCompose(accountId, { keyword, container }) : null;
    if (!draft || !draft.trim()) {
      audit({ accountId, outcome: 'compose_skipped', reason: 'empty_compose', shadow, keyword, container });
      return;
    }

    // 只拒不修的确定性校验（llm-output-honesty）：任一违规 → compose_skipped 终局，绝不修复后发。
    const v = validateFacebookComment(draft, { targetKeywords: [keyword] });
    if (!v.ok) {
      audit({ accountId, outcome: 'compose_skipped', reason: v.reason, shadow, keyword, container, textLength: draft.length });
      return;
    }

    // 影子：到此为止——不提交、不记风控/冷却、不按已发去重。
    if (shadow) {
      audit({ accountId, outcome: 'shadow_ok', shadow: true, keyword, container, textLength: v.text.length });
      return;
    }

    // ── 真发路径（autoEnabled）：先过风控 + 日上限闸（两入口统一在此收口） ──
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

    // ── 真发接线（edge 4.x 评论能力 + 协议载荷 container/url + 有界超时）──
    // 边端离线 → 诚实非成功（连接可能在 trigger 后掉线；此路径无看门狗，靠每步有界超时兜底）。
    const conn = d.resolveConnection(accountId);
    if (!conn || !conn.edgeId) {
      audit({ accountId, outcome: 'submit_failed', reason: 'edge_offline', shadow: false, keyword, container, textLength: v.text.length });
      return;
    }
    const steps = buildFacebookEdgeSteps({
      bus: conn.bus,
      pusher: d.pusher,
      edgeId: conn.edgeId,
      ...(typeof d.stepTimeoutMs === 'number' ? { stepTimeoutMs: d.stepTimeoutMs } : {}),
      logger: d.logger ?? console,
    });
    const dedup = d.dedupFor(accountId);

    // 1) 容器内搜索候选帖（边端只在配置容器内搜、绝不全站）。
    const search = await steps.searchInContainer(keyword, container);
    if (!search.ok) {
      audit({ accountId, outcome: mapFacebookBlockOutcome(search.reason), reason: search.reason, shadow: false, keyword, container });
      return;
    }
    // 2) 选一个未评过的候选（防重复真发：跳过 dedup 已标记的 permalink）。
    let target: string | undefined;
    for (const c of search.candidates) {
      const seen = await dedup.hasInteracted(c.permalink, 'comment').catch(() => false);
      if (!seen) {
        target = c.permalink;
        break;
      }
    }
    if (!target) {
      audit({
        accountId,
        outcome: 'no_strong_candidate',
        reason: search.candidates.length === 0 ? 'no_candidates' : 'all_deduped',
        shadow: false,
        keyword,
        container,
      });
      return;
    }
    // 3) 开帖（permalink 直驱详情页）。
    const open = await steps.openPost(target);
    if (!open.ok) {
      audit({ accountId, outcome: mapFacebookOpenOutcome(open.reason), reason: open.reason, shadow: false, keyword, container });
      return;
    }
    // 4) 防重复真发（BLOCKING §5.4）：**提交派发前**即打 attempted 去重标记（与成功计数解耦）——
    //    确认假阴性/网络抖动时不会对同一目标重复真评；该标记同时使 facebookCommentedToday 计入当日配额（保守）。
    await dedup.recordInteraction(target, 'comment').catch(() => {});
    // 5) 提交评论 + 服务器确认（边端 own-identity 收窄）。成功记风控走 interaction.occurred 自动路径，绝不在此重复 record。
    const submit = await steps.submitComment(target, v.text);
    if (submit.ok) {
      audit({ accountId, outcome: 'commented', shadow: false, keyword, container, textLength: v.text.length });
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
    }
  }

  private async runTargetedTask(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    target: { noteId: string; title: string },
    groupChatCode: string | null,
    platformProfile: CommentPlatformProfile,
  ): Promise<void> {
    const log = this.deps.logger ?? console;
    const soul = this.deps.getSoul(accountId);
    const llm = this.deps.llmFor(accountId);
    const composer = new CommentComposer({ eventBus: bus, soul, llm, getNoteData: () => null, platformProfile });

    const composeAndApprove = buildComposeAndApprove({
      composer,
      approval: this.deps.approval,
      accountId,
      postProcessor: this.deps.postProcessorFor?.(accountId),
      groupChatCode,
      now: this.deps.now,
      logger: log,
    });

    // 定向流程覆盖原生筛选：综合排序 + 不限时间窗（/comment 默认「最多收藏+一天内」会筛掉非当日老笔记）。
    const edge = buildEdgeCommentSteps({
      bus,
      pusher: this.deps.pusher,
      edgeId,
      dedup: this.deps.dedupFor(accountId),
      // Targeted title search relies on exact noteId matching; native filters add no value here.
      stepTimeoutMs: this.deps.stepTimeoutMs,
      logger: log,
    });

    const steps: TargetedCommentSteps = {
      searchAndHarvest: (term) => edge.searchAndHarvest(term),
      readNote: (card) => edge.readNote(card),
      composeAndApprove: (note, comments) => composeAndApprove(note, comments),
      post: (noteId, text, code) => edge.post(noteId, text, code),
      recordCommented: (noteId) => edge.recordCommented(noteId),
    };

    // 搜索词：标题截 ≤20 字（拟人逐字输入须守单步时限）；第二次尝试放宽为前 12 字。
    const searchTerm = target.title.trim().slice(0, TARGETED_SEARCH_TERM_MAX_LEN);
    const fallbackTerm = target.title.trim().slice(0, TARGETED_SEARCH_FALLBACK_LEN);

    this.deps.onTakeoverStart(accountId);
    let result: TargetedCommentResult;
    try {
      result = await runTargetedCommentTask(steps, { noteId: target.noteId, title: target.title, searchTerm, fallbackTerm }, { logger: log });
    } catch (err) {
      log.warn(`[comment-scheduler] 定向任务异常 account=${accountId}：${(err as Error).message}`);
      result = { outcome: 'post_failed', noteId: target.noteId, searchAttempts: 0, reason: (err as Error).message };
    } finally {
      this.deps.onTakeoverEnd(accountId);
    }

    try {
      await this.deps.postResultCard?.(accountId, targetedOutcomeToReceipt(result, groupChatCode != null));
    } catch (err) {
      log.warn(`[comment-scheduler] 定向结果卡片发送失败 account=${accountId}：${(err as Error).message}`);
    }
  }

  private async runTask(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    groupChatCode: string | null,
    platformProfile: CommentPlatformProfile,
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
      accountId,
      postProcessor: this.deps.postProcessorFor?.(accountId),
      // 群聊引流码（change account-group-chat-injection）：已在 triggerManual 解析一次（同源），非 null 时注入。
      groupChatCode,
      now: this.deps.now,
      logger: log,
    });

    const edge = buildEdgeCommentSteps({
      bus,
      pusher: this.deps.pusher,
      edgeId,
      dedup: this.deps.dedupFor(accountId),
      sort: this.deps.sort ?? platformProfile.search.defaultSort,
      timeWindow: this.deps.timeWindow ?? platformProfile.search.defaultTimeWindow,
      stepTimeoutMs: this.deps.stepTimeoutMs,
      logger: log,
    });

    const steps: CommentTaskSteps = {
      generateTerms: async () => {
        const samples = await this.deps.selectCurated(accountId, 'source_post', 8).catch(() => []);
        const r = await generator.generate(samples);
        return r.terms;
      },
      searchAndHarvest: (term) => edge.searchAndHarvest(term),
      filterUncommented: (cards) => edge.filterUncommented(cards),
      pick: (cards) => picker.pick(cards),
      readNote: (card) => edge.readNote(card),
      composeAndApprove: (note, comments) => composeAndApprove(note, comments),
      post: (noteId, text, groupChatCode) => edge.post(noteId, text, groupChatCode),
      recordCommented: (noteId) => edge.recordCommented(noteId),
    };

    // 接管边端（独占）→ 跑任务 → finally 恢复浏览。
    this.deps.onTakeoverStart(accountId);
    let result: CommentTaskResult;
    try {
      result = await runCommentTask(steps, { maxTerms: this.deps.maxTerms, logger: log });
    } catch (err) {
      log.warn(`[comment-scheduler] 任务异常 account=${accountId}：${(err as Error).message}`);
      result = { outcome: 'post_failed', termsTried: 0, reason: (err as Error).message };
    } finally {
      this.deps.onTakeoverEnd(accountId);
    }

    try {
      await this.deps.postResultCard?.(accountId, outcomeToReceipt(result));
    } catch (err) {
      log.warn(`[comment-scheduler] 结果卡片发送失败 account=${accountId}：${(err as Error).message}`);
    }
  }
}

/** 定向搜索词上限：拟人逐字输入约 110ms/字，20 字 ≈ 2-3s，稳守 28s 单步预算（XHS 标题上限亦 20 字）。 */
export const TARGETED_SEARCH_TERM_MAX_LEN = XHS_COMMENT_PROFILE.search.targetedSearchTermMaxLength;
/** 第二次尝试的放宽搜索词长度（前 12 字）。 */
export const TARGETED_SEARCH_FALLBACK_LEN = XHS_COMMENT_PROFILE.search.targetedSearchFallbackLength;

function noteLabel(title: string | undefined, prefix: string): string {
  const clean = title?.trim();
  return clean ? `${prefix}《${clean}》` : `${prefix}（未获取标题）`;
}

/** TargetedCommentResult → 结果卡片回执（change curated-note-actions；卡面可辨识为定向来源，绝不染绿）。 */
export function targetedOutcomeToReceipt(r: TargetedCommentResult, withGroup: boolean): CommentResultReceipt {
  const kind = withGroup ? '定向带群评论' : '定向内容评论';
  const target = noteLabel(r.noteTitle, '目标笔记');
  switch (r.outcome) {
    case 'commented':
      return { ok: true, level: 'success', title: `${kind}已发出`, message: `已在${target}下发表评论：「${r.text ?? ''}」（${r.searchAttempts} 次搜索定位）` };
    case 'note_not_found':
      return { ok: false, level: 'warning', title: `${kind}未产出`, message: `搜索定位 ${r.searchAttempts} 次均未在结果中找到${target}（可能未被搜索收录），本次不评、绝不评「相似」笔记` };
    case 'compose_skipped':
      return { ok: false, level: 'warning', title: `${kind}未发出`, message: `已定位${target}，但撰写为空/未授权/超时，本次不发` };
    case 'read_failed':
      return { ok: false, level: 'error', title: `${kind}失败`, message: `已定位${target}，但开笔记/读正文失败${r.reason ? `（${r.reason}）` : ''}` };
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
    case 'no_terms':
      return { ok: false, level: 'warning', title: '按需评论未产出', message: '未能生成搜索词（人设与精选集都为空），本次不评' };
    case 'no_strong_candidate':
      return { ok: false, level: 'warning', title: '按需评论未产出', message: `试过 ${r.termsTried} 个搜索词，没有「最近一天最多收藏、与人设强相关且没评过」的笔记，本次不评` };
    case 'compose_skipped':
      return { ok: false, level: 'warning', title: '按需评论未发出', message: `${selected}已选中，但撰写为空/未授权/超时，本次不发` };
    case 'read_failed':
      return { ok: false, level: 'error', title: '按需评论失败', message: `${selected}已选中，但开笔记/读正文失败（边端超时或离线）` };
    case 'post_failed':
      return { ok: false, level: 'error', title: '按需评论失败', message: `${selected}已选中，但发布未确认成功${r.reason ? `（${r.reason}）` : ''}` };
  }
}
