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
  PublishCommandParams,
  PublishCommandPayload,
  PublishCommandResultPayload,
} from '../comm/protocol.js';
import type { PublishMetadata } from './types.js';

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
  title: string;
  content: string;
  tags: string[];
  /** 配图 URL（按序 emit upload_image×N；多图逐张上传，publish-multi-image）。 */
  images?: string[];
  /** 封面图 URL（本期不传：封面=首张上传=平台默认；仅 cover 且 images>1 才下发 set_cover，见 buildCommandSequence）。 */
  cover?: string;
  /** 发帖元数据（stage-3 决策产物）：话题/@/地点/合集/可见范围/权限/合规/定时；下发为 edge 指令应用。 */
  metadata?: PublishMetadata;
  /** 是否已通过人审（AC-PUB）；false → 序列截止于提交前 */
  approvedByUser: boolean;
  /**
   * 目标边缘节点 edgeId（change publish-history-account-and-detail）。指定则本次序列所有指令**定向**到该节点、
   * 不广播；缺省（旧路径/单边缘）则广播（向后兼容）。云端已据目标账号解析出在线节点（无节点则在 executor 诚实失败、不入此序列）。
   */
  edgeId?: string;
}

export interface PublishSequenceResult {
  ok: boolean;
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
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface Pending {
  commandId: string;
  sentAt: number;
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
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: CommandSequencerDeps) {
    this.pusher = deps.pusher;
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
    this.clock = deps.clock ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.uploadTimeoutMs = deps.uploadTimeoutMs ?? 60_000;
    this.logger = deps.logger ?? console;
  }

  /** 终稿 → 有序指令序列。AC-PUB 第 2 道：未授权则截止于提交前。 */
  buildCommandSequence(input: PublishSequenceInput): PublishCommandPayload[] {
    const cmds: PublishCommandPayload[] = [];
    let seq = 0;
    const add = (kind: PublishCommandKind, params: PublishCommandParams = {}) => {
      cmds.push({ recordId: input.recordId, seq: seq++, kind, params });
    };

    add('navigate_entry');
    add('select_mode');
    // 配图先于正文：upload_image×N 逐张上传（多图，publish-multi-image）→ 执行期按真实成功数 K 记账（见 executePublishSequence）。
    if (input.images) {
      for (const url of input.images) add('upload_image', { imageUrl: url });
    }
    // 封面：仅 cover 且多图才下发 set_cover。本期下发段传 cover:undefined → 不触发（封面=首张上传=平台默认）；
    // edge set_cover 仍 fail-closed 未校准，强发会 no_target→fail-fast 拖垮整条发布（task-0 实测）。留此分支供后续设封面那期。
    if (input.cover && input.images && input.images.length > 1) add('set_cover', { imageUrl: input.cover });
    add('fill_field', { fieldType: 'title', value: input.title });
    add('fill_field', { fieldType: 'content', value: input.content });
    for (const tag of input.tags) {
      // 候选项云端预生成随 params 下发，边缘只定位点击（边轻云重）。
      add('add_with_candidate', { candidateKind: 'topic', value: tag, candidates: [tag] });
    }

    // stage-4 元数据应用：把 stage-3 决策的元数据下发为 edge 指令（配图 upload_image 在后续 change）。
    const md = input.metadata;
    if (md) {
      for (const mention of md.mentions) {
        add('add_with_candidate', { candidateKind: 'mention', value: mention, candidates: [mention] });
      }
      if (md.location) add('add_with_candidate', { candidateKind: 'location', value: md.location, candidates: [md.location] });
      if (md.collection) add('add_with_candidate', { candidateKind: 'collection', value: md.collection, candidates: [md.collection] });
      // 可见范围（硬必选）+ 权限开关 + 合规声明（仅置位为 true 的声明）。
      add('set_option', { optionKind: 'visibility', optionValue: md.visibility });
      add('set_option', { optionKind: 'comment_permission', optionValue: md.permissions.comment });
      add('set_option', { optionKind: 'save_permission', optionValue: md.permissions.save });
      if (md.compliance.ai) add('set_option', { optionKind: 'declaration_ai', optionValue: 'true' });
      if (md.compliance.ad) add('set_option', { optionKind: 'declaration_ad', optionValue: 'true' });
      if (md.compliance.origin) add('set_option', { optionKind: 'declaration_origin', optionValue: 'true' });
      // 定时发布（仅 scheduled 且有时刻）。
      if (md.mode === 'scheduled' && md.publishTime) add('set_schedule', { publishTime: md.publishTime });
    }

    // AC-PUB 第 2 道闸：未授权 → 提交前截止，submit_publish / capture_postId 不入序列。
    if (!input.approvedByUser) return cmds;

    add('submit_publish');
    add('capture_postId');
    return cmds;
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
        return { ok: false, attachedCount: 0, failedAt: { seq: lastUploadSeq, kind: 'upload_image', error: 'all_images_failed' } };
      }
      // 无成功配图 → 不下发依赖首图的封面（红线：绝不在配图全失败后下发 set_cover）。
      if (cmd.kind === 'set_cover' && attachedCount === 0) {
        this.logger.warn(`[CommandSequencer] 无成功配图，跳过 set_cover seq=${cmd.seq}`);
        continue;
      }
      // 记录末条 upload seq（发送前即记；供上方 K===0 早停诚实归因）。
      if (cmd.kind === 'upload_image') lastUploadSeq = cmd.seq;

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
        return { ok: false, attachedCount, failedAt: { seq: cmd.seq, kind: cmd.kind, error } };
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
        // 红线：核心步失败即停，后续不下发、不假成功。
        return { ok: false, attachedCount, failedAt: { seq: cmd.seq, kind: cmd.kind, error: result.error ?? 'unknown' } };
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
      return { ok: false, attachedCount, failedAt: { seq: -1, kind: 'submit_publish', error: 'not_approved' } };
    }
    return { ok: true, attachedCount, postId, postUrl };
  }

  /**
   * 下发一条 publish.command 并等待其 result（按 recordId+seq 关联 + 超时清理）。
   * edgeId 指定则定向到该节点；缺省广播（向后兼容）。送达数为 0（含定向到的节点已离线）→ 诚实 reject（不假成功）。
   */
  sendAndWaitResult(cmd: PublishCommandPayload, edgeId?: string): Promise<PublishCommandResultPayload> {
    const key = `${cmd.recordId}:${cmd.seq}`;
    const envelope = makeEnvelope('publish.command', this.idGen(), this.clock(), cmd);
    // upload_image 用更宽超时，给边缘「下载+CDP+后置校验」留足空间先返回干净 ok:false（见 uploadTimeoutMs 说明）。
    const waitMs = cmd.kind === 'upload_image' ? this.uploadTimeoutMs : this.timeoutMs;
    return new Promise<PublishCommandResultPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`publish.command timeout seq=${cmd.seq} kind=${cmd.kind}`));
      }, waitMs);
      this.pending.set(key, { commandId: envelope.id, sentAt: this.clock(), resolve, reject, timeoutHandle });

      const sent = this.pusher.pushToEdges(envelope, edgeId);
      if (sent <= 0) {
        clearTimeout(timeoutHandle);
        this.pending.delete(key);
        reject(new Error(`publish.command not dispatched (no edge) seq=${cmd.seq} kind=${cmd.kind}`));
      }
    });
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
