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

// 会话采用「签名 Cookie」而非 KV 存储：
// 登录后把 `user.exp` 用 HMAC-SHA256 签名写入 Cookie，后端本地验签即可，
// 彻底规避 Cloudflare KV 写入后读取的最终一致性延迟（否则紧邻请求常读不到 session 而 401）。

const DEFAULT_SESSION_SECRET = "cmcc-gw-session-v1-fixed";

function getSessionSecret(env: Bindings): string {
  return env.SESSION_SECRET?.trim() || DEFAULT_SESSION_SECRET;
}

function encBuf(s: string): ArrayBuffer {
  const u = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encBuf(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encBuf(data));
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createSession(
  env: Bindings,
  user: string,
): Promise<string> {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${user}.${exp}`;
  const sig = await hmacHex(getSessionSecret(env), payload);
  return `${payload}.${sig}`;
}

export async function readSession(
  env: Bindings,
  token: string | undefined,
): Promise<SessionRecord | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [user, expStr, sig] = parts;
  const expected = await hmacHex(getSessionSecret(env), `${user}.${expStr}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (diff !== 0) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { user, exp };
}

export async function destroySession(): Promise<void> {
  // 会话为签名 Cookie，退出时由客户端清除 Cookie，无需服务端删除
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
