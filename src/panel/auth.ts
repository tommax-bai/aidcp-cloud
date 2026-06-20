/**
 * 面板登录凭据：从环境变量内置一组用户，登录时定时安全比对。
 *
 * MVP：凭据以明文存于 .env（`AIDCP_PANEL_USERS="alice:pw1,bob:pw2"`），适配 1-5 人内部工具。
 * 生产可升级为 hash 存储（YAGNI，留干净扩展缝）。比对走定长 HMAC + timingSafeEqual，
 * 规避用户名/密码长度与计时泄漏；遍历全部用户不短路，避免泄漏"哪个用户存在"。
 */

import crypto from 'node:crypto';

export interface PanelUser {
  username: string;
  password: string;
}

/** 解析 `user1:pass1,user2:pass2` 形式的 env 凭据。密码内允许出现冒号（仅按首个冒号切分）。 */
export function parsePanelUsers(raw: string | undefined): PanelUser[] {
  if (!raw) return [];
  const users: PanelUser[] = [];
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue; // 无冒号或冒号在首位（空用户名）→ 跳过
    const username = trimmed.slice(0, idx).trim();
    const password = trimmed.slice(idx + 1); // 密码保留原样（不 trim，允许含空格）
    if (!username || !password) continue;
    users.push({ username, password });
  }
  return users;
}

/** 定长安全比较：对两串各取随机 key 的 HMAC 再 timingSafeEqual，规避长度与计时泄漏。 */
function constantTimeEqual(a: string, b: string): boolean {
  const key = crypto.randomBytes(32);
  const ha = crypto.createHmac('sha256', key).update(a, 'utf8').digest();
  const hb = crypto.createHmac('sha256', key).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 校验用户名+密码。遍历全部用户、不短路，避免计时侧信道泄漏用户存在性。 */
export function verifyCredentials(users: PanelUser[], username: string, password: string): boolean {
  let ok = false;
  for (const u of users) {
    if (constantTimeEqual(u.username, username) && constantTimeEqual(u.password, password)) {
      ok = true;
    }
  }
  return ok;
}

/** 从 Authorization 头取 Bearer token。 */
export function parseBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : undefined;
}
