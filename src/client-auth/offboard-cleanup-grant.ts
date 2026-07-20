import crypto from 'node:crypto';

const HEADER = { alg: 'HS256', typ: 'AIDCP-OFFBOARD-CLEANUP' } as const;
export const OFFBOARD_CLEANUP_GRANT_TTL_SECONDS = 10 * 60;

export interface OffboardCleanupGrantClaims {
  purpose: 'interaction_offboard_cleanup';
  offboardId: string;
  envKey: string;
  accountId: string;
  edgeId: string;
  userId: string;
  jti: string;
  iat: number;
  exp: number;
}

export type VerifyOffboardCleanupGrantResult =
  | { ok: true; claims: OffboardCleanupGrantClaims }
  | { ok: false; reason: 'malformed' | 'bad_alg' | 'bad_signature' | 'expired' | 'wrong_purpose' };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function hashOffboardCleanupGrantJti(jti: string): string {
  return crypto.createHash('sha256').update(jti, 'utf8').digest('hex');
}

export function issueOffboardCleanupGrant(
  input: Pick<OffboardCleanupGrantClaims, 'offboardId' | 'envKey' | 'accountId' | 'edgeId' | 'userId'>,
  secret: string,
  ttlSeconds = OFFBOARD_CLEANUP_GRANT_TTL_SECONDS,
  nowMs = Date.now(),
): { token: string; claims: OffboardCleanupGrantClaims } {
  const iat = Math.floor(nowMs / 1000);
  const claims: OffboardCleanupGrantClaims = {
    purpose: 'interaction_offboard_cleanup',
    ...input,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + ttlSeconds,
  };
  const signingInput = `${encode(HEADER)}.${encode(claims)}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, claims };
}

export function verifyOffboardCleanupGrant(
  token: string,
  secret: string,
  nowMs = Date.now(),
): VerifyOffboardCleanupGrantResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerPart, claimsPart, signaturePart] = parts;
  let header: { alg?: unknown; typ?: unknown };
  let claims: OffboardCleanupGrantClaims;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')) as OffboardCleanupGrantClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'HS256' || header.typ !== HEADER.typ) return { ok: false, reason: 'bad_alg' };
  const expected = crypto.createHmac('sha256', secret).update(`${headerPart}.${claimsPart}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signaturePart, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (claims.purpose !== 'interaction_offboard_cleanup') return { ok: false, reason: 'wrong_purpose' };
  if (![claims.offboardId, claims.envKey, claims.accountId, claims.edgeId, claims.userId, claims.jti]
    .every((value) => typeof value === 'string' && value.length > 0)
      || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.floor(nowMs / 1000) >= claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
