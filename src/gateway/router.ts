import { Hono } from "hono";

import type { CmccGateway } from "../cmcc-gateway.js";
import type { GatewayConfig } from "../config.js";
import {
  INBOX_KEY,
  LAST_FRAME_KEY,
  MAX_INBOX,
  RECENT_FRAMES_KEY,
  RECIPIENT_KEY,
} from "../constants.js";
import { decodePathPart, errorMessage, json, readJson } from "../http.js";
import type { InboundMessage } from "../message-format.js";
import { inferMediaType, inferMediaTypeFromUrl } from "../message-format.js";
import { ensureConnected, resetConnection } from "./connection.js";
import { sendMedia, sendText, uploadMedia } from "./outbound.js";
import { transcodeAmrFile } from "../media/transcode.js";
import type { Recipient } from "./recipients.js";
import {
  getFallbackRecipient,
  requireRecipient,
  resolveRecipient,
} from "./recipients.js";

type RequestBody = Record<string, unknown>;

export function createGatewayApp(gateway: CmccGateway): Hono {
  const app = new Hono();

  app.all("/health", async () => healthResponse(gateway));

  app.all("/connect", async () => {
    await ensureConnected(gateway);
    return json({
      ok: true,
      connected: gateway.isOpen(),
      authenticated: gateway.authenticated,
      timestamp: Date.now(),
    });
  });

  // 后台保存配置后调用：应用新配置并重新对接。
  // - 可带 JSON body { config }：网页刚保存的完整配置，直接应用（绕开 KV 最终一致延迟）
  // - 重连失败不再抛异常：保存本身已成功，返回 connectError 由前端提示即可
  app.all("/reload-config", async (context) => {
    let pushed: GatewayConfig | null = null;
    if (context.req.method === "POST") {
      try {
        const body = (await context.req.json()) as {
          config?: GatewayConfig;
        } | null;
        if (body && typeof body.config === "object" && body.config) {
          pushed = body.config;
        }
      } catch {
        // 允许空 body，回退到从 KV 重读
      }
    }

    if (pushed) {
      gateway.applyConfig(pushed);
    } else {
      gateway.configLoadedAt = 0;
      await gateway.loadConfig();
    }

    // K 变了：旧连接是用旧 Key 建的，必须先断开重连，否则新 Key 不生效
    if (gateway.connectedApiKey !== gateway.cmccApiKey) {
      await resetConnection(gateway);
    }

    let connectError: string | null = null;
    try {
      await ensureConnected(gateway);
    } catch (error) {
      connectError = errorMessage(error);
      gateway.lastError = connectError;
    }

    return json({
      ok: true,
      connected: gateway.isOpen(),
      authenticated: gateway.authenticated,
      hasApiKey: Boolean(gateway.cmccApiKey),
      connectError,
      timestamp: Date.now(),
    });
  });

  app.all("/api/recipient", async () => {
    const stored = await gateway.state.storage.get<Recipient>(RECIPIENT_KEY);
    const fallback = getFallbackRecipient(gateway);

    return json({
      ok: true,
      recipient: stored || fallback || null,
      autoRecipient: true,
      timestamp: Date.now(),
    });
  });

  app.all("/api/inbox", async (context) =>
    inboxResponse(gateway, context.req.query("limit")),
  );

  app.all("/api/debug/last-frame", async () => {
    const stored =
      (await gateway.state.storage.get<{ receivedAt: number; frame: unknown }[]>(
        RECENT_FRAMES_KEY,
      )) || [];
    return json({
      ok: true,
      frame: (await gateway.state.storage.get(LAST_FRAME_KEY)) || null,
      frames: stored.slice(-10),
    });
  });

  // 探测 DO 所在机房：DO 出网请求 cloudflare.com/cdn-cgi/trace，返回的 colo
  // 即 DO 所在 colo（用于验证 locationHint: "apac" 是否生效）。
  app.all("/api/debug/colo", async () => {
    let colo: string | null = null;
    let traceError: string | null = null;
    try {
      const res = await fetch("https://cloudflare.com/cdn-cgi/trace");
      const text = await res.text();
      const m = text.match(/^colo=(\S+)$/m);
      colo = m ? m[1] : null;
    } catch (error) {
      traceError = errorMessage(error);
    }
    return json({
      ok: true,
      colo,
      traceError,
    });
  });

  // 转码基准端点：只转码不上传，用于定位长音频失败阶段。
  // workerd 中 Date.now()/performance.now() 在纯 CPU 段冻结，故在转码后
  // 先 yield 一次（setTimeout 0）再读时钟，差值即真实 CPU 段耗时。
  app.all("/api/debug/transcode-test", async (context) => {
    const request = context.req.raw;
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ ok: false, message: "需要 multipart/form-data" }, 400);
    }
    const form = await request.formData();
    const file = form.get("file") || form.get("media");
    if (!(file instanceof File)) {
      return json({ ok: false, message: "缺少文件字段" }, 400);
    }
    const t0 = Date.now();
    const result = await transcodeAmrFile(file);
    // yield 一次让冻结的时钟前进
    await new Promise((resolve) => setTimeout(resolve, 1));
    const t1 = Date.now();
    return json({
      ok: true,
      inputBytes: file.size,
      amrDetected: result.amrDetected,
      transcoded: result.transcoded,
      reason: result.reason ?? null,
      outputBytes: result.file.size,
      outputName: result.file.name,
      ms: t1 - t0,
    });
  });

  // 兼容 T3 Lite 固件“自定义 Webhook”的原生提交方式：
  // - JSON 模式（customBody 以 JSON: 开头）：body 为合法 JSON，按 title/body 解析
  // - 纯文本模式（customBody 为普通文本）：固件把 Content-Type 仍标成
  //   application/json，但 body 是纯文本（含 T3 默认模板的“号码:/来源:/【设备】”等），
  //   这里解析失败就回退成纯文本解析，而不是像之前一样直接 500
  // - 表单模式（FORM: 开头）：application/x-www-form-urlencoded
  app.post("/push", async (context) => {
    const request = context.req.raw;
    const contentType = request.headers.get("content-type") || "";

    // 语音/图片/视频/文件：multipart 直传（与文本推送复用同一个 /push 入口，
    // 表单字段：file 必填，to/mediaType/content/mediaFileName 可选）
    if (contentType.includes("multipart/form-data")) {
      return handleMediaUpload(gateway, request);
    }

    const raw = await request.text();
    let values: { to?: unknown; title?: unknown; body?: unknown };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // JSON 带 mediaUrl：走媒体发送（如语音 AMR：
        // {"mediaUrl":"https://.../voice.amr","mediaType":"AUDIO","content":"附言"}）
        if ((parsed as RequestBody).mediaUrl) {
          return handleMediaSend(gateway, {
            ...(parsed as RequestBody),
            mediaType:
              (parsed as RequestBody).mediaType ||
              inferMediaTypeFromUrl(String((parsed as RequestBody).mediaUrl)),
          });
        }
        values = {
          to: (parsed as RequestBody).to,
          title: (parsed as RequestBody).title,
          body:
            (parsed as RequestBody).body ??
            (parsed as RequestBody).content ??
            (parsed as RequestBody).message,
        };
      } else {
        values = parseT3Text(raw);
      }
    } catch {
      values = parseT3Text(raw);
    }
    return handlePush(gateway, values);
  });

  app.get("/push", (context) => {
    const query = context.req.query();
    // 带 mediaUrl：媒体发送（如语音 ?mediaUrl=https://.../voice.amr&mediaType=AUDIO）
    if (query.mediaUrl) {
      return handleMediaSend(gateway, {
        ...query,
        mediaType: query.mediaType || inferMediaTypeFromUrl(query.mediaUrl),
      });
    }
    return handlePush(gateway, {
      to: query.to || "",
      title: query.title || "",
      body: query.body || query.content || query.message || "",
    });
  });

  // Hono 的 `*` 也会匹配空尾段，精确路由必须先注册。
  app.get("/push/*", (context) =>
    handlePathPush(gateway, context.req.path, context.req.query()),
  );

  app.post("/api/messages/send", async (context) => {
    const body = await readJson<RequestBody>(context.req.raw);
    return handlePush(gateway, {
      to: body.to,
      title: body.title,
      body: body.body ?? body.content ?? body.message,
    });
  });

  // 测试发送：真实向中国移动通道发送一条文本消息，并等待约 4 秒采集平台回执，
  // 用于验证对接链路是否真正可用（如“设备暂未在线”等回执会被如实返回）。
  app.post("/api/test-send", async (context) => {
    let to = "";
    let content = "";
    try {
      const body = await readJson<RequestBody>(context.req.raw);
      to = String(body.to || "");
      content = String(body.content || body.body || "");
    } catch {
      // 允许空 body，下面会校验
    }
    // to 可留空：留空时使用默认接收人（后台配置的，或手机向 ClawBot 发消息自动记录的）；
    // 若两者都没有，requireRecipient 会抛出明确错误，由下方 catch 返回。
    const text = content.trim() || "【测试】CMCC 短信转发对接测试，收到请忽略。";
    try {
      const recipient = await requireRecipient(gateway, to);
      const t0 = Date.now();
      const messageId = await sendText(gateway, recipient.id, text);
      const notice = await collectNoticeAfter(gateway, t0, 4000);
      return json({
        ok: true,
        messageId,
        connected: gateway.isOpen(),
        authenticated: gateway.authenticated,
        notice: notice || null,
        status: notice ? "platform_notice" : "ws_written",
      });
    } catch (error) {
      return json(
        {
          ok: false,
          connected: gateway.isOpen(),
          authenticated: gateway.authenticated,
          message: errorMessage(error),
        },
        400,
      );
    }
  });

  app.post("/api/media/send", async (context) =>
    handleMediaSend(
      gateway,
      await readJson<RequestBody>(context.req.raw),
    ),
  );

  app.post("/api/media/upload-send", (context) =>
    handleMediaUpload(gateway, context.req.raw),
  );

  app.notFound(() =>
    json(
      {
        ok: false,
        code: 404,
        message: "Not Found",
      },
      404,
    ),
  );

  app.onError((error) => {
    gateway.lastError = errorMessage(error);
    return json(
      {
        ok: false,
        code: 500,
        message: gateway.lastError,
      },
      500,
    );
  });

  return app;
}

