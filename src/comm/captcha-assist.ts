import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  makeEnvelope,
  type BlockingOverlaySnapshotPayload,
  type CaptchaAssistCapturePayload,
  type CaptchaAssistClickPayload,
  type CaptchaAssistClickPointPayload,
  type CaptchaAssistTrajectoryPayload,
  type CaptchaAssistClickResultPayload,
  type CaptchaAssistSnapshotPayload,
  type CaptchaDetectedPayload,
} from './protocol.js';
import type { EdgeSession } from './ws-server.js';
import type { EdgeTaskLease, EdgeTaskLeaseClient } from './edge-task-lease-client.js';

export type CaptchaAssistIncidentStatus =
  | 'detected'
  | 'capture_pending'
  | 'ready'
  | 'click_pending'
  | 'cleared'
  | 'still_blocked'
  | 'failed'
  | 'expired';

export interface CaptchaAssistIncidentView {
  incidentId: string;
  edgeId: string;
  accountId?: string;
  accountName?: string;
  machineLabel?: string;
  remoteAddr?: string;
  kind: 'captcha' | 'unknown';
  status: CaptchaAssistIncidentStatus;
  riskStatus?: string;
  detectedAt: number;
  updatedAt: number;
  expiresAt: number;
  url?: string;
  overlay?: BlockingOverlaySnapshotPayload;
  snapshot?: CaptchaAssistSnapshotPayload;
  lastResult?: {
    status: CaptchaAssistClickResultPayload['status'];
    reason?: string;
    checkedAt: number;
    snapshotId?: string;
  };
  lastDispatch?: {
    type: 'capture' | 'click';
    requestedAt: number;
    sent: number;
    actor: string;
  };
  /**
   * 实时抓帧窗口截止时间（change captcha-assist-live-snapshot）：edge 的有界实时循环预计运行到此刻。
   * 控制台据此亮"实时"指示；`clock() < liveUntil` 视为实时中。仅在 live 开启时置。
   */
  liveUntil?: number;
}

export interface CaptchaAssistDetectedResult {
  incidentId: string;
  actionUrl: string;
  sent: number;
}

export type CaptchaAssistTokenVerifyResult =
  | { ok: true; incidentId: string; exp: number; iat: number }
  | { ok: false; reason: 'missing_secret' | 'malformed' | 'bad_signature' | 'expired' | 'wrong_scope' };

export type CaptchaAssistDispatchResult =
  | { ok: true; sent: number; incident: CaptchaAssistIncidentView }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'edge_offline'
        | 'snapshot_required'
        | 'snapshot_mismatch'
        | 'invalid_points'
        | 'task_busy'
        | 'task_lease_failed';
      incident?: CaptchaAssistIncidentView;
    };

export interface CaptchaAssistServiceDeps {
  enabled: boolean;
  publicBaseUrl?: string;
  tokenSecret?: string;
  tokenTtlSeconds?: number;
  incidentTtlMs?: number;
  clock?: () => number;
  idGen?: () => string;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
  getAccountName?: (accountId: string) => string | null | undefined;
  pusher: { pushToEdges(env: ReturnType<typeof makeEnvelope>, edgeId?: string): number };
  taskLeases?: Pick<EdgeTaskLeaseClient, 'acquire' | 'release'>;
  /**
   * 实时抓帧配置（change captcha-assist-live-snapshot）。enabled 时，capture 命令带 `live` 字段，
   * edge 进入有界去重实时循环；关闭 = 今天的单次抓帧（零回归）。intervalMs/maxDurationMs/maxFrames
   * 只是给 edge 的 hint，edge 一律再钳制到安全区间。
   */
  liveCapture?: {
    enabled: boolean;
    intervalMs?: number;
    maxDurationMs?: number;
    maxFrames?: number;
  };
}

