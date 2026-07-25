/**
 * 面板侧「验证码人工协助」窄内部接口（§4.6.4）。
 *
 * 为什么在 api 仓里重抄形状：`PanelDeps.captchaAssist` 是**运行时真调用**（面板五个端点全靠它），
 * 而实现方 `src/comm/captcha-assist.ts` 与其内嵌的边云协议载荷（`src/comm/protocol.ts`）都归
 * aidcp-automation 独占（§10.9：protocol.ts MUST NOT 进 kernel、MUST 在各仓 contracts/ 内重新声明）。
 * 因此这里只声明**面板真正读写的那部分形状**，装配由组合根按结构类型对接；形状漂移会在
 * `src/server.ts` 的注入点当场编译红，不会静默降级成「端点全绿但没人接」。
 */

/* ---------------------------------------------------------------- 内嵌协议载荷（本地重抄） */

/** 阻断遮罩的单个 DOM 特征（对应边云协议 BlockingOverlayDomFeaturePayload）。 */
export interface CaptchaAssistOverlayDomFeature {
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  ariaModal?: string;
  selector?: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  style?: { position?: string; zIndex?: string; opacity?: string };
  hasIframe?: boolean;
  iframeSrcs?: string[];
  hasClose?: boolean;
  matchReasons?: string[];
}

/** 首次阻断现场快照（对应边云协议 BlockingOverlaySnapshotPayload）。 */
export interface CaptchaAssistOverlaySnapshot {
  kind: 'captcha' | 'unknown';
  firstDetectedUrl?: string;
  capturedAt: number;
  text?: string;
  dom?: CaptchaAssistOverlayDomFeature;
  candidates: CaptchaAssistOverlayDomFeature[];
}

export interface CaptchaAssistViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface CaptchaAssistCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptchaAssistImage {
  mime: 'image/png' | 'image/jpeg';
  /** Base64 图像字节；短命、MUST NOT 落日志。 */
  data: string;
  width: number;
  height: number;
}

/** 供控制台展示的挑战帧（对应边云协议 CaptchaAssistSnapshotPayload）。 */
export interface CaptchaAssistSnapshot {
  incidentId: string;
  edgeId?: string;
  accountId?: string;
  snapshotId: string;
  capturedAt: number;
  expiresAt?: number;
  kind: 'captcha' | 'unknown';
  url?: string;
  viewport: CaptchaAssistViewport;
  crop: CaptchaAssistCrop;
  image: CaptchaAssistImage;
  overlay?: CaptchaAssistOverlaySnapshot;
}

/** 运营鼠标轨迹采样点（对应边云协议 CaptchaAssistTrajectorySamplePayload）。 */
export interface CaptchaAssistTrajectorySample {
  x: number;
  y: number;
  /** 相对首帧的毫秒偏移（单调不减）。 */
  t: number;
}

/** 运营真实鼠标轨迹（对应边云协议 CaptchaAssistTrajectoryPayload）。落点仍以 points 为准。 */
export interface CaptchaAssistTrajectory {
  v: 1;
  samples: CaptchaAssistTrajectorySample[];
  /** 对每个 points[i]，其被按下时所处的采样下标；length === points.length。 */
  clicks: number[];
}

/** 键入取证的焦点分级（对应边云协议 CaptchaAssistFocusTier）。 */
export type CaptchaAssistFocusTier = 'editable' | 'opaque' | 'none';

/** 键入取证（对应边云协议 CaptchaAssistTypeReportPayload）；**绝不含答案本身**。 */
export interface CaptchaAssistTypeReport {
  focus: CaptchaAssistFocusTier;
  focusTag?: string;
  cleared?: 'verified' | 'attempted';
  /** 实际派发出去的字符数；如实回报，绝不 `typed || text.length`。 */
  typed: number;
  verified?: 'match' | 'mismatch' | 'unverifiable';
  submitted: boolean;
}

/** 提交回执状态（对应边云协议 CaptchaAssistClickResultPayload['status']）。 */
export type CaptchaAssistClickResultStatus =
  | 'cleared'
  | 'still_blocked'
  | 'stale_snapshot'
  | 'not_blocked'
  | 'invalid_target'
  | 'no_target'
  | 'failed';

/* ---------------------------------------------------------------- 端口返回形状 */

export type CaptchaAssistIncidentStatus =
  | 'detected'
  | 'capture_pending'
  | 'ready'
  | 'click_pending'
  | 'cleared'
  | 'still_blocked'
  | 'failed'
  | 'expired';

/** 控制台读到的 incident 投影。 */
export interface CaptchaAssistIncidentView {
  incidentId: string;
  edgeId: string;
  accountId?: string;
  accountName?: string;
  machineLabel?: string;
  kind: 'captcha' | 'unknown';
  status: CaptchaAssistIncidentStatus;
  riskStatus?: string;
  detectedAt: number;
  updatedAt: number;
  expiresAt: number;
  url?: string;
  overlay?: CaptchaAssistOverlaySnapshot;
  snapshot?: CaptchaAssistSnapshot;
  lastResult?: {
    status: CaptchaAssistClickResultStatus;
    reason?: string;
    checkedAt: number;
    snapshotId?: string;
    /** 本次回执的输入模式：'click' 纯点击 / 'click_type' 含键入。 */
    inputMode?: 'click' | 'click_type';
    /** 键入取证；**绝不含答案本身**。 */
    typeReport?: CaptchaAssistTypeReport;
    /** 下发了 text 但回执 inputMode 不是 click_type ⇒ 老边缘忽略了键入（版本偏斜，MUST NOT 当成功）。 */
    textNotExecuted?: boolean;
  };
  lastDispatch?: {
    type: 'capture' | 'click';
    requestedAt: number;
    sent: number;
    actor: string;
    /** 本次下发的答案字符数：**只记多少个，never what**。 */
    textLen?: number;
  };
  /** 实时抓帧窗口截止时间；`now < liveUntil` 视为实时中。 */
  liveUntil?: number;
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
        | 'task_lease_failed'
        | 'invalid_text'
        | 'text_requires_single_focus_point'
        | 'edge_lacks_text_capability'
        | 'edge_capability_unknown';
      incident?: CaptchaAssistIncidentView;
    };

/* ---------------------------------------------------------------- 窄端口 */

export interface PanelCaptchaAssist {
  verifyToken(token: string | undefined): CaptchaAssistTokenVerifyResult;
  getIncident(incidentId: string): CaptchaAssistIncidentView | null;
  /** 运营轮询即在场信号（change captcha-assist-live-snapshot）：窗口到期则重新武装 edge 实时循环。 */
  noteViewerPresence(incidentId: string): void;
  requestCapture(
    incidentId: string,
    actor: string,
    reason?: 'initial' | 'refresh' | 'retry',
  ): Promise<CaptchaAssistDispatchResult>;
  submitClick(input: {
    incidentId: string;
    snapshotId: string;
    points: { x: number; y: number; label?: string }[];
    actor: string;
    settleMs?: number;
    /** 运营真实鼠标轨迹（change captcha-assist-trajectory-replay）；服务端 sanitize 不过则丢弃、保留 points。 */
    trajectory?: CaptchaAssistTrajectory;
    /**
     * 验证码答案明文（change captcha-assist-text-answer）。SENSITIVE：只透传给服务端装进 envelope，
     * MUST NOT 落日志/库/incident/URL（design D10）。键入与点击共用同一 scoped-token 授权面，无新增身份闸。
     */
    text?: string;
    /** 键入后的提交手势（change captcha-assist-text-answer）：只 'enter'。 */
    submit?: 'enter';
  }): Promise<CaptchaAssistDispatchResult>;
}