async function healthResponse(gateway: CmccGateway): Promise<Response> {
  const recipient = await resolveRecipient(gateway, "");

  return json({
    ok: true,
    service: "cmcc-message-gateway",
    connected: gateway.isOpen(),
    authenticated: gateway.authenticated,
    hasRecipient: Boolean(recipient),
    recipient: recipient
      ? {
          id: recipient.id,
          source: recipient.source,
          updatedAt: recipient.updatedAt,
        }
      : null,
    lastConnectAt: gateway.lastConnectAt || null,
    lastDisconnectAt: gateway.lastDisconnectAt || null,
    lastPongAt: gateway.lastPongAt || null,
    lastError: gateway.lastError,
    lastNotice: gateway.lastNotice,
    timestamp: Date.now(),
  });
}

async function inboxResponse(
  gateway: CmccGateway,
  rawLimit: string | undefined,
): Promise<Response> {
  const requested = Number.parseInt(rawLimit || "50", 10);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requested) ? requested : 50, MAX_INBOX),
  );
  const inbox =
    (await gateway.state.storage.get<InboundMessage[]>(INBOX_KEY)) || [];

  return json({
    ok: true,
    count: Math.min(limit, inbox.length),
    totalStored: inbox.length,
    messages: inbox.slice(0, limit),
  });
}

