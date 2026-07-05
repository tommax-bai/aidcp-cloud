import crypto from 'node:crypto';
import type { LlmBillingPriceSnapshotInput, LlmBillingPriceTarget } from './token-usage-store.js';

type FetchLike = typeof fetch;

export type BillingPriceRefreshSkipReason =
  | 'missing_credentials'
  | 'unsupported_provider'
  | 'no_local_usage'
  | 'no_billing_sample'
  | 'billing_api_error';

export interface BillingPriceRefreshSkip {
  provider: string;
  model: string;
  usageDay: string;
  reason: BillingPriceRefreshSkipReason;
}

export interface BillingPriceRefreshWritten {
  provider: string;
  model: string;
  usageDay: string;
  currency: string;
  pricingBasis: 'input_output_tokens' | 'total_tokens';
  source: string;
  sourcePeriod: string | null;
}

export interface BillingPriceRefreshResult {
  ok: true;
  checkedDays: string[];
  targetCount: number;
  written: number;
  prices: BillingPriceRefreshWritten[];
  skipped: BillingPriceRefreshSkip[];
  missingCredentials: string[];
}

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

export function createBillingPriceRefresh(options: BillingPriceRefreshOptions) {
  const runFetch = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? (() => Date.now());

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

        const creds = await loadBillingCredentials(provider, options.credentials, env);
        if (!creds) {
          missingCredentials.add(provider);
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
): Promise<BillingCredentialPair | null> {
  const aliases =
    provider === 'dashscope'
      ? {
          storeProvider: 'aliyun',
          idField: 'billing_access_key_id',
          secretField: 'billing_access_key_secret',
          idEnv: ['ALIYUN_BILLING_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID'],
          secretEnv: ['ALIYUN_BILLING_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET'],
        }
      : {
          storeProvider: 'volcengine',
          idField: 'billing_access_key_id',
          secretField: 'billing_access_key_secret',
          idEnv: ['VOLCENGINE_BILLING_ACCESS_KEY_ID', 'VOLC_ACCESSKEY', 'VOLCENGINE_ACCESS_KEY_ID'],
          secretEnv: ['VOLCENGINE_BILLING_ACCESS_KEY_SECRET', 'VOLC_SECRETKEY', 'VOLCENGINE_ACCESS_KEY_SECRET'],
        };
  const accessKeyId =
    (await store?.getSecretForRuntime(aliases.storeProvider, aliases.idField).catch(() => null)) ??
    firstEnv(env, aliases.idEnv);
  const accessKeySecret =
    (await store?.getSecretForRuntime(aliases.storeProvider, aliases.secretField).catch(() => null)) ??
    firstEnv(env, aliases.secretEnv);
  return accessKeyId && accessKeySecret ? { accessKeyId, accessKeySecret } : null;
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
  return text.includes(m);
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
      IsHideZeroCharge: 'true',
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
  const tokens = normalizeTokenUsage(
    firstNumber(obj, [
      'Usage',
      'UsageAmount',
      'BillableQuantity',
      'BillableAmount',
      'BillableQuantityValue',
      'Quantity',
      'ResourceAmount',
      'ActualUsage',
      'DeductedQuantity',
    ]),
    text,
  );
  const amount = firstNumber(obj, [
    'PretaxAmount',
    'PaymentAmount',
    'CashAmount',
    'AfterDiscountAmount',
    'PretaxGrossAmount',
    'PayableAmount',
    'DiscountBillAmount',
    'BillAmount',
    'OriginalBillAmount',
    'ExpenseAmount',
    'Cost',
    'Charge',
    'RealCost',
    'OriginalCost',
  ]);
  if (tokens == null || amount == null || tokens <= 0 || amount < 0) return null;
  return {
    provider,
    usageDay: day,
    currency: stringField(obj, ['Currency', 'currency']) ?? 'CNY',
    amount,
    tokens,
    kind: inferLineKind(text),
    text,
  };
}

function normalizeTokenUsage(value: number | null, text: string): number | null {
  if (value == null) return null;
  if (/\u767e\u4e07|million/i.test(text)) return value * 1_000_000;
  if (/\u4e07/i.test(text)) return value * 10_000;
  if (/\u5343|1k|k\s*token/i.test(text)) return value * 1000;
  return value;
}

function inferLineKind(text: string): BillingLine['kind'] {
  if (/completion|output|\u8f93\u51fa|\u751f\u6210/i.test(text)) return 'completion';
  if (/prompt|input|\u8f93\u5165|\u5165\u53c2/i.test(text)) return 'prompt';
  return 'total';
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = valueByKey(obj, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number(value.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
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
