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

/** 边缘推送接口（与 EdgeCloudServer.pushToEdges 同构）。 */
export interface SequencerPusher {
  pushToEdges(envelope: unknown, edgeId?: string): number;
}

/** 一次发布的编排输入（终稿 + 授权态；元数据维度本阶段占位预留）。 */
export interface PublishSequenceInput {
  recordId: number;
  title: string;
  content: string;
  tags: string[];
  /** 配图 URL（按序 emit upload_image；publish-media-upload change 接通边缘上传桥）。 */
  images?: string[];
  /** 封面图 URL（全部 upload_image 成功后才下发 set_cover；任一图失败则不下发）。 */
  cover?: string;
  /** 发帖元数据（stage-3 决策产物）：话题/@/地点/合集/可见范围/权限/合规/定时；下发为 edge 指令应用。 */
  metadata?: PublishMetadata;
  /** 是否已通过人审（AC-PUB）；false → 序列截止于提交前 */
  approvedByUser: boolean;
}

export interface PublishSequenceResult {
  ok: boolean;
  /** 成功时的真实平台 postId（来自 capture_postId 回报） */
  postId?: string;
  /**
   * 配图是否全部成功上传。请求了配图（images 非空）但任一 upload_image 失败/超时 → false（降级纯文字）。
   * 未请求配图时为 true（无图可降级）。executor 据 false 回正已落库的 imageUrl，杜绝纯文字帖留「有图」假信号。
   */
  imagesOk: boolean;
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
    // 配图先于正文：upload_image×N（计数无关循环、前向兼容多图）→ set_cover（执行期仅当全图成功才真实下发，见 executePublishSequence）。
    if (input.images) {
      for (const url of input.images) add('upload_image', { imageUrl: url });
    }
    // 封面：仅多图才下发 set_cover（选哪张当封面）。单图封面自动取该图——发布页无独立"设封面"控件，
    // 强发 set_cover 会 no_target→fail-fast 拖垮整条发布（task-0 实测）。
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
   * 配图失败处理（task-0 实测：图文帖编辑器被"先传图"门控）：
   * - upload_image 失败/超时 → 置 imagesOk=false、跳过依赖该图的 set_cover；
   * - 请求了配图（imagesRequested）而全失败 → 到 fill_field 前 MUST 诚实 failed（无有效图文帖），不假装纯文字继续；
   * - 仅当未请求配图（无图流，前向兼容）才存在"纯文字继续"路径。
   */
  async executePublishSequence(input: PublishSequenceInput): Promise<PublishSequenceResult> {
    const sequence = this.buildCommandSequence(input);
    const imagesRequested = !!(input.images && input.images.length);
    let postId: string | undefined;
    let submitted = false;
    let imagesOk = true;
    // 元数据是增强项，非有效帖必需：失败best-effort跳过、继续发（带标题/正文/图的帖子仍是有效帖）。
    // 绝不伪造该项成功——只是诚实地"少了这个标签/选项"继续。核心步（导航/选模式/标题/正文/提交）仍 fail-fast。
    const bestEffort = new Set<PublishCommandKind>(['add_with_candidate', 'set_option', 'set_schedule']);

    for (const cmd of sequence) {
      // 图文帖编辑器被"先传图"门控（task-0 实测：无图则标题/正文不存在）。请求了配图而全部失败 → 无有效帖，
      // MUST 诚实 failed，绝不进 fill_field 假装纯文字继续（红线：不假成功）。
      if (imagesRequested && !imagesOk && cmd.kind !== 'upload_image' && cmd.kind !== 'set_cover') {
        this.logger.warn(`[CommandSequencer] 全部配图失败、图文帖无有效内容 → failed seq=${cmd.seq}`);
        return { ok: false, imagesOk: false, failedAt: { seq: cmd.seq, kind: 'upload_image', error: 'all_images_failed' } };
      }
      // 配图失败已降级 → 不下发依赖该图的封面（红线：绝不在配图失败后下发 set_cover）。
      if (cmd.kind === 'set_cover' && !imagesOk) {
        this.logger.warn(`[CommandSequencer] 配图已降级，跳过 set_cover seq=${cmd.seq}`);
        continue;
      }

      let result: PublishCommandResultPayload;
      try {
        result = await this.sendAndWaitResult(cmd);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // 配图唯一放宽：upload_image 超时/异常 → 降级纯文字、继续。
        if (cmd.kind === 'upload_image') {
          this.logger.warn(`[CommandSequencer] upload_image 异常降级纯文字 seq=${cmd.seq}: ${error}`);
          imagesOk = false;
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
        return { ok: false, imagesOk, failedAt: { seq: cmd.seq, kind: cmd.kind, error } };
      }
      if (!result.ok) {
        // 配图唯一放宽：upload_image 回 ok:false → 降级纯文字、继续。
        if (cmd.kind === 'upload_image') {
          this.logger.warn(`[CommandSequencer] upload_image 失败降级纯文字 seq=${cmd.seq}: ${result.error ?? 'unknown'}`);
          imagesOk = false;
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
        return { ok: false, imagesOk, failedAt: { seq: cmd.seq, kind: cmd.kind, error: result.error ?? 'unknown' } };
      }
      if (cmd.kind === 'submit_publish') submitted = true;
      if (cmd.kind === 'capture_postId') postId = result.value;
    }

    // 未授权 → 序列不含 submit → 未真正发布（红线：不假成功）。
    if (!submitted) {
      return { ok: false, imagesOk, failedAt: { seq: -1, kind: 'submit_publish', error: 'not_approved' } };
    }
    return { ok: true, imagesOk, postId };
  }

  /** 下发一条 publish.command 并等待其 result（按 recordId+seq 关联 + 超时清理）。 */
  sendAndWaitResult(cmd: PublishCommandPayload): Promise<PublishCommandResultPayload> {
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

      const sent = this.pusher.pushToEdges(envelope);
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
