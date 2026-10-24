// 后台管理路由：登录、设置读写、一键对接、改密、状态。由 app.ts 挂载。

import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Bindings, HonoEnv } from "./env.js";
import { json, errorMessage } from "./http.js";
import {
  KV_ADMIN,
  loadConfigKV,
  maskSecret,
  saveConfigKV,
  type GatewayConfig,
} from "./config.js";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  destroySession,
  ensureAdmin,
  readSession,
  updatePassword,
  verifyPassword,
} from "./auth.js";
import { DO_NAME } from "./constants.js";
import { adminPageHtml, loginPageHtml } from "./pages.js";

function getStub(env: Bindings) {
  const id = env.CMCC_GATEWAY.idFromName(DO_NAME);
  // 与 app.ts 保持一致：亚太机房（仅 DO 创建/重建时生效）
  return env.CMCC_GATEWAY.get(id, { locationHint: "apac" });
}

async function doFetch(
  env: Bindings,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit =
    body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { method: "GET" };
  return getStub(env).fetch(new Request(`https://cmcc.internal${path}`, init));
}

export function sessionToken(context: {
  req: { header: (k: string) => string | undefined };
}): string | undefined {
  const raw = context.req.header("cookie");
  if (!raw) return undefined;
  const m = raw.match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`),
  );
  return m?.[1];
}

export async function requireSession(context: {
  env: Bindings;
  req: { header: (k: string) => string | undefined };
}): Promise<boolean> {
  const token = sessionToken(context);
  const s = await readSession(context.env, token);
  return Boolean(s);
}

export function registerAdminRoutes(app: Hono<HonoEnv>): void {
  app.get("/login", () => {
    return new Response(loginPageHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  app.post("/login", async (c) => {
    try {
      const env = c.env;
      const body = (await c.req.json()) as { user?: string; pass?: string };
      const rec = await ensureAdmin(env);
      if (
        !body.user ||
        !body.pass ||
        body.user.trim() !== rec.user ||
        !(await verifyPassword(rec, body.pass))
      ) {
        return json({ ok: false, message: "账号或密码错误" }, 401);
      }
      const token = await createSession(env, rec.user);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_MAX_AGE,
      });
      return c.json({ ok: true });
    } catch (error) {
      return json(
        { ok: false, message: error instanceof Error ? error.message : "登录失败" },
        500,
      );
    }
  });

  app.get("/admin", () => {
    return new Response(adminPageHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  app.post("/logout", async (c) => {
    await destroySession();
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    return c.json({ ok: true });
  });

  app.get("/api/settings", async (c) => {
    const cfg = await loadConfigKV(c.env.CONFIG);
    const admin = (await c.env.CONFIG?.get(KV_ADMIN, "json")) as
      | { forceReset?: boolean }
      | null;
    // 合并 KV 配置与环境变量兜底，准确反映当前生效值
    const cmccApiKey = cfg.cmccApiKey || c.env.CMCC_API_KEY?.trim() || "";
    const apiToken = cfg.apiToken || c.env.API_TOKEN?.trim() || "";
    const defaultRecipient =
      cfg.defaultRecipient || c.env.DEFAULT_RECIPIENT?.trim() || "";
    return json({
      ok: true,
      cmccApiKey: maskSecret(cmccApiKey),
      cmccApiKeySet: Boolean(cmccApiKey),
      apiToken: maskSecret(apiToken),
      // 真实令牌仅返回给已登录的后台会话，用于「一键复制」填写到 T3 的 key1
      apiTokenRaw: apiToken,
      apiTokenSet: Boolean(apiToken),
      defaultRecipient,
      forceReset: Boolean(admin?.forceReset),
    });
  });

  app.post("/api/settings", async (c) => {
    try {
      const body = (await c.req.json()) as GatewayConfig;
      const next = await saveConfigKV(c.env.CONFIG, {
        cmccApiKey: body.cmccApiKey,
        apiToken: body.apiToken,
        defaultRecipient: body.defaultRecipient,
      });
      // 立即让 Durable Object 应用新配置并重连。
      // 注意：KV 是最终一致，刚写入立刻读可能还是旧值，所以把完整配置直接推给 DO。
      // 重连失败（如平台握手失败）不影响“已保存”——配置已落库，连接会自动重试。
      let reloaded = false;
      let connectError: string | null = null;
      try {
        const r = await doFetch(c.env, "/reload-config", { config: next });
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        reloaded = Boolean(j.ok);
        connectError = (j.connectError as string) || null;
      } catch (error) {
        connectError = errorMessage(error);
      }
      return json({
        ok: true,
        reloaded,
        connectError,
        hasApiKey: Boolean(next.cmccApiKey),
      });
    } catch (error) {
      return json(
        { ok: false, message: error instanceof Error ? error.message : "保存失败" },
        500,
      );
    }
  });

  app.post("/api/connect", async (c) => {
    try {
      const r = await doFetch(c.env, "/connect");
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return json({
        ok: Boolean(j.ok),
        connected: Boolean(j.connected),
        authenticated: Boolean(j.authenticated),
        message: j.message,
      });
    } catch (error) {
      return json(
        {
          ok: false,
          message: error instanceof Error ? error.message : "对接失败",
        },
        500,
      );
    }
  });

  app.post("/api/password", async (c) => {
    try {
      const body = (await c.req.json()) as {
        oldpass?: string;
        newpass?: string;
      };
      const rec = await ensureAdmin(c.env);
      if (!body.oldpass || !(await verifyPassword(rec, body.oldpass))) {
        return json({ ok: false, message: "当前密码错误" }, 401);
      }
      if (!body.newpass || body.newpass.length < 6) {
        return json({ ok: false, message: "新密码至少 6 位" }, 400);
      }
      await updatePassword(c.env, rec.user, body.newpass);
      await destroySession();
      deleteCookie(c, SESSION_COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      return c.json({ ok: true });
    } catch (error) {
      return json(
        { ok: false, message: error instanceof Error ? error.message : "更新失败" },
        500,
      );
    }
  });

  app.get("/api/status", async (c) => {
    try {
      const h = (await doFetch(c.env, "/health").then((r) => r.json())) as Record<
        string,
        unknown
      >;
      return json({
        ok: true,
        connected: Boolean(h.connected),
        authenticated: Boolean(h.authenticated),
        hasRecipient: Boolean(h.hasRecipient),
        lastConnectAt: (h.lastConnectAt as number) || null,
        lastError: (h.lastError as string) || null,
      });
    } catch (error) {
      return json(
        {
          ok: false,
          message: error instanceof Error ? error.message : "状态获取失败",
        },
        500,
      );
    }
  });

  app.post("/api/test-send", async (c) => {
    try {
      const body = (await c.req.json()) as { to?: string; content?: string };
      // to 可留空：留空由 DO 使用默认接收人（配置的或自动记录的）
      const r = await doFetch(c.env, "/api/test-send", {
        to: (body.to || "").trim(),
        content: body.content || "",
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return json({
        ok: Boolean(j.ok),
        messageId: j.messageId || null,
        connected: Boolean(j.connected),
        authenticated: Boolean(j.authenticated),
        notice: j.notice || null,
        message:
          j.notice || j.message || (j.ok ? "已发送，请查收手机" : "发送失败"),
      });
    } catch (error) {
      return json({ ok: false, message: errorMessage(error) }, 500);
    }
  });
}
