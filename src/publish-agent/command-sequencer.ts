/**
 * CommandSequencer — A 阶段1 云端「发布指令编排 + 驱动」。
 *
 * 把终稿（+占位元数据）编排成有序参数化指令序列，逐条下发 publish.command，
 * 按 `recordId+seq` 关联等待 publish.command.result，再发下一条（send→await→advance）。
 *
 * 红线：
 * - 失败立即停止——某条 result.ok=false 即返回 failedAt，后续指令绝不下发、绝不伪造发布成功。
 * - AC-PUB 第 2 道闸：未授权（approvedByUser=false）时 submit_publish 不入序列（序列截止于提交前），
 *   调用方再试也生成不出提交指令。
 * - pending map 超时清理防泄漏；envelope.id 仅日志，关联只认 recordId+seq。
 */

import { makeEnvelope } from '../comm/protocol.js';
import type {
  PublishCommandKind,
  PublishCommandPayload,
  PublishCommandResultPayload,
} from '../comm/protocol.js';
import { CommandPreemptedError, isPreemptionReason, type PreemptionReason } from '../comm/preemption.js';
import type { PlatformId } from '../platform/index.js';
import type { PublishMetadata } from './types.js';
import { buildPublishCommandPlan } from './platform-profile.js';
import {
  DEFAULT_FILL_BUDGET,
  isContentTooLong,
  maxFillChars,
  contentCharCount,
  sanitizeFillBudget,
  type FillBudgetConfig,
} from './fill-budget.js';

/**
 * 边缘推送接口（与 EdgeCloudServer.pushToEdges 同构）。
 * edge-command-target-guard：缺目标 edgeId 时绝不广播——返回 0 视为诚实失败（发布步空 / 失败，不假成功）。
 */
export interface SequencerPusher {
  pushToEdges(envelope: unknown, edgeId?: string): number;
}

/** 一次发布的编排输入（终稿 + 授权态；元数据维度本阶段占位预留）。 */
export interface PublishSequenceInput {
  recordId: number;
  /** 当前 edge 发布任务租约；整条序列逐条携同一 taskId。 */
  taskId: string;
  title: string;
  content: string;
  tags: string[];
  /** 配图 URL（按序 emit upload_image×N；多图逐张上传，publish-multi-image）。 */
  images?: string[];
  /** 封面图 URL（本期不传：封面=首张上传=平台默认；仅 cover 且 images>1 才下发 set_cover，见 buildCommandSequence）。 */
  cover?: string;
  /** 发帖元数据（stage-3 决策产物）：话题/@/地点/合集/可见范围/权限/合规/定时；下发为 edge 指令应用。 */
  metadata?: PublishMetadata;
  /** 发布平台；缺省 xiaohongshu。 */
  platform?: PlatformId;
  /** 是否已通过人审（AC-PUB）；false → 序列截止于提交前 */
  approvedByUser: boolean;
  /**
   * 目标边缘节点 edgeId（change publish-history-account-and-detail）。指定则本次序列所有指令**定向**到该节点、
   * 不广播；缺省（旧路径/单边缘）则广播（向后兼容）。云端已据目标账号解析出在线节点（无节点则在 executor 诚实失败、不入此序列）。
   */
  edgeId?: string;
  /**
   * 7.1 HOLE-13：不可逆提交命令（submit_publish）**下发前**的回调，触发一次。下发段据此把「已开始」标志
   * 下移到真正的提交点——在此之前（导航 / 选栏目 / 上传配图 / 填字段，spec 定义为平台侧零副作用）若因意外抛错
   * 收敛，MUST 按零副作用回待审、不烧成 failed（今天在拿到租约瞬间即置真 → 零副作用失败被判终态 + 熔断 +1）。
   */
  onFirstSideEffect?: () => void;
}

