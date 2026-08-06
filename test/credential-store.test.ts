import { test } from 'node:test';
import { ensureCapabilitySchema } from '@automation/schema/schema-capability.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { CredentialStore, CredentialKeyMissingError, maskSecret, PROVIDER_CREDENTIALS_SCHEMA_SQL } from '@api/config/credential-store.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(PROVIDER_CREDENTIALS_SCHEMA_SQL);

/** 内存假 pool：路由 provider_credentials 的建表 / SELECT / upsert。 */
function fakeCredPool() {
  const map = new Map<string, { ciphertext: string; masked_hint: string }>();
  const pool = {
    map,
    query: async (sql: string, params?: unknown[]) => {
      const __probe = schemaProbe(sql);
      if (__probe) return __probe;
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT masked_hint')) {
        const v = map.get(`${params![0]}:${params![1]}`);
        return { rows: v ? [{ masked_hint: v.masked_hint }] : [] };
      }
      if (sql.includes('SELECT ciphertext')) {
        const v = map.get(`${params![0]}:${params![1]}`);
        return { rows: v ? [{ ciphertext: v.ciphertext }] : [] };
      }
      if (sql.includes('INSERT INTO provider_credentials')) {
        const [p, f, ct, mask] = params as string[];
        map.set(`${p}:${f}`, { ciphertext: ct, masked_hint: mask });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

const KEY = crypto.randomBytes(32).toString('base64');

test('maskSecret：头4****尾4，过短全掩，绝不露中段', () => {
  assert.equal(maskSecret('sk-1234567890abcd'), 'sk-1****abcd');
  assert.equal(maskSecret('short'), '****');
  assert.equal(maskSecret('12345678'), '****');
});

test('加密往返：setSecret 落库密文 → getSecretForRuntime 解回原文', async () => {
  const pool = fakeCredPool();
  const store = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema, pool: pool as unknown as pg.Pool, masterKeyRaw: KEY });
  await store.init();
  assert.equal(store.canEdit(), true);

  const secret = 'sk-supersecret-APIKEY-0001';
  const { maskedHint } = await store.setSecret('dashscope', 'dashscope_api_key', secret, 'admin');
  assert.equal(maskedHint, 'sk-s****0001');

  // 库里存的是密文，绝不含明文
  const stored = pool.map.get('dashscope:dashscope_api_key')!;
  assert.ok(!stored.ciphertext.includes(secret));
  assert.equal(stored.masked_hint, 'sk-s****0001');

  // 解密回原文
  const back = await store.getSecretForRuntime('dashscope', 'dashscope_api_key');
  assert.equal(back, secret);
});

test('每次加密 iv 随机 → 同明文密文不同', async () => {
  const pool = fakeCredPool();
  const store = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema, pool: pool as unknown as pg.Pool, masterKeyRaw: KEY });
  await store.init();
  await store.setSecret('dashscope', 'dashscope_api_key', 'same-value-xyz', 'a');
  const c1 = pool.map.get('dashscope:dashscope_api_key')!.ciphertext;
  await store.setSecret('dashscope', 'dashscope_api_key', 'same-value-xyz', 'a');
  const c2 = pool.map.get('dashscope:dashscope_api_key')!.ciphertext;
  assert.notEqual(c1, c2);
});

test('密文被篡改 → 解密失败当未配置（返回 null，绝不崩）', async () => {
  const pool = fakeCredPool();
  const store = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema, pool: pool as unknown as pg.Pool, masterKeyRaw: KEY });
  await store.init();
  await store.setSecret('dashscope', 'dashscope_api_key', 'tamper-me-please', 'a');
  // 翻转密文末位
  const row = pool.map.get('dashscope:dashscope_api_key')!;
  const buf = Buffer.from(row.ciphertext, 'base64');
  buf[buf.length - 1] ^= 0xff;
  row.ciphertext = buf.toString('base64');
  const back = await store.getSecretForRuntime('dashscope', 'dashscope_api_key');
  assert.equal(back, null);
});

test('主密钥缺失：canEdit=false、setSecret 抛 CredentialKeyMissingError、绝不明文落库', async () => {
  const pool = fakeCredPool();
  const store = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema, pool: pool as unknown as pg.Pool, masterKeyRaw: '' });
  await store.init();
  assert.equal(store.canEdit(), false);
  await assert.rejects(
    () => store.setSecret('dashscope', 'dashscope_api_key', 'plaintext', 'a'),
    CredentialKeyMissingError,
  );
  assert.equal(pool.map.size, 0); // 什么都没落库
});

test('主密钥长度不对（非 32 字节）视为缺失', async () => {
  const pool = fakeCredPool();
  const store = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: pool as unknown as pg.Pool,
    masterKeyRaw: Buffer.from('too-short').toString('base64'),
  });
  assert.equal(store.canEdit(), false);
});