interface CaptchaAssistIncident extends CaptchaAssistIncidentView {}

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 60;
const DEFAULT_INCIDENT_TTL_MS = 30 * 60_000;
// 云端为每 incident 保留最近若干帧的 snapshotId（放宽提交校验用）。必须 ≤ 边缘帧环容量(8)，
// 确保云端放行的 snapshotId 边缘一定还留着（否则云端放行、边缘已淘汰 → 白跑）。
const RECENT_SNAPSHOT_IDS = 5;
const DEFAULT_LIVE_MAX_DURATION_MS = 30_000;
/**
 * 7.10（change lease-strict-preemption）：验证码协助（system_recovery）取回执的受理超时。
 * 20s→45s——必须容得下被抢者最长的不可逆提交窗口（≈20s）+ 取消停手 + 让位交接 + 一个消息往返，
 * 否则边缘还在合法交接、云端已判死走人（11.8 参数一致性：云端受理预算 > 最长提交窗口）。
 * 与边缘排队默认 45s（5.6）对齐成一致的受理预算阶梯。
 */
const CAPTCHA_ASSIST_ACQUIRE_TIMEOUT_MS = 45_000;

export class CaptchaAssistService {
  private readonly incidents = new Map<string, CaptchaAssistIncident>();
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  private readonly tokenTtlSeconds: number;
  private readonly incidentTtlMs: number;
  private readonly recoveryLeases = new Map<string, { lease: EdgeTaskLease; timer: ReturnType<typeof setTimeout> }>();
  // 每 incident 最近 N 帧 snapshotId（newest last）：放宽 submitClick 校验，容纳运营点冻结的稍旧帧。
  private readonly recentSnapshotIds = new Map<string, string[]>();

  constructor(private readonly deps: CaptchaAssistServiceDeps) {
    this.clock = deps.clock ?? Date.now;
    this.idGen = deps.idGen ?? (() => `cap_${randomUUID()}`);
    this.logger = deps.logger ?? console;
    this.tokenTtlSeconds = deps.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.incidentTtlMs = deps.incidentTtlMs ?? DEFAULT_INCIDENT_TTL_MS;
  }

  isAvailable(): boolean {
    return Boolean(this.deps.enabled && this.deps.publicBaseUrl && this.deps.tokenSecret);
  }

  async onDetected(
    payload: CaptchaDetectedPayload,
    session: EdgeSession,
    status: string,
  ): Promise<CaptchaAssistDetectedResult | null> {
    if (!this.isAvailable()) return null;
    const edgeId = payload.edgeId ?? session.edgeId;
    if (!edgeId) return null;

    const now = this.clock();
    const accountId = payload.accountId ?? session.accountId;
    const incident = this.findActiveByEdge(edgeId, accountId) ?? this.createIncident(payload, session, edgeId, now);
    incident.kind = payload.kind;
    incident.url = payload.url ?? incident.url;
    incident.overlay = payload.overlay ?? incident.overlay;
    incident.accountId = accountId ?? incident.accountId;
    incident.accountName = accountId ? normalizeAccountName(this.deps.getAccountName?.(accountId)) : incident.accountName;
    incident.machineLabel = session.machineLabel ?? incident.machineLabel;
    incident.remoteAddr = session.remoteAddr ?? incident.remoteAddr;
    incident.riskStatus = status || incident.riskStatus;
    incident.updatedAt = now;
    incident.expiresAt = now + this.incidentTtlMs;
    if (incident.status === 'cleared' || incident.status === 'expired') incident.status = 'detected';

    const dispatch = await this.requestCapture(incident.incidentId, 'system', 'initial');
    this.logger.log('[captcha-assist] incident ready', {
      incidentId: incident.incidentId,
      edgeId,
      accountId,
      riskStatus: status,
      captureSent: dispatch.ok ? dispatch.sent : 0,
      captureReason: dispatch.ok ? undefined : dispatch.reason,
    });
    return {
      incidentId: incident.incidentId,
      actionUrl: this.actionUrl(incident.incidentId) ?? '',
      sent: dispatch.ok ? dispatch.sent : 0,
    };
  }

  onCleared(edgeId: string | undefined, accountId?: string): void {
    if (!edgeId) return;
    const now = this.clock();
    for (const incident of this.incidents.values()) {
      if (incident.edgeId !== edgeId) continue;
      if (accountId && incident.accountId && incident.accountId !== accountId) continue;
      if (incident.status === 'cleared') continue;
      incident.status = 'cleared';
      incident.updatedAt = now;
    }
  }