export interface PublishSequenceResult {
  ok: boolean;
  /**
   * 终局四态（change lease-strict-preemption 批 C 新增 `preempted`）：
   * - `published_confirmed`：已提交且抓到 postId。
   * - `submitted_unconfirmed`：提交动作已派发但未拿到确认（含提交后被抢占）——页面态 submitted、绝不重投。
   * - `failed_before_submit`：提交前真失败——可安全烧待审重投。
   * - `preempted`：提交前被严格高档位抢占（零平台副作用）——**保持待审、不写 failed、不计熔断、事件驱动重投**，
   *   下发段（publish-dispatcher）MUST 单独分支处置，绝不并入 failed_before_submit（否则被抢占的稿被烧成不可逆 failed）。
   */
  outcome: 'published_confirmed' | 'submitted_unconfirmed' | 'failed_before_submit' | 'preempted';
  /** 成功时的真实平台 postId（来自 capture_postId 回报） */
  postId?: string;
  /** 成功时的小红书详情页分享 URL（带 xsec_token，来自 capture_postId 回报；边缘抓不到则 undefined） */
  postUrl?: string;
  /**
   * 真实上传成功张数 K（多图部分成功记账，publish-multi-image）。
   * 请求 N 张实成 K 张：K≥1 即有效图文帖、照发；K===0（全失败）→ 无有效帖、诚实 failed。
   * 未请求配图时为 0。下发段据此 markImagesAttached(id, K)，杜绝「要 N 张实成 K 张被读成 N 张」。
   */
  attachedCount: number;
  /** 失败位置（seq=-1 表示未授权而未生成提交指令） */
  failedAt?: { seq: number; kind: PublishCommandKind; error: string };
}