function handlePathPush(
  gateway: CmccGateway,
  path: string,
  query: Record<string, string>,
): Promise<Response> | Response {
  const parts = path
    .slice("/push/".length)
    .split("/")
    .map(decodePathPart)
    .filter((part) => part !== "");

  if (parts.length === 1) {
    return handlePush(gateway, {
      body: parts[0],
      to: query.to || "",
      title: query.title || "",
    });
  }

  if (parts.length >= 2) {
    return handlePush(gateway, {
      title: parts[0],
      body: parts.slice(1).join("/"),
      to: query.to || "",
    });
  }

  return json(
    {
      code: 400,
      message: "缺少消息内容",
    },
    400,
  );
}

// 解析 T3 Lite 固件“自定义 Webhook”纯文本（或 GET 参数拼出的）默认模板：
//   <短信内容>
//   号码:13800138000
//   时间:2026-10-24 13:00:00
//   来源: SIM1 123456789012345
//   运行时间: 1天2小时
//   【设备名】短信
// 把短信正文抽出来，补齐号码/卡槽后作为转发内容；识别不出 T3 格式则原样发送。
function parseT3Text(raw: string): {
  to?: string;
  title?: string;
  phone?: string;
  body: string;
} {
  const text = (raw || "").trim();
  if (!text) return { body: "" };

  const isMeta = (l: string): boolean =>
    /^(号码|时间|来源|运行时间|备注|事件)[:：]/.test(l) ||
    /^(SIM|卡槽)/.test(l) ||
    /^【.+】/.test(l);

  const phoneMatch = text.match(/号码[:：]\s*([^\s]+)/);
  const phone = phoneMatch ? phoneMatch[1].trim() : undefined;
  const sourceMatch = text.match(/来源[:：]\s*(.+)/);
  const slot = sourceMatch ? sourceMatch[1].trim() : undefined;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const contentLines: string[] = [];
  for (const l of lines) {
    if (isMeta(l)) break;
    contentLines.push(l);
  }
  const content = contentLines.join("\n").trim() || text;

  const extra: string[] = [];
  if (phone) extra.push(`号码: ${phone}`);
  if (slot) extra.push(`卡槽: ${slot}`);
  const body = extra.length ? `${content}\n${extra.join("\n")}` : content;

  return { body, phone, title: "" };
}