  onSnapshot(payload: CaptchaAssistSnapshotPayload): void {
    const incident = this.incidents.get(payload.incidentId);
    if (!incident) {
      this.logger.warn('[captcha-assist] snapshot for unknown incident', { incidentId: payload.incidentId });
      return;
    }
    if (this.markExpiredIfNeeded(incident)) return;
    // 迟到的实时帧 MUST NOT 把已清除/过期态复活为 ready（change captcha-assist-live-snapshot）：
    // 实时循环是 800ms 自主抓帧，onCleared 之后仍可能有在途帧到达，无守卫会把 cleared 翻回 ready、
    // 污染风控恢复语义。已终态的 incident 直接忽略入帧。
    if (incident.status === 'cleared' || incident.status === 'expired') return;
    incident.snapshot = payload;
    incident.kind = payload.kind;
    incident.url = payload.url ?? incident.url;
    incident.overlay = payload.overlay ?? incident.overlay;
    incident.accountId = payload.accountId ?? incident.accountId;
    incident.updatedAt = this.clock();
    incident.status = 'ready';
    this.rememberSnapshotId(payload.incidentId, payload.snapshotId);
  }

  onClickResult(payload: CaptchaAssistClickResultPayload): void {
    const incident = this.incidents.get(payload.incidentId);
    if (!incident) {
      this.logger.warn('[captcha-assist] click result for unknown incident', { incidentId: payload.incidentId });
      return;
    }
    if (payload.snapshot) this.onSnapshot(payload.snapshot);
    const now = this.clock();
    incident.lastResult = {
      status: payload.status,
      ...(payload.reason ? { reason: payload.reason } : {}),
      checkedAt: payload.checkedAt,
      ...(payload.snapshotId ? { snapshotId: payload.snapshotId } : {}),
    };
    incident.updatedAt = now;
    if (payload.status === 'cleared' || payload.status === 'not_blocked') {
      incident.status = 'cleared';
    } else if (payload.status === 'still_blocked' || payload.status === 'stale_snapshot') {
      incident.status = 'still_blocked';
    } else {
      incident.status = 'failed';
    }
    void this.releaseRecoveryLease(payload.incidentId, 'completed');
  }

  getIncident(incidentId: string): CaptchaAssistIncidentView | null {
    const incident = this.incidents.get(incidentId);
    if (!incident) return null;
    this.markExpiredIfNeeded(incident);
    return incident;
  }

