/**
 * 对外客户访问密钥（access key）的生成、哈希、校验（node:crypto，不引第三方）。
 *
 * 安全要点：
 *  - key 系统生成、高熵（256-bit），客户不可自选；只在创建/轮换响应回显一次，之后无接口读回。
 *  - 静态存储只落 scrypt 派生哈希 + 每客户随机盐（内存硬派生，DB 泄漏也难爆破）；绝不存明文。
 *  - 校验走 timingSafeEqual（定长摘要比较，规避计时泄漏），与 jwt.ts / panel/auth.ts 家族一致。
 *  - name 未命中登录时仍跑一次 decoyVerify，抹平「客户是否存在」的响应时延差，防枚举。
 *  - key 带 `ck_` 前缀，便于日志/审计正则脱敏（绝不记 key/token 明文）。
 */

import crypto from 'node:crypto';

const KEY_PREFIX = 'ck_';
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
/** 固定诱饵盐：name 未命中时对客户提交的 key 跑一遍等量 scrypt，抹平存在性时延。 */
const DECOY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

/** 生成一枚高熵访问密钥（256-bit，`ck_` 前缀）。 */
export function generateKey(): string {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** 派生某 key 的 scrypt 哈希 + 随机盐（均为 hex）。 */
export function hashKey(key: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(key, salt, SCRYPT_KEYLEN);
  return { hash: derived.toString('hex'), salt: salt.toString('hex') };
}

/** 定长安全校验 key 是否匹配给定 hash+salt。任何解析/长度异常 → false（诚实拒绝，绝不放行）。 */
export function verifyKey(key: string, hashHex: string, saltHex: string): boolean {
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(key, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** 诱饵校验：name 未命中时调用，跑一次等量 scrypt 再返回，抹平时延差。返回值无意义（恒 false 语义）。 */
export function decoyVerify(key: string): void {
  try {
    crypto.scryptSync(key ?? '', DECOY_SALT, SCRYPT_KEYLEN);
  } catch {
    /* 抹平时延即可，异常吞掉不影响「凭据错误」的统一返回 */
  }
}