async function handlePush(
  gateway: CmccGateway,
  values: { to?: unknown; title?: unknown; body?: unknown },
): Promise<Response> {
  const contentBody = String(values.body || "").trim();
  const contentTitle = String(values.title || "").trim();

  if (!contentBody && !contentTitle) {
    return json(
      {
        code: 400,
        message: "消息内容不能为空",
      },
      400,
    );
  }

  const recipient = await requireRecipient(gateway, values.to);
  const content =
    contentTitle && contentBody
      ? `${contentTitle}\n${contentBody}`
      : contentTitle || contentBody;
  const messageId = await sendText(gateway, recipient.id, content);

  return successResponse(messageId, recipient);
}

async function handleMediaSend(
  gateway: CmccGateway,
  body: RequestBody,
): Promise<Response> {
  const recipient = await requireRecipient(gateway, body.to);

  if (!body.mediaUrl) {
    return json(
      {
        code: 400,
        message: "mediaUrl 不能为空",
      },
      400,
    );
  }

  const result = await sendMedia(gateway, {
    to: recipient.id,
    mediaType: body.mediaType || "FILE",
    content: body.content || body.title || "",
    mediaUrl: body.mediaUrl,
    thumbnailUrl: body.thumbnailUrl,
    mediaFileName: body.mediaFileName || body.fileName,
    mediaSize: body.mediaSize,
    mediaMimeType: body.mediaMimeType || body.mimeType,
  });

  return successResponse(result.messageId, recipient);
}

