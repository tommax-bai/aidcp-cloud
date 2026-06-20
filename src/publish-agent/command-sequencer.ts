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
  /** 配图 URL（配图 e2e 在后续 publish-media-upload change，暂不入序列） */
  images?: string[];
  /** 发帖元数据（stage-3 决策产物）：话题/@/地点/合集/可见范围/权限/合规/定时；下发为 edge 指令应用。 */
  metadata?: PublishMetadata;
  /** 是否已通过人审（AC-PUB）；false → 序列截止于提交前 */
  approvedByUser: boolean;
}

export interface PublishSequenceResult {
  ok: boolean;
  /** 成功时的真实平台 postId（来自 capture_postId 回报） */
  postId?: string;
  /** 失败位置（seq=-1 表示未授权而未生成提交指令） */
  failedAt?: { seq: number; kind: PublishCommandKind; error: string };
}

export interface CommandSequencerDeps {
  pusher: SequencerPusher;
  idGen?: () => string;
  clock?: () => number;
  /** 单条指令等待回报的超时（毫秒，缺省 30s） */
  timeoutMs?: number;
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
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: CommandSequencerDeps) {
    this.pusher = deps.pusher;
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
    this.clock = deps.clock ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
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

  /** 驱动整条序列：逐条 send→await→advance；任一失败即停。 */
  async executePublishSequence(input: PublishSequenceInput): Promise<PublishSequenceResult> {
    const sequence = this.buildCommandSequence(input);
    let postId: string | undefined;
    let submitted = false;

    for (const cmd of sequence) {
      let result: PublishCommandResultPayload;
      try {
        result = await this.sendAndWaitResult(cmd);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[CommandSequencer] seq=${cmd.seq} kind=${cmd.kind} 异常: ${error}`);
        return { ok: false, failedAt: { seq: cmd.seq, kind: cmd.kind, error } };
      }
      // 红线：某条失败即停，后续不下发、不假成功。
      if (!result.ok) {
        return { ok: false, failedAt: { seq: cmd.seq, kind: cmd.kind, error: result.error ?? 'unknown' } };
      }
      if (cmd.kind === 'submit_publish') submitted = true;
      if (cmd.kind === 'capture_postId') postId = result.value;
    }

    // 未授权 → 序列不含 submit → 未真正发布（红线：不假成功）。
    if (!submitted) {
      return { ok: false, failedAt: { seq: -1, kind: 'submit_publish', error: 'not_approved' } };
    }
    return { ok: true, postId };
  }

  /** 下发一条 publish.command 并等待其 result（按 recordId+seq 关联 + 超时清理）。 */
  sendAndWaitResult(cmd: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const key = `${cmd.recordId}:${cmd.seq}`;
    const envelope = makeEnvelope('publish.command', this.idGen(), this.clock(), cmd);
    return new Promise<PublishCommandResultPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`publish.command timeout seq=${cmd.seq} kind=${cmd.kind}`));
      }, this.timeoutMs);
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
