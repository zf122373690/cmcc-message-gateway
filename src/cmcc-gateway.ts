import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";

import {
  DEFAULT_CMCC_SERVER,
  DEFAULT_CMCC_UPLOAD,
  DEFAULT_CMCC_VERSION,
  LEGACY_DO_NAMES,
  RECENT_FRAMES_KEY,
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
  // 最近若干入站帧原文（内存态，仅用于对接诊断，DO 重启即清空）
  recentFrames: { receivedAt: number; frame: unknown }[] = [];
  // 当前 WebSocket 连接是用哪个 API Key 建立的（K 变更后需要重连才生效）
  connectedApiKey: string | null = null;

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
      // 帧历史持久化在 DO 存储中，重启/休眠后不丢（用于抓平台语音帧等诊断）
      const saved = await this.state.storage.get<{ receivedAt: number; frame: unknown }[]>(
        RECENT_FRAMES_KEY,
      );
      if (Array.isArray(saved)) this.recentFrames = saved;
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

  /**
   * 直接应用网页后台刚保存的配置（不走 KV 读取）。
   * Cloudflare KV 是最终一致：保存后立刻读很可能还是旧值，
   * 所以由调用方把完整配置推进来，立即生效。
   */
  applyConfig(pushed: GatewayConfig): void {
    const next: GatewayConfig = {};
    for (const key of Object.keys(pushed) as (keyof GatewayConfig)[]) {
      const value = pushed[key];
      if (value === undefined || value === null) continue;
      (next as Record<string, string>)[key] = String(value).trim();
    }
    this.config = next;
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
    // 旧名 DO（如 "default"）的自清理：DO 改名强制重建到亚太机房后，
    // 旧实例的 alarm 仍会每 5 分钟唤醒并抢平台 WS 连接。发现自己是
    // legacy 名就删光存储（含 alarm）并不再续期，之后永远不再被唤醒。
    if (this.isLegacyName()) {
      try {
        this.ws?.close(1000, "legacy-do-retired");
      } catch {
        // ignore
      }
      await this.state.storage.deleteAll();
      return;
    }
    try {
      await ensureConnected(this);
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      await this.state.storage.setAlarm(Date.now() + 5 * 60_000);
    }
  }

  /** 本实例是否为历史名（DO 改名重建前的旧实例） */
  private isLegacyName(): boolean {
    if (LEGACY_DO_NAMES.length === 0) return false;
    try {
      const myId = this.state.id.toString();
      return LEGACY_DO_NAMES.some(
        (name) => this.bindings.CMCC_GATEWAY.idFromName(name).toString() === myId,
      );
    } catch {
      return false;
    }
  }
}
