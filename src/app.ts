import { Hono } from "hono";

import type { Bindings, HonoEnv } from "./env.js";
import { json, publicAuthorized } from "./http.js";
import { loadConfigKV } from "./config.js";
import { registerAdminRoutes, requireSession } from "./admin.js";

function getStub(env: Bindings): DurableObjectStub {
  const id = env.CMCC_GATEWAY.idFromName("default");
  return env.CMCC_GATEWAY.get(id);
}

const ADMIN_PATHS = [
  "/admin",
  "/logout",
  "/api/settings",
  "/api/connect",
  "/api/password",
  "/api/status",
  "/api/test-send",
];

function isAdminPath(path: string): boolean {
  return ADMIN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

async function resolveApiToken(env: Bindings): Promise<string> {
  const cfg = await loadConfigKV(env.CONFIG);
  return (cfg.apiToken || env.API_TOKEN || "").trim();
}

export const app = new Hono<HonoEnv>();

// 路由鉴权：公开(健康/登录) → 会话鉴权(后台) → 设备令牌(API_TOKEN)转发给 DO
app.use("*", async (context, next) => {
  const path = context.req.path;

  if (path === "/" || path === "/health" || path === "/login") {
    return next();
  }

  if (isAdminPath(path)) {
    if (!(await requireSession(context))) {
      if (path.startsWith("/api/")) {
        return json({ ok: false, message: "未登录" }, 401);
      }
      return context.redirect("/login");
    }
    return next();
  }

  const token = await resolveApiToken(context.env);
  if (!token || !publicAuthorized(context.req.raw, token)) {
    return json({ ok: false, code: 401, message: "Unauthorized" }, 401);
  }
  return next();
});

async function health(env: Bindings): Promise<Response> {
  try {
    const response = await getStub(env).fetch(
      new Request("https://cmcc.internal/health"),
    );
    const detail = (await response.json()) as Record<string, unknown>;

    return json({
      ok: true,
      service: "cmcc-message-gateway",
      connected: Boolean(detail.connected),
      authenticated: Boolean(detail.authenticated),
      hasRecipient: Boolean(detail.hasRecipient),
      timestamp: Date.now(),
    });
  } catch (error) {
    return json(
      {
        ok: false,
        service: "cmcc-message-gateway",
        connected: false,
        authenticated: false,
        hasRecipient: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      503,
    );
  }
}

app.get("/", (context) => health(context.env));
app.get("/health", (context) => health(context.env));

registerAdminRoutes(app);

// 其余请求（设备 API：/push、/connect、/api/messages/* 等）原样转发给 Durable Object
app.all("*", (context) => getStub(context.env).fetch(context.req.raw));
