/**
 * 极小 HS256 JWT（node:crypto 自实现，不引入第三方库）。
 *
 * 内部工具、短 TTL、自签自验，故不需要完整 JWT 库。安全要点：
 * - 验签强制 alg=HS256，拒绝 alg=none / alg 混淆；
 * - HMAC 比较走 timingSafeEqual（定长摘要比较，规避计时泄漏）；
 * - 校验 exp 过期。
 */

import crypto from 'node:crypto';

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export interface JwtPayload {
  /** subject：登录用户名。 */
  sub: string;
  /** issued-at（秒）。 */
  iat: number;
  /** expiry（秒）。 */
  exp: number;
  /** JWT ID：令牌唯一标识，供撤销黑名单（change console-cloud-panel-hardening #26）。旧令牌可能无此字段（部署过渡兼容）。 */
  jti?: string;
}

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/** 用 HS256 签发一个短 TTL JWT。nowMs 可注入以便测试。 */
export function signJwt(
  claims: { sub: string },
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: JwtPayload = { sub: claims.sub, iat, exp: iat + ttlSeconds, jti: crypto.randomUUID() };
  const signingInput = `${base64urlJson(HEADER)}.${base64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

export type JwtVerifyResult =
  | { valid: true; payload: JwtPayload }
  | { valid: false; reason: 'malformed' | 'bad_alg' | 'bad_signature' | 'expired' };

/** 验签 + 校验 exp。强制 alg=HS256。nowMs 可注入以便测试。 */
export function verifyJwt(token: string, secret: string, nowMs: number = Date.now()): JwtVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [head, body, sig] = parts;

  let header: { alg?: unknown };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  // 强制 HS256：杜绝 alg=none 与非对称→对称的 alg 混淆攻击。
  if (header.alg !== 'HS256') return { valid: false, reason: 'bad_alg' };

  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || Math.floor(nowMs / 1000) >= payload.exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, payload };
}
