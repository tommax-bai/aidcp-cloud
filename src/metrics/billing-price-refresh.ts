import crypto from 'node:crypto';
import type { LlmBillingPriceSnapshotInput, LlmBillingPriceTarget } from './token-usage-store.js';
import type {
  BillingPriceRefreshResult,
  BillingPriceRefreshSkip,
  BillingPriceRefreshSkipReason,
  BillingPriceRefreshWritten,
} from '../kernel/billing-price-refresh-types.js';

type FetchLike = typeof fetch;

// 回执纯类型已抬入 kernel（src/kernel/billing-price-refresh-types.ts）：面板（api）只展示回执，
// 不该认识厂商账单读取与价快照落库。这里 import 回来 + 等值再导出，属主侧既有消费方一个字节不改。
// **止步于回执四型**：下面的 BillingPriceRefreshTokenUsage 传递依赖 content 写侧形状，抬进 kernel 会造反向边。
export type {
  BillingPriceRefreshSkipReason,
  BillingPriceRefreshSkip,
  BillingPriceRefreshWritten,
  BillingPriceRefreshResult,
};

export interface BillingPriceRefreshTokenUsage {
  billingPriceTargets(days: string[]): Promise<LlmBillingPriceTarget[]>;
  upsertBillingPrices(prices: LlmBillingPriceSnapshotInput[]): Promise<number>;
}

export interface BillingPriceRefreshCredentials {
  getSecretForRuntime(provider: string, field: string): Promise<string | null>;
}

export interface BillingPriceRefreshOptions {
  tokenUsage: BillingPriceRefreshTokenUsage;
  credentials?: BillingPriceRefreshCredentials;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  nowMs?: () => number;
  /** 库内凭据读失败时的告警出口。缺省 console —— **不是**可选到「不告警」，见 readStoredBillingCredential。 */
  logger?: Pick<Console, 'warn'>;
}

interface BillingCredentialPair {
  accessKeyId: string;
  accessKeySecret: string;
}

interface BillingLine {
  provider: 'dashscope' | 'volcengine';
  usageDay: string;
  currency: string;
  amount: number;
  tokens: number;
  kind: 'prompt' | 'completion' | 'total';
  text: string;
}

interface BillingQuantity {
  raw: number;
  tokens: number;
}

export function createBillingPriceRefresh(options: BillingPriceRefreshOptions) {
  const runFetch = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? (() => Date.now());
  const logger = options.logger ?? console;

  return {
    async refresh(): Promise<BillingPriceRefreshResult> {
      const checkedDays = recentBeijingDays(nowMs(), 2);
      const targets = await options.tokenUsage.billingPriceTargets(checkedDays);
      const skipped: BillingPriceRefreshSkip[] = [];
      const prices: BillingPriceRefreshWritten[] = [];
      const snapshots: LlmBillingPriceSnapshotInput[] = [];
      const missingCredentials = new Set<string>();

      if (targets.length === 0) {
        return {
          ok: true,
          checkedDays,
          targetCount: 0,
          written: 0,
          prices: [],
          skipped: [{ provider: 'all', model: '*', usageDay: checkedDays.join(','), reason: 'no_local_usage' }],
          missingCredentials: [],
        };
      }

      const targetsByProvider = groupBy(targets, (t) => t.provider);
      const linesByProviderDay = new Map<string, BillingLine[]>();

      for (const provider of Object.keys(targetsByProvider)) {
        if (provider !== 'dashscope' && provider !== 'volcengine') {
          for (const target of targetsByProvider[provider]) {
            skipped.push(skipOf(target, 'unsupported_provider'));
          }
          continue;
        }

        const creds = await loadBillingCredentials(provider, options.credentials, env, logger);
        if (!creds) {
          missingCredentials.add(provider === 'dashscope' ? 'aliyun' : provider);
          for (const target of targetsByProvider[provider]) skipped.push(skipOf(target, 'missing_credentials'));
          continue;
        }

        for (const day of checkedDays) {
          try {
            const lines =
              provider === 'dashscope'
                ? await fetchAliyunBillingLines(day, creds, runFetch)
                : await fetchVolcengineBillingLines(day, creds, runFetch);
            linesByProviderDay.set(`${provider}|${day}`, lines);
          } catch {
            for (const target of targetsByProvider[provider].filter((t) => t.usageDay === day)) {
              skipped.push(skipOf(target, 'billing_api_error'));
            }
          }
        }
      }

      for (const target of targets) {
        if (skipped.some((s) => sameTarget(s, target))) continue;
        const lines = linesByProviderDay.get(`${target.provider}|${target.usageDay}`) ?? [];
        const snapshot = deriveSnapshot(target, lines, nowMs());
        if (!snapshot) {
          skipped.push(skipOf(target, 'no_billing_sample'));
          continue;
        }
        snapshots.push(snapshot);
        prices.push({
          provider: snapshot.provider,
          model: snapshot.model,
          usageDay: snapshot.usageDay,
          currency: snapshot.currency ?? 'CNY',
          pricingBasis:
            snapshot.promptCostPer1k != null && snapshot.completionCostPer1k != null
              ? 'input_output_tokens'
              : 'total_tokens',
          source: snapshot.source,
          sourcePeriod: snapshot.sourcePeriod ?? null,
        });
      }

      const written = snapshots.length > 0 ? await options.tokenUsage.upsertBillingPrices(snapshots) : 0;
      return {
        ok: true,
        checkedDays,
        targetCount: targets.length,
        written,
        prices,
        skipped,
        missingCredentials: Array.from(missingCredentials).sort(),
      };
    },
  };
}

