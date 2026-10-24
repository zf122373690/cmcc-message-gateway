import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";

import {
  DEFAULT_CMCC_SERVER,
  DEFAULT_CMCC_UPLOAD,
  DEFAULT_CMCC_VERSION,
} from "./constants.js";
import type { Bindings } from "./env.js";
import type { GatewayConfig } from "./config.js";
import { ensureConnected } from "./gateway/connection.js";
import { createGatewayApp } from "./gateway/router.js";
import { errorMessage } from "./http.js";

export class CmccGateway extends DurableObject<Bindings> {
  readonly state: DurableObjectState;
  readonly bindings: Bindings;

  ws: WebSocket | null = null;
  authenticated = false;
  connectPromise: Promise<void> | null = null;
  authResolve: (() => void) | null = null;
  authReject: ((reason?: unknown) => void) | null = null;
  authTimeout: ReturnType<typeof setTimeout> | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  lastPongAt = 0;
  lastConnectAt = 0;
  lastDisconnectAt = 0;
  lastError: string | null = null;
  // 平台最近推送的通知/回执文本（如“设备暂未在线”等），用于对接诊断展示
  lastNotice: { text: string; at: number } | null = null;

  // 来自 KV 的配置（网页后台可改），环境变量作为兜底
  config: GatewayConfig = {};
  configLoadedAt = 0;
  private configLoaded = false;

  private readonly app: Hono;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.state = ctx;
    this.bindings = env;
    this.app = createGatewayApp(this);

    this.state.blockConcurrencyWhile(async () => {
      const alarm = await this.state.storage.getAlarm();
      if (alarm == null) {
        await this.state.storage.setAlarm(Date.now() + 30_000);
      }
      await this.loadConfig();
    });
  }

  /** 从 KV 读取网页配置；30 秒内复用缓存，避免每次 push 都读 KV */
  async loadConfig(): Promise<void> {
    if (this.configLoaded && Date.now() - this.configLoadedAt < 30_000) return;
    try {
      const kv = this.bindings.CONFIG;
      this.config = kv
        ? ((await kv.get("config", "json")) as GatewayConfig) || {}
        : {};
    } catch {
      this.config = {};
    }
    this.configLoadedAt = Date.now();
    this.configLoaded = true;
  }

  get cmccApiKey(): string {
    return String(this.config.cmccApiKey || this.bindings.CMCC_API_KEY || "").trim();
  }

  get defaultRecipient(): string {
    return String(
      this.config.defaultRecipient || this.bindings.DEFAULT_RECIPIENT || "",
    ).trim();
  }

  get serverUrl(): string {
    return (
      String(this.bindings.CMCC_SERVER_URL || "").trim() ||
      DEFAULT_CMCC_SERVER
    );
  }

  get uploadBaseUrl(): string {
    return (
      String(this.bindings.CMCC_UPLOAD_URL || "").trim() ||
      DEFAULT_CMCC_UPLOAD
    ).replace(/\/+$/, "");
  }

  get cmccVersion(): string {
    return (
      String(this.bindings.CMCC_VERSION || "").trim() || DEFAULT_CMCC_VERSION
    );
  }

  isOpen(): this is this & { ws: WebSocket } {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  async alarm(): Promise<void> {
    try {
      await ensureConnected(this);
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      await this.state.storage.setAlarm(Date.now() + 5 * 60_000);
    }
  }
}