export interface CommandSequencerDeps {
  pusher: SequencerPusher;
  idGen?: () => string;
  clock?: () => number;
  /** 单条指令等待回报的超时（毫秒，缺省 30s） */
  timeoutMs?: number;
  /**
   * upload_image 专用超时（毫秒，缺省 60s）。MUST 大于边缘「下载+CDP 设置+后置校验」总预算，
   * 使慢/过期 URL 时边缘先返回干净 ok:false（降级纯文字），而非把整条序列拖到云端超时中断。
   */
  uploadTimeoutMs?: number;
  /**
   * 指令自带执行预算（`PublishCommandPayload.timeoutMs`）时，云端在其上多等的兜底余量（毫秒，缺省 8s）。
   * 语义反转的关键：边缘按下发的预算掐表、必定先答，云端这条 timer 于是从「正常路径」退化成
   * 「边缘真的死了」的兜底。指令**不带**预算时（小红书全路径）一律走旧的常数窗口，零回归。
   */
  resultSlackMs?: number;
  /** Facebook 正文填写的单步预算配置；缺省 DEFAULT_FILL_BUDGET。 */
  fillBudget?: FillBudgetConfig;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface Pending {
  commandId: string;
  sentAt: number;
  /** 该指令所属的 edge 页面写任务租约；7.5 抢占中断按此 taskId 精确就地 reject 在途指令。 */
  taskId: string;
  /** 该指令定向到的边缘节点；该节点断开即可立刻诚实失败，不必空等满预算。 */
  edgeId?: string;
  resolve: (r: PublishCommandResultPayload) => void;
  reject: (e: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class CommandSequencer {
  private readonly pusher: SequencerPusher;
  private readonly idGen: () => string;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly resultSlackMs: number;
  private readonly fillBudget: FillBudgetConfig;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: CommandSequencerDeps) {
    this.pusher = deps.pusher;
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
    this.clock = deps.clock ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.uploadTimeoutMs = deps.uploadTimeoutMs ?? 60_000;
    this.resultSlackMs = deps.resultSlackMs ?? 8_000;
    this.logger = deps.logger ?? console;
    // 兜底校验：非法预算（NaN / 0 / 负）会一路污染到下发的 timeoutMs，让云端等待窗口退化成
    // 「立刻超时」——正是本模块要消灭的孤儿打字级联。构造处已 sanitize，这里再挡一道。
    this.fillBudget = sanitizeFillBudget(deps.fillBudget ?? DEFAULT_FILL_BUDGET, (m) => this.logger.warn(m));
  }

  /** 终稿 → 有序指令序列。AC-PUB 第 2 道：未授权则截止于提交前。 */
  buildCommandSequence(input: PublishSequenceInput): PublishCommandPayload[] {
    return buildPublishCommandPlan({
      taskId: input.taskId,
      recordId: input.recordId,
      title: input.title,
      content: input.content,
      tags: input.tags,
      images: input.images ?? [],
      cover: input.cover,
      metadata: input.metadata,
      approvedByUser: input.approvedByUser,
      platform: input.platform ?? 'xiaohongshu',
      fillBudget: this.fillBudget,
    });
  }

  /**
   * 驱动整条序列：逐条 send→await→advance。
   * 红线：非配图指令任一失败即停（fail-fast），后续不下发、不假成功。
   * 配图部分成功处理（publish-multi-image，task-0 实测：图文帖编辑器被"先传图"门控）：
   * - upload_image×N 逐张下发；成功一张 attachedCount(K)++，失败/超时那张诚实丢弃（不补不复用）；
   * - 请求了配图（imagesRequested）而 **K===0 全失败** → 到 fill_field 前 MUST 诚实 failed（无有效图文帖）；
   * - K≥1（部分成功）即有效帖、照发 K 张、继续走完序列；
   * - 仅当未请求配图（无图流，前向兼容）才存在"纯文字继续"路径。
   */
  async executePublishSequence(input: PublishSequenceInput): Promise<PublishSequenceResult> {
    // FB 正文逐字输入：超出预算上限所能打完的长度 → 诚实失败，MUST NOT 截断正文发出去。
    // 触发即说明内容生成侧越界（管线设计区间 200–500 字），要修的是那头，不是在这里悄悄砍。
    if ((input.platform ?? 'xiaohongshu') === 'facebook' && isContentTooLong(input.content, this.fillBudget)) {
      const chars = contentCharCount(input.content);
      const limit = maxFillChars(this.fillBudget);
      // 上限低于管线设计区间（200–500 字）时，真凶是预算/租约配置而非内容生成——把话说清楚，
      // 别让运维照着「内容太长」去砍 prompt。
      const hint = limit < 600 ? '（上限异常低：真凶多半是预算/租约配置，先查 AIDCP_PUBLISH_FILL_* 与 AIDCP_EDGE_PUBLISH_LEASE_MS）' : '';
      this.logger.warn(
        `[CommandSequencer] recordId=${input.recordId} 正文 ${chars} 字超出 Facebook 逐字输入上限 ${limit} 字 → 诚实 failed（不截断）${hint}`,
      );
      return {
        ok: false,
        outcome: 'failed_before_submit',
        attachedCount: 0,
        failedAt: { seq: -1, kind: 'fill_field', error: `content_too_long: ${chars}>${limit}` },
      };
    }
    const sequence = this.buildCommandSequence(input);
    const imagesRequested = !!(input.images && input.images.length);
    const totalImages = imagesRequested ? input.images!.length : 0;
    const targetEdgeId = input.edgeId;
    let postId: string | undefined;
    let postUrl: string | undefined;
    let submitted = false;
    let attachedCount = 0;
    // 已尝试上传张数（成功+失败）。upload 均在 fill 前且连续；据此判「全部上传已尝试完」，
    // 避免在 upload 阶段之前（navigate/select_mode，此时 attachedCount 天然为 0）误触发 K===0 早停。
    let uploadsAttempted = 0;
    // 最后一条 upload_image 的 seq（诚实诊断用）：K===0 全失败早停在 fill 处触发，failedAt 指回真实 upload seq、
    // 而非误报为触发早停的那条 fill_field 的 seq（避免运维照 seq 查错命令）。
    let lastUploadSeq = -1;
    // 元数据是增强项，非有效帖必需：失败best-effort跳过、继续发（带标题/正文/图的帖子仍是有效帖）。
    // 绝不伪造该项成功——只是诚实地"少了这个标签/选项"继续。核心步（导航/选模式/标题/正文/提交）仍 fail-fast。
    const bestEffort = new Set<PublishCommandKind>(['add_with_candidate', 'set_option', 'set_schedule']);

    for (const cmd of sequence) {
      // 图文帖编辑器被"先传图"门控（task-0 实测：无图则标题/正文不存在）。全部上传已尝试完但 K===0 → 无有效帖，
      // MUST 诚实 failed，绝不进 fill_field 假装纯文字继续（红线：不假成功）。uploadsAttempted<total 时仍在上传阶段前/中，不误触发。
      if (imagesRequested && uploadsAttempted >= totalImages && attachedCount === 0 && cmd.kind !== 'upload_image' && cmd.kind !== 'set_cover') {
        this.logger.warn(`[CommandSequencer] 全部配图失败（K=0）、图文帖无有效内容 → failed（触发于 seq=${cmd.seq}，归因末条 upload seq=${lastUploadSeq}）`);
        return { ok: false, outcome: 'failed_before_submit', attachedCount: 0, failedAt: { seq: lastUploadSeq, kind: 'upload_image', error: 'all_images_failed' } };
      }
      // 无成功配图 → 不下发依赖首图的封面（红线：绝不在配图全失败后下发 set_cover）。
      if (cmd.kind === 'set_cover' && attachedCount === 0) {
        this.logger.warn(`[CommandSequencer] 无成功配图，跳过 set_cover seq=${cmd.seq}`);
        continue;
      }
      // 记录末条 upload seq（发送前即记；供上方 K===0 早停诚实归因）。
      if (cmd.kind === 'upload_image') lastUploadSeq = cmd.seq;
      // 7.1 HOLE-13：提交点击（唯一的不可逆平台副作用）下发前置「已开始」标志，让此前的零副作用意外失败可回待审。
      if (cmd.kind === 'submit_publish') input.onFirstSideEffect?.();

      let result: PublishCommandResultPayload;
      try {
        result = await this.sendAndWaitResult(cmd, targetEdgeId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // 配图唯一放宽：upload_image 超时/异常 → 丢弃该张（不计入 K）、继续（其余图仍可成功=部分成功）。
        if (cmd.kind === 'upload_image') {
          uploadsAttempted++;
          this.logger.warn(`[CommandSequencer] upload_image 异常丢弃该张 seq=${cmd.seq}: ${error}`);
          continue;
        }
        // 已提交后抓 postId 异常：帖子已发出，postId 抓取仅记录用 → 非致命（不可把已发布误判为 failed）。
        if (cmd.kind === 'capture_postId' && submitted) {
          this.logger.warn(`[CommandSequencer] capture_postId 异常但已提交发布、postId 未知 seq=${cmd.seq}: ${error}`);
          continue;
        }
        // 元数据增强项异常 → best-effort 跳过，继续发（少这个标签/选项不影响有效帖）。
        if (bestEffort.has(cmd.kind)) {
          this.logger.warn(`[CommandSequencer] ${cmd.kind} 异常但 best-effort 跳过 seq=${cmd.seq}: ${error}`);
          continue;
        }
        this.logger.warn(`[CommandSequencer] seq=${cmd.seq} kind=${cmd.kind} 异常: ${error}`);
        // 7.5 就地 reject 以 CommandPreemptedError 形态到达：按类型判抢占（reason + submitDispatched），
        // 绝不当作普通超时/断连烧成 failed。非抢占异常（超时/断连/送达 0）保持旧语义。
        const preempted = err instanceof CommandPreemptedError ? err : null;
        return {
          ok: false,
          outcome: this.classifyFailureOutcome(submitted, preempted?.submitDispatched ?? false, preempted?.reason),
          attachedCount,
          failedAt: { seq: cmd.seq, kind: cmd.kind, error },
        };
      }
      if (!result.ok) {
        // 配图唯一放宽：upload_image 回 ok:false → 丢弃该张（不计入 K）、继续。
        if (cmd.kind === 'upload_image') {
          uploadsAttempted++;
          this.logger.warn(`[CommandSequencer] upload_image 失败丢弃该张 seq=${cmd.seq}: ${result.error ?? 'unknown'}`);
          continue;
        }
        // 已提交后抓 postId 失败：帖子已发出 → 非致命（postId 未知，绝不把已发布误判为 failed）。
        if (cmd.kind === 'capture_postId' && submitted) {
          this.logger.warn(`[CommandSequencer] capture_postId 失败但已提交发布、postId 未知 seq=${cmd.seq}: ${result.error ?? 'unknown'}`);
          continue;
        }
        // 元数据增强项失败 → best-effort 跳过，继续发（少这个标签/选项不影响有效帖）。
        if (bestEffort.has(cmd.kind)) {
          this.logger.warn(`[CommandSequencer] ${cmd.kind} 失败但 best-effort 跳过 seq=${cmd.seq}: ${result.error ?? 'unknown'}`);
          continue;
        }
        // 红线：核心步失败即停，后续不下发、不假成功。分档见 classifyFailureOutcome
        // （提交已派发→submitted_unconfirmed；抢占原因→preempted；余→failed_before_submit）。
        return {
          ok: false,
          outcome: this.classifyFailureOutcome(submitted, result.submitDispatched === true, result.error),
          attachedCount,
          failedAt: { seq: cmd.seq, kind: cmd.kind, error: result.error ?? 'unknown' },
        };
      }
      // 一张配图真实上传成功 → 计入尝试 + 计入 K。
      if (cmd.kind === 'upload_image') {
        uploadsAttempted++;
        attachedCount++;
      }
      if (cmd.kind === 'submit_publish') submitted = true;
      if (cmd.kind === 'capture_postId') {
        postId = result.value;
        // 详情页分享 URL（带 xsec_token）随 capture_postId 回报；边缘抓不到则 undefined（诚实置空，下游不写假链接）。
        postUrl = result.postUrl;
      }
    }

    // 未授权 → 序列不含 submit → 未真正发布（红线：不假成功）。
    if (!submitted) {
      return { ok: false, outcome: 'failed_before_submit', attachedCount, failedAt: { seq: -1, kind: 'submit_publish', error: 'not_approved' } };
    }
    return {
      ok: true,
      outcome: postId ? 'published_confirmed' : 'submitted_unconfirmed',
      attachedCount,
      postId,
      postUrl,
    };
  }

  /**
   * 提交前失败分档（change lease-strict-preemption 批 C）。三态优先级，顺序不可乱：
   * ① 提交动作已派发（前序 submit 已 ok:true，或本条回执带 submitDispatched）→ `submitted_unconfirmed`：
   *    帖子/评论可能已发出，绝不重投（防双发）。**压过抢占判据**——提交后被抢占仍是「已提交待确认」。
   * ② 抢占类原因（preempted_by_task / task_lease_mismatch / …）→ `preempted`：提交前零副作用、保持待审、事件驱动重投。
   * ③ 其余提交前失败 → `failed_before_submit`：可安全烧待审重投（content_too_long / all_images_failed / not_approved 等）。
   */
  private classifyFailureOutcome(
    submitted: boolean,
    submitDispatchedNow: boolean,
    reason: string | undefined,
  ): PublishSequenceResult['outcome'] {
    if (submitted || submitDispatchedNow) return 'submitted_unconfirmed';
    // yield_timeout（写者收到取消仍不停手＝控制面故障）：页面状态**未知**——卡死的写者可能仍会走完提交按下。
    // MUST NOT 当作「提交前零副作用」的 preempted 去自动重投（否则卡死写者最终按下提交 → 双发）。按「已提交待确认」
    // 终态处置（不重投、不烧稿），控制面回收 / 请运营重启客户端由边缘掉线侧信号驱动（spec 10.4）。
    if (reason === 'yield_timeout') return 'submitted_unconfirmed';
    if (isPreemptionReason(reason)) return 'preempted';
    return 'failed_before_submit';
  }

  /**
   * 7.5 活跃租约中断：抢占方释放到达时，就地 reject 属于该 taskId 的在飞 publish.command——
   * 使 executePublishSequence 的 catch 按 `CommandPreemptedError` 归入 preempted / submitted_unconfirmed，
   * **绝不 unwind executePublishSequence**（否则丢失 submitted 判据 → 提交后被抢的已发稿被重投双发）。
   * 无匹配在途指令时为 no-op（抢占发生在命令间隙，下一条命令会以 task_lease_mismatch 收敛）。
   */
  preemptTask(taskId: string, reason: PreemptionReason, submitDispatched = false): void {
    for (const [key, pending] of this.pending) {
      if (pending.taskId !== taskId) continue;
      clearTimeout(pending.timeoutHandle);
      this.pending.delete(key);
      this.logger.warn(`[CommandSequencer] taskId=${taskId} 被抢占（${reason}）→ 在途指令 key=${key} 就地作废`);
      pending.reject(new CommandPreemptedError(reason, submitDispatched));
    }
  }

  /**
   * 下发一条 publish.command 并等待其 result（按 recordId+seq 关联 + 超时清理）。
   * edgeId 指定则定向到该节点；缺省广播（向后兼容）。送达数为 0（含定向到的节点已离线）→ 诚实 reject（不假成功）。
   */
  sendAndWaitResult(cmd: PublishCommandPayload, edgeId?: string): Promise<PublishCommandResultPayload> {
    const key = `${cmd.recordId}:${cmd.seq}`;
    const envelope = makeEnvelope('publish.command', this.idGen(), this.clock(), cmd);
    // 指令自带执行预算（FB 正文按长度伸缩）→ 云端等「预算 + 兜底余量」，边缘必定先答，孤儿执行由构造消失。
    // 不带预算（小红书全路径）→ 逐字节沿用旧常数窗口：upload_image 用更宽超时，给边缘
    // 「下载+CDP+后置校验」留足空间先返回干净 ok:false（见 uploadTimeoutMs 说明）。
    const waitMs = cmd.timeoutMs !== undefined
      ? cmd.timeoutMs + this.resultSlackMs
      : cmd.kind === 'upload_image'
        ? this.uploadTimeoutMs
        : this.timeoutMs;
    return new Promise<PublishCommandResultPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`publish.command timeout seq=${cmd.seq} kind=${cmd.kind}`));
      }, waitMs);
      this.pending.set(key, { commandId: envelope.id, sentAt: this.clock(), taskId: cmd.taskId, edgeId, resolve, reject, timeoutHandle });

