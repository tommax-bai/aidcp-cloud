/**
 * attempt 原因串的人话化（change delegated-terminal-failure-reason）。
 *
 * 同一个 `reason: string` 字段里混装三种语域，且**无判别字段**：
 *  (a) 机器码 snake_case —— 执行器 / scheduler 产出（`needs_persona_setup`、`risk_status(warned)`…）；
 *  (b) 中文人话句 —— 部分产出点已经写好了（`已有一轮发帖编排在运行中，本次未触发（already_running）`…）；
 *  (c) 裸英文异常文本 —— 编排器抛出（`Pipeline aborted by <role>: <err>`、`Pipeline timed out after <ms>ms`）。
 *
 * 红线（spec「原因人话化必须只翻译已知码、未知码原样透传」）：**未命中白名单一律原样透传**。
 * 宁可让运营看见 `publish_needs_review` 这种生码，也绝不猜它的意思、绝不美化成一句听着像诊断、
 * 实则无证据支撑的话——那等于用好看的文案制造假确定性，比不说更坏。
 */

/** 卡片正文里单条原因的显示上限；超出即裁剪并保留原文可辨识片段。 */
const MAX_REASON_CHARS = 120;

/**
 * 精确码 → 人话。只收「含义确定、无参数」的码。
 *
 * 刻意不收的：`publish_<status>` / `candidate_terminal_<status>` 这类**阶段级**码走下方前缀分支，
 * 且只表述到「派发阶段」——它们背后的分步细节（定位失败 / 内容超长 / 配图全失败）在 DB 里就已经
 * 塌成一个状态枚举（`publish-log-store.updateStatus` 只写状态、`command-sequencer` 的 failedAt 从不落库），
 * 说得更细就是编造（spec「失败原因的精度不得超过已落库的证据」）。
 */
const EXACT: Record<string, string> = {
  needs_persona_setup: '该账号未配置人设，未生成稿件',
  account_required: '未能解析出唯一目标账号，未触发发帖',
  empty_body: '参照稿正文为空，未生成稿件',
  today_inspiration_unavailable: '今日无可用灵感稿源',
  candidate_record_missing: '稿件已生成但落库记录缺失',
  candidate_not_found_after_write: '写入后读不回稿件记录',
  candidate_missing_during_reconcile: '对账时稿件记录已丢失',
  candidate_account_or_platform_mismatch: '稿件的账号或平台与任务不一致',
  candidate_id_or_version_missing: '缺少稿件 id 或版本号',
  candidate_patch_missing: '缺少要改写的内容',
  curated_target_snapshot_missing: '精选目标快照缺失',
  duplicate_target: '同一目标已尝试过，未重复执行',
  duplicate_attempt_target: '同一目标已尝试过，未重复执行',
  submitted_result_unknown: '已提交但平台结果未确认，为防重复未自动重试',
};

/** 前缀式：保留原串里的参数（状态值 / 异常原文），只把码壳翻成人话。 */
const PREFIXES: { match: RegExp; render: (m: RegExpMatchArray) => string }[] = [
  { match: /^risk_status\((.+)\)$/, render: (m) => `账号风控状态为 ${m[1]}，暂不发帖` },
  { match: /^risk_denied\(status=(.+)\)$/, render: (m) => `风控拒绝本次发帖（状态 ${m[1]}）` },
  { match: /^executor_exception:(.*)$/s, render: (m) => `执行器异常：${m[1].trim() || '(无异常信息)'}` },
  // 阶段级：只说到「发布派发阶段」，绝不声称是哪一步（见文件头与 EXACT 的注释）。
  { match: /^candidate_terminal_(.+)$/, render: (m) => `稿件在发布派发阶段未成（终态 ${m[1]}）` },
  { match: /^candidate_approval_(.+)$/, render: (m) => `稿件授权发布时状态异常（${m[1]}）` },
  { match: /^candidate_write_(.+)$/, render: (m) => `稿件写入后状态不符预期（${m[1]}）` },
  { match: /^candidate_version_conflict\((.+)\)$/, render: (m) => `稿件已被改动，版本冲突（${m[1]}）` },
  { match: /^publish_(.+)$/, render: (m) => `发布编排未产出可发布结果（终态 ${m[1]}）` },
];

/** 裁到上限；从中间截断以同时保住头尾的可辨识信息（异常文本的尾巴常是真因）。 */
function clamp(text: string): string {
  if (text.length <= MAX_REASON_CHARS) return text;
  const head = Math.ceil((MAX_REASON_CHARS - 1) * 0.7);
  const tail = MAX_REASON_CHARS - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * 把一条 attempt 原因翻成可放进飞书卡的人话。
 *
 * 命中白名单 → 翻译；否则**原样透传**（中文句已经是人话，英文异常文本也如实照抄）。
 * 两种情况都会裁到显示上限。空串 / 全空白 → 返回空串，由调用方判定「无原因可取」。
 */
export function humanizeAttemptReason(reason: string): string {
  const raw = reason.trim();
  if (!raw) return '';
  // Object.hasOwn 而非裸下标：reason 是各产出点的**裸字符串**，`toString` / `constructor` / `__proto__`
  // 这类原型链键裸取会拿到 Function 并通过 truthy 判定，被当成翻译结果返回——而声明是 `Record<string,string>`，
  // typecheck 看不见（CLAUDE.md §2 点名的「字段两端都是裸 string，typecheck 抓不到」同类盲区）。
  // 后果不是文案难看，是调用方对它 .replace() 时抛错、终态收敛被打断。
  const exact = Object.hasOwn(EXACT, raw) ? EXACT[raw] : undefined;
  if (exact) return exact;
  for (const { match, render } of PREFIXES) {
    const m = raw.match(match);
    if (m) return clamp(render(m));
  }
  return clamp(raw);
}