  async requestCapture(
    incidentId: string,
    actor: string,
    reason: 'initial' | 'refresh' | 'retry' = 'refresh',
    opts: { keepStatus?: boolean } = {},
  ): Promise<CaptchaAssistDispatchResult> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return { ok: false, reason: 'not_found' };
    if (this.markExpiredIfNeeded(incident)) return { ok: false, reason: 'expired', incident };
    const now = this.clock();
    const live = this.buildLiveHint();
    const sent = this.deps.pusher.pushToEdges(
      makeEnvelope('captcha.assist.capture', `captcha-assist-capture-${incidentId}-${now}`, now, {
        incidentId,
        reason,
        requestedAt: now,
        maxImageWidth: 1600,
        maxImageHeight: 1600,
        quality: 75,
        ...(live ? { live } : {}),
      }),
      incident.edgeId,
    );
    // keepStatus（在场 re-arm 用）：已在展示帧时不把状态降回 capture_pending，避免每窗口一次"截图中"闪烁。
    const showing = incident.status === 'ready' || incident.status === 'still_blocked';
    if (!(opts.keepStatus && showing)) {
      incident.status = sent > 0 ? 'capture_pending' : 'detected';
    }
    if (live && sent > 0) {
      const durationMs = this.deps.liveCapture?.maxDurationMs ?? DEFAULT_LIVE_MAX_DURATION_MS;
      incident.liveUntil = now + durationMs;
    }
    incident.updatedAt = now;
    incident.lastDispatch = { type: 'capture', requestedAt: now, sent, actor };
    if (sent <= 0) return { ok: false, reason: 'edge_offline', incident };
    return { ok: true, sent, incident };
  }

  /**
   * 运营在场信号（change captcha-assist-live-snapshot）：控制台每次轮询 incident 即视为"人在处理页"。
   * 实时窗口是有界的（edge 会自终止），仅靠一个固定盲目窗口会在运营到场前就结束。此处用免费的轮询信号
   * 在窗口到期后重新武装 edge 实时循环——运营还在看就续，人一走轮询停、窗口自然过期、循环自终止。
   * 关闭 live 或 incident 非可交互态时为 no-op（零回归）。
   */
  noteViewerPresence(incidentId: string): void {
    if (!this.deps.liveCapture?.enabled) return;
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    if (this.markExpiredIfNeeded(incident)) return;
    if (!isInteractiveStatus(incident.status)) return;
    // 仅当上一实时窗口已到期才重新武装（约每 maxDuration 一次），避免每次轮询都发 capture。
    if (incident.liveUntil && this.clock() < incident.liveUntil) return;
    void this.requestCapture(incidentId, 'viewer', 'refresh', { keepStatus: true });
  }

  private buildLiveHint(): CaptchaAssistCapturePayload['live'] {
    const cfg = this.deps.liveCapture;
    if (!cfg?.enabled) return undefined;
    return {
      ...(typeof cfg.intervalMs === 'number' ? { intervalMs: cfg.intervalMs } : {}),
      ...(typeof cfg.maxDurationMs === 'number' ? { maxDurationMs: cfg.maxDurationMs } : {}),
      ...(typeof cfg.maxFrames === 'number' ? { maxFrames: cfg.maxFrames } : {}),
    };
  }

  private rememberSnapshotId(incidentId: string, snapshotId: string): void {
    const ids = this.recentSnapshotIds.get(incidentId) ?? [];
    // 去重后追加，环内保留最近 N 个。
    const next = ids.filter((id) => id !== snapshotId);
    next.push(snapshotId);
    while (next.length > RECENT_SNAPSHOT_IDS) next.shift();
    this.recentSnapshotIds.set(incidentId, next);
  }

  private isRecentSnapshot(incidentId: string, snapshotId: string): boolean {
    return this.recentSnapshotIds.get(incidentId)?.includes(snapshotId) ?? false;
  }

  async submitClick(input: {
    incidentId: string;
    snapshotId: string;
    points: CaptchaAssistClickPointPayload[];
    actor: string;
    settleMs?: number;
    /** 运营真实鼠标轨迹（change captcha-assist-trajectory-replay）；sanitize 不过则丢弃、保留 points 继续。 */
    trajectory?: CaptchaAssistTrajectoryPayload;
  }): Promise<CaptchaAssistDispatchResult> {
    const incident = this.incidents.get(input.incidentId);
    if (!incident) return { ok: false, reason: 'not_found' };
    if (this.markExpiredIfNeeded(incident)) return { ok: false, reason: 'expired', incident };
    if (!incident.snapshot) return { ok: false, reason: 'snapshot_required', incident };
    // 放宽陈旧守卫（change captcha-assist-live-snapshot）：实时循环会把 incident.snapshot 推进到最新，
    // 运营提交的是被冻结的稍旧帧。接受"最新帧 或 最近 N 帧集内"的 snapshotId——否则实时开启后提交几乎
    // 必撞 snapshot_mismatch、边缘帧环成死代码、白跑不降反升。边缘按被点帧自己的 crop 落点，坐标不错位。
    if (incident.snapshot.snapshotId !== input.snapshotId && !this.isRecentSnapshot(input.incidentId, input.snapshotId)) {
      return { ok: false, reason: 'snapshot_mismatch', incident };
    }
    if (!isValidPointList(input.points)) {
      return { ok: false, reason: 'invalid_points', incident };
    }
    if (this.recoveryLeases.has(input.incidentId)) {
      return { ok: false, reason: 'task_busy', incident };
    }

    let recoveryLease: EdgeTaskLease | undefined;
    if (this.deps.taskLeases) {
      try {
        recoveryLease = await this.deps.taskLeases.acquire({
          edgeId: incident.edgeId,
          kind: 'system_recovery',
          priority: 'system_recovery',
          leaseMs: 60_000,
          acquireTimeoutMs: CAPTCHA_ASSIST_ACQUIRE_TIMEOUT_MS,
        });
      } catch (err) {
        this.logger.warn(`[captcha-assist] system recovery lease failed incident=${input.incidentId}: ${(err as Error).message}`);
        return { ok: false, reason: 'task_lease_failed', incident };
      }
    }

    const now = this.clock();
    // 轨迹透传守卫（change captcha-assist-trajectory-replay）：sanitize 通过才外发；畸形/超限则丢弃、
    // 保留 points 继续（可观测：记日志，绝不静默丢）。边缘还会再校验一次（纵深）。
    const cleanTrajectory = sanitizeTrajectoryForForward(input.trajectory, input.points.length);
    if (input.trajectory && !cleanTrajectory) {
      this.logger.warn(`[captcha-assist] 轨迹被丢弃（畸形/超限），保留 points 继续 incident=${input.incidentId}`);
    }
    const payload: CaptchaAssistClickPayload = {
      ...(recoveryLease ? { taskId: recoveryLease.taskId } : {}),
      incidentId: input.incidentId,
      snapshotId: input.snapshotId,
      points: input.points.map((p) => ({ x: p.x, y: p.y, ...(p.label ? { label: p.label } : {}) })),
      requestedAt: now,
      ...(typeof input.settleMs === 'number' && Number.isFinite(input.settleMs) ? { settleMs: input.settleMs } : {}),
      ...(cleanTrajectory ? { trajectory: cleanTrajectory } : {}),
    };
    const sent = this.deps.pusher.pushToEdges(
      makeEnvelope('captcha.assist.click', `captcha-assist-click-${input.incidentId}-${now}`, now, payload),
      incident.edgeId,
    );
    incident.status = sent > 0 ? 'click_pending' : 'ready';
    incident.updatedAt = now;
    incident.lastDispatch = { type: 'click', requestedAt: now, sent, actor: input.actor };
    if (sent <= 0) {
      if (recoveryLease) await this.deps.taskLeases?.release(recoveryLease, 'failed').catch(() => {});
      return { ok: false, reason: 'edge_offline', incident };
    }
    if (recoveryLease) {
      const timer = setTimeout(() => { void this.releaseRecoveryLease(input.incidentId, 'failed'); }, 60_000);
      timer.unref?.();
      this.recoveryLeases.set(input.incidentId, { lease: recoveryLease, timer });
    }
    return { ok: true, sent, incident };
  }

  private async releaseRecoveryLease(
    incidentId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const held = this.recoveryLeases.get(incidentId);
    if (!held) return;
    this.recoveryLeases.delete(incidentId);
    clearTimeout(held.timer);
    await this.deps.taskLeases?.release(held.lease, outcome).catch((err) => {
      this.logger.warn(`[captcha-assist] system recovery release failed incident=${incidentId}: ${(err as Error).message}`);
    });
  }

  actionUrl(incidentId: string): string | undefined {
    if (!this.isAvailable()) return undefined;
    const base = (this.deps.publicBaseUrl ?? '').replace(/\/+$/, '');
    const token = this.signToken(incidentId);
    return `${base}/captcha-assist/${encodeURIComponent(incidentId)}?token=${encodeURIComponent(token)}`;
  }

  signToken(incidentId: string): string {
    const secret = this.deps.tokenSecret;
    if (!secret) throw new Error('captcha_assist_token_secret_missing');
    const nowSec = Math.floor(this.clock() / 1000);
    const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
    const payload = encodeJson({
      scope: 'captcha_assist',
      incidentId,
      iat: nowSec,
      exp: nowSec + this.tokenTtlSeconds,
    });
    const signature = sign(`${header}.${payload}`, secret);
    return `${header}.${payload}.${signature}`;
  }

  verifyToken(token: string | undefined): CaptchaAssistTokenVerifyResult {
    const secret = this.deps.tokenSecret;
    if (!secret) return { ok: false, reason: 'missing_secret' };
    if (!token) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [header, payload, signature] = parts;
    if (!safeSignatureEquals(signature, sign(`${header}.${payload}`, secret))) {
      return { ok: false, reason: 'bad_signature' };
    }
    let decoded: { scope?: unknown; incidentId?: unknown; iat?: unknown; exp?: unknown };
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (decoded.scope !== 'captcha_assist') return { ok: false, reason: 'wrong_scope' };
    if (typeof decoded.incidentId !== 'string' || typeof decoded.exp !== 'number' || typeof decoded.iat !== 'number') {
      return { ok: false, reason: 'malformed' };
    }
    const nowSec = Math.floor(this.clock() / 1000);
    if (decoded.exp <= nowSec) return { ok: false, reason: 'expired' };
    return { ok: true, incidentId: decoded.incidentId, exp: decoded.exp, iat: decoded.iat };
  }

  private createIncident(
    payload: CaptchaDetectedPayload,
    session: EdgeSession,
    edgeId: string,
    now: number,
  ): CaptchaAssistIncident {
    const accountId = payload.accountId ?? session.accountId;
    const incident: CaptchaAssistIncident = {
      incidentId: this.idGen(),
      edgeId,
      ...(accountId ? { accountId, accountName: normalizeAccountName(this.deps.getAccountName?.(accountId)) } : {}),
      ...(session.machineLabel ? { machineLabel: session.machineLabel } : {}),
      ...(session.remoteAddr ? { remoteAddr: session.remoteAddr } : {}),
      kind: payload.kind,
      status: 'detected',
      riskStatus: 'restricted',
      detectedAt: now,
      updatedAt: now,
      expiresAt: now + this.incidentTtlMs,
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.overlay ? { overlay: payload.overlay } : {}),
    };
    this.incidents.set(incident.incidentId, incident);
    return incident;
  }

  private findActiveByEdge(edgeId: string, accountId: string | undefined): CaptchaAssistIncident | null {
    for (const incident of this.incidents.values()) {
      if (incident.edgeId !== edgeId) continue;
      if (accountId && incident.accountId && incident.accountId !== accountId) continue;
      if (this.markExpiredIfNeeded(incident)) continue;
      if (incident.status === 'cleared') continue;
      return incident;
    }
    return null;
  }

  private markExpiredIfNeeded(incident: CaptchaAssistIncident): boolean {
    if (incident.status === 'cleared') return false;
    if (this.clock() <= incident.expiresAt) return false;
    incident.status = 'expired';
    incident.updatedAt = this.clock();
    return true;
  }
}