function skipOf(target: LlmBillingPriceTarget, reason: BillingPriceRefreshSkipReason): BillingPriceRefreshSkip {
  return { provider: target.provider, model: target.model, usageDay: target.usageDay, reason };
}

function sameTarget(skip: BillingPriceRefreshSkip, target: LlmBillingPriceTarget): boolean {
  return skip.provider === target.provider && skip.model === target.model && skip.usageDay === target.usageDay;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyOf(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

function recentBeijingDays(nowMs: number, count: number): string[] {
  const shifted = new Date(nowMs + 8 * 3600 * 1000);
  const baseUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const days: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    days.push(formatUtcDay(new Date(baseUtc - i * 24 * 3600 * 1000)));
  }
  return days;
}

function formatUtcDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

async function loadBillingCredentials(
  provider: string,
  store: BillingPriceRefreshCredentials | undefined,
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, 'warn'>,
): Promise<BillingCredentialPair | null> {
  const aliases =
    provider === 'dashscope'
      ? {
          storeProvider: 'aliyun',
          idField: 'billing_access_key_id',
          secretField: 'billing_access_key_secret',
          genericIdField: 'access_key_id',
          genericSecretField: 'access_key_secret',
          idEnv: ['ALIYUN_BILLING_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID'],
          secretEnv: ['ALIYUN_BILLING_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET'],
        }
      : {
          storeProvider: 'volcengine',
          idField: 'billing_access_key_id',
          secretField: 'billing_access_key_secret',
          genericIdField: 'access_key_id',
          genericSecretField: 'access_key_secret',
          idEnv: ['VOLCENGINE_BILLING_ACCESS_KEY_ID', 'VOLC_ACCESSKEY', 'VOLCENGINE_ACCESS_KEY_ID'],
          secretEnv: ['VOLCENGINE_BILLING_ACCESS_KEY_SECRET', 'VOLC_SECRETKEY', 'VOLCENGINE_ACCESS_KEY_SECRET'],
        };
  const accessKeyId =
    (await readStoredBillingCredential(store, aliases.storeProvider, aliases.idField, logger)) ??
    (await readStoredBillingCredential(store, aliases.storeProvider, aliases.genericIdField, logger)) ??
    firstEnv(env, aliases.idEnv);
  const accessKeySecret =
    (await readStoredBillingCredential(store, aliases.storeProvider, aliases.secretField, logger)) ??
    (await readStoredBillingCredential(store, aliases.storeProvider, aliases.genericSecretField, logger)) ??
    firstEnv(env, aliases.secretEnv);
  return accessKeyId && accessKeySecret ? { accessKeyId, accessKeySecret } : null;
}

/**
 * 库内凭据窄读。**「读失败」与「库里没配」必须分得开。**
 *
 * 两者都返回 `null` 并回落 env（回落本身保留：属主域抖一下就停掉计价刷新是过度反应），
 * 但读失败 MUST 留下一行告警 —— 否则拆进程后属主侧路由没注册这类问题会长期表现为
 * 「本来就没配」，链路悄悄不工作且零信号。跨进程口的文件头明写「失败原样抛」，
 * 这里是唯一允许接住的地方，代价就是这行日志。
 */
async function readStoredBillingCredential(
  store: BillingPriceRefreshCredentials | undefined,
  provider: string,
  field: string,
  logger: Pick<Console, 'warn'>,
): Promise<string | null> {
  if (!store) return null;
  try {
    return (await store.getSecretForRuntime(provider, field)) ?? null;
  } catch (error) {
    logger.warn(
      `[billing-price] 库内凭据读失败（provider=${provider} field=${field}）⇒ 本次回落 env；` +
        `这不代表库里没配：${(error as Error).message}`,
    );
    return null;
  }
}

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function deriveSnapshot(
  target: LlmBillingPriceTarget,
  lines: BillingLine[],
  sourceSyncedAtMs: number,
): LlmBillingPriceSnapshotInput | null {
  const matching = lines.filter((line) => lineMatchesModel(line, target.model));
  if (matching.length === 0) return null;

  const prompt = sumKind(matching, 'prompt');
  const completion = sumKind(matching, 'completion');
  const total = sumAll(matching);
  const currency = matching.find((line) => line.currency)?.currency ?? 'CNY';
  const source = target.provider === 'dashscope' ? 'billing:aliyun:DescribeInstanceBill' : 'billing:volcengine:ListBillDetail';

  if (prompt.tokens > 0 && completion.tokens > 0) {
    return {
      provider: target.provider,
      model: target.model,
      usageDay: target.usageDay,
      currency,
      promptCostPer1k: (prompt.amount / prompt.tokens) * 1000,
      completionCostPer1k: (completion.amount / completion.tokens) * 1000,
      source,
      sourcePeriod: target.usageDay,
      sourceSyncedAtMs,
    };
  }
  if (total.tokens > 0) {
    return {
      provider: target.provider,
      model: target.model,
      usageDay: target.usageDay,
      currency,
      totalCostPer1k: (total.amount / total.tokens) * 1000,
      source,
      sourcePeriod: target.usageDay,
      sourceSyncedAtMs,
    };
  }
  return null;
}

function sumKind(lines: BillingLine[], kind: BillingLine['kind']): { amount: number; tokens: number } {
  return sumAll(lines.filter((line) => line.kind === kind));
}

function sumAll(lines: BillingLine[]): { amount: number; tokens: number } {
  return lines.reduce(
    (acc, line) => ({ amount: acc.amount + line.amount, tokens: acc.tokens + line.tokens }),
    { amount: 0, tokens: 0 },
  );
}

function lineMatchesModel(line: BillingLine, model: string): boolean {
  const text = line.text.toLowerCase();
  const m = model.toLowerCase();
  if (text.includes(m)) return true;
  if (line.provider !== 'volcengine') return false;

  const normalizedText = normalizeModelForBillingMatch(text);
  return volcengineModelAliases(model).some((alias) => normalizedText.includes(alias));
}

function volcengineModelAliases(model: string): string[] {
  const normalized = normalizeModelForBillingMatch(model);
  const aliases = new Set<string>();
  addSpecificVolcengineAlias(aliases, normalized);

  // Runtime Volcengine model ids often carry release-date suffixes that billing omits.
  addSpecificVolcengineAlias(aliases, normalized.replace(/-\d{6,8}$/, ''));

  return Array.from(aliases);
}

function addSpecificVolcengineAlias(aliases: Set<string>, value: string): void {
  if (!isSpecificVolcengineAlias(value)) return;
  aliases.add(value);
}

function isSpecificVolcengineAlias(value: string): boolean {
  const parts = value.split('-').filter(Boolean);
  return value.length >= 12 && parts.length >= 3 && value.startsWith('doubao-');
}

function normalizeModelForBillingMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchAliyunBillingLines(
  day: string,
  creds: BillingCredentialPair,
  runFetch: FetchLike,
): Promise<BillingLine[]> {
  const endpoint = 'https://business.aliyuncs.com/';
  const pageSize = 300;
  const lines: BillingLine[] = [];
  let nextToken: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const params: Record<string, string> = {
      Action: 'DescribeInstanceBill',
      Version: '2017-12-14',
      Format: 'JSON',
      AccessKeyId: creds.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      BillingCycle: day.slice(0, 7),
      BillingDate: day,
      Granularity: 'DAILY',
      IsBillingItem: 'true',
      IsHideZeroCharge: 'false',
      MaxResults: String(pageSize),
    };
    if (nextToken) params.NextToken = nextToken;
    params.Signature = aliyunSign('GET', params, creds.accessKeySecret);
    const url = `${endpoint}?${toQuery(params)}`;
    const resp = await runFetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error(`aliyun_billing_http_${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    const pageLines = extractAliyunLines(day, data);
    lines.push(...pageLines);
    nextToken = stringValue(readPath(data, ['Data', 'NextToken']));
    if (!nextToken || pageLines.length === 0) break;
  }
  return lines;
}

function aliyunSign(method: string, params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'Signature')
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

function toQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function extractAliyunLines(day: string, data: unknown): BillingLine[] {
  const items = readPath(data, ['Data', 'Items']);
  const legacyItems = readPath(data, ['Data', 'Items', 'Item']);
  const rows = Array.isArray(items) ? items : Array.isArray(legacyItems) ? legacyItems : [];
  return rows.map((row) => normalizeBillingLine('dashscope', day, row)).filter((line): line is BillingLine => line !== null);
}

async function fetchVolcengineBillingLines(
  day: string,
  creds: BillingCredentialPair,
  runFetch: FetchLike,
): Promise<BillingLine[]> {
  const pageSize = 100;
  const lines: BillingLine[] = [];
  for (let offset = 0; offset < 2000; offset += pageSize) {
    const body = JSON.stringify({
      BillPeriod: day.slice(0, 7),
      BillDate: day,
      GroupPeriod: 2,
      Limit: pageSize,
      Offset: offset,
    });
    const resp = await volcFetch(
      'ListBillDetail',
      '2022-01-01',
      body,
      creds,
      runFetch,
    );
    const data = (await resp.json()) as Record<string, unknown>;
    const rows =
      objectArrayAtAny(data, [
        ['Result', 'List'],
        ['Result', 'Items'],
        ['Result', 'BillDetailList'],
        ['Result', 'BillDetails'],
        ['ResponseMetadata', 'Result', 'List'],
      ]) ??
      allObjectArrays(data)
        .sort((a, b) => b.length - a.length)
        .find((arr) => arr.some((x) => /bill|amount|usage|token|model|qwen|doubao|deepseek|ep-/i.test(JSON.stringify(x))));
    const pageRows = rows ?? [];
    lines.push(
      ...pageRows.map((row) => normalizeBillingLine('volcengine', day, row)).filter((line): line is BillingLine => line !== null),
    );
    if (pageRows.length < pageSize) break;
  }
  return lines;
}

async function volcFetch(
  action: string,
  version: string,
  body: string,
  creds: BillingCredentialPair,
  runFetch: FetchLike,
): Promise<Response> {
  const host = 'open.volcengineapi.com';
  const service = 'billing';
  const region = 'cn-north-1';
  const method = 'POST';
  const path = '/';
  const query = `Action=${action}&Version=${version}`;
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join('');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(Buffer.from(creds.accessKeySecret, 'utf8'), shortDate), region), service), 'request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await runFetch(`https://${host}/?${query}`, {
    method,
    headers: { ...headers, authorization },
    body,
  });
  if (!resp.ok) throw new Error(`volcengine_billing_http_${resp.status}`);
  return resp;
}