async function handleMediaUpload(
  gateway: CmccGateway,
  request: Request,
): Promise<Response> {
  // 注意：workerd 中 Date.now() 在纯 CPU 执行段是冻结的（仅跨 I/O 前进），
  // 测 CPU 密集的转码耗时必须用 performance.now()。
  const p0 = performance.now();
  const form = await request.formData();
  const p1 = performance.now();
  // 文件字段兼容：file（curl/网页用法）与 media（T3 来电录音上传用法，
  // T3 固定发 filename="record.amr"、Content-Type: application/octet-stream、不带 header）
  const file = form.get("file") || form.get("media");

  if (!(file instanceof File)) {
    return json(
      {
        code: 400,
        message: "multipart/form-data 中缺少文件字段（file 或 media）",
      },
      400,
    );
  }

  const recipient = await requireRecipient(gateway, form.get("to"));

  // AMR 录音（T3 来电录音等）平台按内容识别为非音频，会渲染成文件卡片；
  // 先转码为 MP3（8kHz 单声道）再上传，使其呈现为语音气泡。
  // 转码失败时回退原文件，不影响推送本身。
  const t0 = performance.now();
  const transcode = await transcodeAmrFile(file);
  const t1 = performance.now();
  if (transcode.amrDetected && !transcode.transcoded) {
    // 转码失败留痕，便于 /api/status 排查（不影响推送，仍按原文件发）
    gateway.lastError = `AMR transcode failed (${file.size}B): ${transcode.reason ?? "unknown"}`;
  }
  const uploadFile = transcode.file;
  const uploaded = await uploadMedia(gateway, uploadFile);
  const t2 = performance.now();

  // 媒体类型：表单显式指定 > 文件 MIME > 文件扩展名（浏览器对 .amr 等可能不给 MIME）
  let mediaType = String(form.get("mediaType") || "").trim();
  if (!mediaType) {
    mediaType = inferMediaType(uploadFile.type);
    if (mediaType === "FILE") {
      mediaType = inferMediaTypeFromUrl(uploadFile.name || "");
    }
  }

  const result = await sendMedia(gateway, {
    to: recipient.id,
    mediaType,
    content: String(form.get("content") || ""),
    mediaUrl: uploaded.mediaUrl,
    mediaFileName: uploadFile.name,
    mediaSize: uploadFile.size,
    mediaMimeType: uploadFile.type || undefined,
  });
  const t3 = performance.now();

  return successResponse(result.messageId, recipient, {
    mediaUrl: uploaded.mediaUrl,
    // 转码诊断：AMR 输入是否成功转为 MP3（失败时 reason 带原因，仍按原文件推送）
    transcoded: transcode.transcoded,
    timings: {
      parseMs: Math.round(p1 - p0),
      transcodeMs: Math.round(t1 - t0),
      uploadMs: Math.round(t2 - t1),
      sendMs: Math.round(t3 - t2),
    },
    ...(transcode.amrDetected && !transcode.transcoded
      ? { transcodeError: transcode.reason ?? "unknown" }
      : {}),
  });
}

function successResponse(
  messageId: string,
  recipient: Recipient,
  extraData: Record<string, unknown> = {},
): Response {
  return json({
    code: 200,
    message: "success",
    timestamp: Date.now(),
    data: {
      messageId,
      status: "ws_written",
      to: recipient.id,
      recipientSource: recipient.source,
      ...extraData,
    },
  });
}

// 发送后等待平台回执：轮询 gateway.lastNotice，若收到发送之后新增的通知则返回其文本。
// 平台回执（如“设备暂未在线”）通过 WebSocket 异步推回，此处最多等待 timeoutMs。
async function collectNoticeAfter(
  gateway: CmccGateway,
  sinceTs: number,
  timeoutMs: number,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (gateway.lastNotice && gateway.lastNotice.at >= sinceTs) {
      return gateway.lastNotice.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}
