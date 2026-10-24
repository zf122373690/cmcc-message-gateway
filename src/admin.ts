// 后台管理路由：登录、设置读写、一键对接、改密、状态。由 app.ts 挂载。

import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Bindings, HonoEnv } from "./env.js";
import { json } from "./http.js";
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
import { adminPageHtml, loginPageHtml } from "./pages.js";

function getStub(env: Bindings) {
  const id = env.CMCC_GATEWAY.idFromName("default");
  return env.CMCC_GATEWAY.get(id);
}

async function doFetch(env: Bindings, path: string): Promise<Response> {
  return getStub(env).fetch(new Request(`https://cmcc.internal${path}`));
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
      // 立即让 Durable Object 重新加载配置并对接
      const r = await doFetch(c.env, "/reload-config");
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return json({
        ok: true,
        reloaded: Boolean(j.ok),
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
}