function hmac(key: Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeBillingLine(
  provider: BillingLine['provider'],
  day: string,
  row: unknown,
): BillingLine | null {
  if (!row || typeof row !== 'object') return null;
  const obj = row as Record<string, unknown>;
  const text = JSON.stringify(obj);
  const quantity = billingTokenQuantity(obj, text);
  const amount = billingLineAmount(obj, quantity);
  if (quantity == null || amount == null || quantity.tokens <= 0 || amount < 0) return null;
  return {
    provider,
    usageDay: day,
    currency: stringField(obj, ['Currency', 'currency']) ?? 'CNY',
    amount,
    tokens: quantity.tokens,
    kind: inferLineKind(text),
    text,
  };
}

function billingTokenQuantity(obj: Record<string, unknown>, text: string): BillingQuantity | null {
  const candidates = [
    {
      keys: ['Usage', 'UsageAmount', 'ActualUsage'],
      unitKeys: ['UsageUnit', 'Unit', 'PriceUnit'],
    },
    {
      keys: ['BillableQuantity', 'BillableAmount', 'BillableQuantityValue', 'Quantity', 'ResourceAmount', 'DeductedQuantity'],
      unitKeys: ['Unit', 'UsageUnit', 'PriceUnit'],
    },
    {
      keys: ['Count', 'DeductionCount'],
      unitKeys: ['Unit', 'PriceUnit'],
    },
  ];

  for (const candidate of candidates) {
    const unitText = candidate.unitKeys.map((key) => stringField(obj, [key])).filter(Boolean).join(' ');
    for (const key of candidate.keys) {
      const raw = numberField(obj, key);
      const tokens = normalizeTokenUsage(raw, unitText || text);
      if (tokens != null) return { raw: raw as number, tokens };
    }
  }

  return null;
}

function billingLineAmount(obj: Record<string, unknown>, quantity: BillingQuantity | null): number | null {
  const netAmount = firstPositiveNumber(obj, [
    'PretaxAmount',
    'PaymentAmount',
    'CashAmount',
    'AfterDiscountAmount',
    'PayableAmount',
    'ExpenseAmount',
    'Cost',
    'Charge',
    'RealCost',
  ]);
  if (netAmount != null) return netAmount;

  const grossAmount = firstPositiveNumber(obj, [
    'PretaxGrossAmount',
    'BillAmount',
    'OriginalBillAmount',
    'OriginalCost',
  ]);
  if (grossAmount != null) return grossAmount;

  const derivedAmount = deriveAmountFromUnitPrice(obj, quantity);
  if (derivedAmount != null && derivedAmount > 0) return derivedAmount;

  return null;
}

function deriveAmountFromUnitPrice(obj: Record<string, unknown>, quantity: BillingQuantity | null): number | null {
  if (!quantity || quantity.tokens <= 0) return null;
  const price = firstNumber(obj, ['Price', 'DiscountBizUnitPrice', 'MarketPrice']);
  if (price == null || price < 0) return null;
  const priceUnitText = ['PriceUnit', 'Unit', 'UsageUnit'].map((key) => stringField(obj, [key])).filter(Boolean).join(' ');
  const priceUnitTokens = tokenUnitMultiplier(priceUnitText);
  if (priceUnitTokens == null || priceUnitTokens <= 0) return null;
  return price * (quantity.tokens / priceUnitTokens);
}

function normalizeTokenUsage(value: number | null, unitText: string): number | null {
  if (value == null) return null;
  const multiplier = tokenUnitMultiplier(unitText);
  return multiplier == null ? null : value * multiplier;
}

function tokenUnitMultiplier(unitText: string): number | null {
  if (/\u767e\u4e07|million/i.test(unitText)) return 1_000_000;
  if (/\u4e07/i.test(unitText)) return 10_000;
  if (/\u5343|1k|k\s*token/i.test(unitText)) return 1000;
  if (/token/i.test(unitText)) return 1;
  return null;
}

function inferLineKind(text: string): BillingLine['kind'] {
  if (/completion|output|\u8f93\u51fa|\u751f\u6210/i.test(text)) return 'completion';
  if (/prompt|input|\u8f93\u5165|\u5165\u53c2/i.test(text)) return 'prompt';
  return 'total';
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = numberField(obj, key);
    if (n != null) return n;
  }
  return null;
}

function firstPositiveNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = numberField(obj, key);
    if (n != null && n > 0) return n;
  }
  return null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = valueByKey(obj, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (!normalized || normalized === '-') return null;
    const n = Number(normalized);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = valueByKey(obj, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function valueByKey(obj: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const lowerKey = key.toLowerCase();
  const foundKey = Object.keys(obj).find((k) => k.toLowerCase() === lowerKey);
  return foundKey ? obj[foundKey] : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function allObjectArrays(value: unknown): Array<Record<string, unknown>[]> {
  const out: Array<Record<string, unknown>[]> = [];
  visit(value);
  return out;

  function visit(v: unknown): void {
    if (Array.isArray(v)) {
      if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        out.push(v as Record<string, unknown>[]);
      }
      for (const item of v) visit(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const child of Object.values(v as Record<string, unknown>)) visit(child);
    }
  }
}

function objectArrayAtAny(value: unknown, paths: string[][]): Record<string, unknown>[] | null {
  for (const path of paths) {
    const arr = readPath(value, path);
    if (Array.isArray(arr) && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      return arr as Record<string, unknown>[];
    }
  }
  return null;
}
