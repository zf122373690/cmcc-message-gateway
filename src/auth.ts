// 后台账号体系：账号/密码登录 + 会话 Cookie（存 KV）。
// 密码用 Web Crypto SHA-256(salt:password) 存储，会话令牌随机生成并带过期时间。

import type { Bindings } from "./env.js";
import { KV_ADMIN } from "./config.js";

export interface AdminRecord {
  user: string;
  salt: string;
  passHash: string;
  forceReset?: boolean;
}

export interface SessionRecord {
  user: string;
  exp: number;
}

const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(
  password: string,
  salt: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** 首次启动时初始化管理员账号：优先用环境变量 ADMIN_USER/ADMIN_PASS，否则默认 admin/admin123 并强制改密 */
export async function ensureAdmin(env: Bindings): Promise<AdminRecord> {
  const kv = env.CONFIG;
  if (!kv) throw new Error("CONFIG KV 未绑定");
  const existing = (await kv.get(KV_ADMIN, "json")) as AdminRecord | null;
  if (existing?.user && existing?.passHash) return existing;

  const user = env.ADMIN_USER?.trim() || "admin";
  const pw = env.ADMIN_PASS?.trim() || "admin123";
  const salt = randomHex(8);
  const record: AdminRecord = {
    user,
    salt,
    passHash: await hashPassword(pw, salt),
    forceReset: !env.ADMIN_PASS,
  };
  await kv.put(KV_ADMIN, JSON.stringify(record));
  return record;
}

export async function verifyPassword(
  record: AdminRecord,
  password: string,
): Promise<boolean> {
  const hash = await hashPassword(password, record.salt);
  if (hash.length !== record.passHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ record.passHash.charCodeAt(i);
  }
  return diff === 0;
}

export async function updatePassword(
  env: Bindings,
  user: string,
  newPassword: string,
): Promise<void> {
  const kv = env.CONFIG;
  if (!kv) throw new Error("CONFIG KV 未绑定");
  const salt = randomHex(8);
  const record: AdminRecord = {
    user,
    salt,
    passHash: await hashPassword(newPassword, salt),
    forceReset: false,
  };
  await kv.put(KV_ADMIN, JSON.stringify(record));
}

export async function createSession(
  env: Bindings,
  user: string,
): Promise<string> {
  const kv = env.CONFIG;
  if (!kv) throw new Error("CONFIG KV 未绑定");
  const token = randomHex(24);
  const record: SessionRecord = { user, exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
  await kv.put(`session:${token}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function readSession(
  env: Bindings,
  token: string | undefined,
): Promise<SessionRecord | null> {
  if (!token) return null;
  const kv = env.CONFIG;
  if (!kv) return null;
  const raw = await kv.get(`session:${token}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as SessionRecord;
    if (rec.exp && rec.exp < Date.now()) {
      await kv.delete(`session:${token}`);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export async function destroySession(
  env: Bindings,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  const kv = env.CONFIG;
  if (!kv) return;
  await kv.delete(`session:${token}`);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export const SESSION_COOKIE = "cmcc_sid";
export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;