      const sent = this.pusher.pushToEdges(envelope, edgeId);
      if (sent <= 0) {
        clearTimeout(timeoutHandle);
        this.pending.delete(key);
        reject(new Error(`publish.command not dispatched (no edge) seq=${cmd.seq} kind=${cmd.kind}`));
      }
    });
  }

  /**
   * 边缘节点断开：立刻诚实失败该节点上所有在途指令，不必空等满预算。
   *
   * 必要性：正文填写的等待窗口现在随长度伸缩（可达数分钟），而发布是按账号串行的——
   * 边缘一死，若还傻等满预算，该账号后面所有已审稿件都跟着被堵在队列里。
   * 边缘自己在断连时也会作废在途发布，所以这里失败是如实反映、不是抢跑。
   */
  invalidateEdge(edgeId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.edgeId !== edgeId) continue;
      clearTimeout(pending.timeoutHandle);
      this.pending.delete(key);
      this.logger.warn(`[CommandSequencer] 边缘 ${edgeId} 断开 → 在途指令 key=${key} 诚实失败`);
      pending.reject(new Error(`publish.command edge disconnected edgeId=${edgeId} key=${key}`));
    }
  }

  /** 收到 publish.command.result：按 recordId+seq 关联 resolve（envelope.id 仅日志、不参与查找）。 */
  onResult(payload: PublishCommandResultPayload, envelopeId?: string): void {
    const key = `${payload.recordId}:${payload.seq}`;
    const pending = this.pending.get(key);
    if (!pending) {
      this.logger.warn(`[CommandSequencer] 收到无对应 pending 的结果 key=${key} envelopeId=${envelopeId ?? '-'}`);
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(key);
    pending.resolve(payload);
  }

  /** 当前 pending 数（测试可观测，验证无泄漏）。 */
  get pendingCount(): number {
    return this.pending.size;
  }
}
