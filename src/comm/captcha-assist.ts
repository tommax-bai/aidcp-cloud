import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  makeEnvelope,
  type BlockingOverlaySnapshotPayload,
  type CaptchaAssistClickPayload,
  type CaptchaAssistClickPointPayload,
  type CaptchaAssistClickResultPayload,
  type CaptchaAssistSnapshotPayload,
  type CaptchaDetectedPayload,
} from './protocol.js';
import type { EdgeSession } from './ws-server.js';

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
        | 'invalid_points';
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
}

interface CaptchaAssistIncident extends CaptchaAssistIncidentView {}

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 60;
const DEFAULT_INCIDENT_TTL_MS = 30 * 60_000;

export class CaptchaAssistService {
  private readonly incidents = new Map<string, CaptchaAssistIncident>();
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  private readonly tokenTtlSeconds: number;
  private readonly incidentTtlMs: number;

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
    incident.snapshot = payload;
    incident.kind = payload.kind;
    incident.url = payload.url ?? incident.url;
    incident.overlay = payload.overlay ?? incident.overlay;
    incident.accountId = payload.accountId ?? incident.accountId;
    incident.updatedAt = this.clock();
    incident.status = 'ready';
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
  ): Promise<CaptchaAssistDispatchResult> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return { ok: false, reason: 'not_found' };
    if (this.markExpiredIfNeeded(incident)) return { ok: false, reason: 'expired', incident };
    const now = this.clock();
    const sent = this.deps.pusher.pushToEdges(
      makeEnvelope('captcha.assist.capture', `captcha-assist-capture-${incidentId}-${now}`, now, {
        incidentId,
        reason,
        requestedAt: now,
        maxImageWidth: 1600,
        maxImageHeight: 1600,
        quality: 75,
      }),
      incident.edgeId,
    );
    incident.status = sent > 0 ? 'capture_pending' : 'detected';
    incident.updatedAt = now;
    incident.lastDispatch = { type: 'capture', requestedAt: now, sent, actor };
    if (sent <= 0) return { ok: false, reason: 'edge_offline', incident };
    return { ok: true, sent, incident };
  }

  async submitClick(input: {
    incidentId: string;
    snapshotId: string;
    points: CaptchaAssistClickPointPayload[];
    actor: string;
    settleMs?: number;
  }): Promise<CaptchaAssistDispatchResult> {
    const incident = this.incidents.get(input.incidentId);
    if (!incident) return { ok: false, reason: 'not_found' };
    if (this.markExpiredIfNeeded(incident)) return { ok: false, reason: 'expired', incident };
    if (!incident.snapshot) return { ok: false, reason: 'snapshot_required', incident };
    if (incident.snapshot.snapshotId !== input.snapshotId) {
      return { ok: false, reason: 'snapshot_mismatch', incident };
    }
    if (!isValidPointList(input.points)) {
      return { ok: false, reason: 'invalid_points', incident };
    }

    const now = this.clock();
    const payload: CaptchaAssistClickPayload = {
      incidentId: input.incidentId,
      snapshotId: input.snapshotId,
      points: input.points.map((p) => ({ x: p.x, y: p.y, ...(p.label ? { label: p.label } : {}) })),
      requestedAt: now,
      ...(typeof input.settleMs === 'number' && Number.isFinite(input.settleMs) ? { settleMs: input.settleMs } : {}),
    };
    const sent = this.deps.pusher.pushToEdges(
      makeEnvelope('captcha.assist.click', `captcha-assist-click-${input.incidentId}-${now}`, now, payload),
      incident.edgeId,
    );
    incident.status = sent > 0 ? 'click_pending' : 'ready';
    incident.updatedAt = now;
    incident.lastDispatch = { type: 'click', requestedAt: now, sent, actor: input.actor };
    if (sent <= 0) return { ok: false, reason: 'edge_offline', incident };
    return { ok: true, sent, incident };
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

function isValidPointList(points: CaptchaAssistClickPointPayload[]): boolean {
  return (
    Array.isArray(points) &&
    points.length > 0 &&
    points.length <= 8 &&
    points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
  );
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
