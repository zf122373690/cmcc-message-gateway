import type { CmccGateway } from "../cmcc-gateway.js";
import { LAST_FRAME_KEY } from "../constants.js";
import { errorMessage } from "../http.js";
import {
  isCmccFrame,
  normalizeInbound,
  parseWebSocketFrame,
  sanitizeFrame,
} from "../message-format.js";
import { addInbox, setAutoRecipient } from "./recipients.js";

export async function handleWebSocketMessage(
  gateway: CmccGateway,
  data: unknown,
): Promise<void> {
  let parsed: unknown;

  try {
    parsed = await parseWebSocketFrame(data);
  } catch {
    return;
  }

  await gateway.state.storage.put(LAST_FRAME_KEY, {
    receivedAt: Date.now(),
    frame: sanitizeFrame(parsed),
  });

  if (!isCmccFrame(parsed)) return;

  const type = String(parsed.type || "");

  if (type === "auth_ok") {
    gateway.authenticated = true;
    gateway.lastError = null;

    if (gateway.authTimeout !== null) {
      clearTimeout(gateway.authTimeout);
      gateway.authTimeout = null;
    }

    gateway.authResolve?.();
    gateway.authResolve = null;
    gateway.authReject = null;
    return;
  }

  if (type === "auth_failed") {
    handleAuthenticationFailure(gateway, parsed.message);
    return;
  }

  if (type === "pong") {
    gateway.lastPongAt = Date.now();
    return;
  }

  if (type === "ping") {
    if (gateway.isOpen()) {
      gateway.ws.send(JSON.stringify({ type: "pong" }));
    }
    return;
  }

  if (["text_message", "media_message", "message"].includes(type)) {
    const sender = String(parsed.from || parsed.phone || "").trim();

    // CMCC 的某些状态回包也叫 message，但没有 from（如“设备暂未在线”等通知），
    // 这类帧不是入站消息，提取文本作为平台通知，供对接诊断展示。
    if (!sender) {
      const notice = extractNoticeText(parsed);
      if (notice) gateway.lastNotice = { text: notice, at: Date.now() };
      return;
    }

    const message = normalizeInbound(parsed, sender);
    await setAutoRecipient(gateway, message);
    await addInbox(gateway, message);

    if (gateway.bindings.INBOUND_WEBHOOK_URL) {
      gateway.state.waitUntil(deliverWebhook(gateway, message));
    }
  }

  // 其余未被上述分支识别的帧（平台状态/回执），提取可读文本作为平台最近通知
  const fallbackNotice = extractNoticeText(parsed);
  if (fallbackNotice) {
    gateway.lastNotice = { text: fallbackNotice, at: Date.now() };
  }
}

function handleAuthenticationFailure(
  gateway: CmccGateway,
  rawMessage: unknown,
): void {
  const error = new Error(
    rawMessage ? String(rawMessage) : "CMCC authentication failed",
  );

  if (gateway.authTimeout !== null) {
    clearTimeout(gateway.authTimeout);
    gateway.authTimeout = null;
  }

  gateway.authenticated = false;
  gateway.lastError = error.message;
  gateway.authReject?.(error);
  gateway.authResolve = null;
  gateway.authReject = null;

  try {
    gateway.ws?.close(4003, "auth failed");
  } catch {
    // ignore
  }
}

async function deliverWebhook(
  gateway: CmccGateway,
  message: unknown,
): Promise<void> {
  const url = String(gateway.bindings.INBOUND_WEBHOOK_URL || "").trim();
  if (!url) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const token = String(gateway.bindings.INBOUND_WEBHOOK_TOKEN || "").trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
  } catch (error) {
    gateway.lastError = `Inbound webhook: ${errorMessage(error)}`;
  }
}

// 从平台帧中提取可读文本，用于对接诊断展示（如“设备暂未在线”等回执）。
function extractNoticeText(frame: unknown): string | null {
  const f = frame as Record<string, unknown>;
  const text = String(
    f.content ?? f.text ?? f.message ?? f.reason ?? f.desc ?? f.detail ?? "",
  ).trim();
  if (text) return text.slice(0, 500);
  try {
    const summary = JSON.stringify(sanitizeFrame(frame));
    return summary.length > 500 ? summary.slice(0, 500) : summary;
  } catch {
    return null;
  }
}