function normalizeAccountName(name: string | null | undefined): string | undefined {
  const clean = name?.trim();
  return clean || undefined;
}

/** 可交互态（运营可能在处理页看/点）：非终态即可实时武装。cleared/expired/failed 不再武装。 */
function isInteractiveStatus(status: CaptchaAssistIncidentStatus): boolean {
  return status === 'detected' || status === 'capture_pending' || status === 'ready' || status === 'click_pending' || status === 'still_blocked';
}

function isValidPointList(points: CaptchaAssistClickPointPayload[]): boolean {
  return (
    Array.isArray(points) &&
    points.length > 0 &&
    points.length <= 8 &&
    points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
  );
}

/** 云端最多透传的轨迹样本数（与边缘上限一致；超限=畸形→丢弃、保留 points）。 */
const MAX_TRAJECTORY_SAMPLES = 250;

/**
 * 校验运营轨迹是否可透传给边缘（change captcha-assist-trajectory-replay）。任一不合法返回 null，
 * 调用方丢弃轨迹、保留 points 继续（可观测，非静默）。边缘会再校验一次（纵深防御）。
 * 校验与边缘 sanitizeTrajectory 同口径：v===1、样本非空且 ≤ MAX、坐标∈[0,1]、t 有限、
 * clicks 长度===点数且每项为 [0,samples) 内整数。
 */
function sanitizeTrajectoryForForward(
  traj: CaptchaAssistTrajectoryPayload | undefined,
  pointsLen: number,
): CaptchaAssistTrajectoryPayload | null {
  if (!traj || traj.v !== 1) return null;
  const { samples, clicks } = traj;
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_TRAJECTORY_SAMPLES) return null;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.t)) return null;
    if (s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1) return null;
  }
  if (!Array.isArray(clicks) || clicks.length !== pointsLen) return null;
  for (const c of clicks) {
    if (!Number.isInteger(c) || c < 0 || c >= samples.length) return null;
  }
  return traj;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function safeSignatureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
