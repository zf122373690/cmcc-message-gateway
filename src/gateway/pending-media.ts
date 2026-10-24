// 长录音后台处理：/push 对大文件只入队即返回，真正转码+上传+发送由 DO alarm 执行。
// 动机：Cloudflare 前台请求 CPU 上限 30s，超限直接杀 isolate——长录音（数分钟）
// 内联转码会把 T3 的上传请求一起搞失败；alarm 是独立执行上下文，有独立 CPU 预算。

import type { CmccGateway } from "../cmcc-gateway.js";
import {
  INLINE_TRANSCODE_MAX_BYTES,
  MEDIA_CHUNK_PREFIX,
  MEDIA_CHUNK_SIZE,
  PENDING_MEDIA_KEY,
  PENDING_MEDIA_MAX_ATTEMPTS,
} from "../constants.js";
import { errorMessage } from "../http.js";
import { inferMediaTypeFromUrl } from "../message-format.js";
import { sendMedia, uploadMedia } from "./outbound.js";
import { transcodeAmrFile } from "../media/transcode.js";
import { isAmrBytes, isAmrFileName } from "../media/transcode.js";

export interface PendingMediaJob {
  id: string;
  to: string;
  content: string;
  fileName: string;
  bytes: number;
  chunks: number;
  attempts: number;
  createdAt: number;
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** 是否应该走后台上队（而非内联转码） */
export function shouldQueueLongMedia(bytes: Uint8Array, fileName: string): boolean {
  if (bytes.length <= INLINE_TRANSCODE_MAX_BYTES) return false;
  return isAmrBytes(bytes) || isAmrFileName(fileName);
}

/**
 * 把文件分片存入 DO 存储并安排 alarm 尽快处理。
 * 返回 false 表示已有任务在处理（调用方应内联处理当前文件）。
 */
export async function queuePendingMedia(
  gateway: CmccGateway,
  args: { to: string; content: string; file: File; bytes: Uint8Array },
): Promise<boolean> {
  const storage = gateway.state.storage;
  const existing = await storage.get<PendingMediaJob>(PENDING_MEDIA_KEY);
  if (existing) return false;

  const id = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const chunks = Math.max(1, Math.ceil(args.bytes.length / MEDIA_CHUNK_SIZE));
  for (let i = 0; i < chunks; i += 1) {
    const slice = args.bytes.subarray(
      i * MEDIA_CHUNK_SIZE,
      Math.min((i + 1) * MEDIA_CHUNK_SIZE, args.bytes.length),
    );
    await storage.put(`${MEDIA_CHUNK_PREFIX}${id}:${i}`, slice);
  }
  const job: PendingMediaJob = {
    id,
    to: args.to,
    content: args.content,
    fileName: args.file.name || "record.amr",
    bytes: args.bytes.length,
    chunks,
    attempts: 0,
    createdAt: Date.now(),
  };
  await storage.put(PENDING_MEDIA_KEY, job);
  // 100ms 后处理：避开当前请求上下文，拿到独立的 alarm CPU 预算
  await storage.setAlarm(Date.now() + 100);
  return true;
}

async function clearPendingMedia(gateway: CmccGateway, job: PendingMediaJob): Promise<void> {
  const storage = gateway.state.storage;
  for (let i = 0; i < job.chunks; i += 1) {
    await storage.delete(`${MEDIA_CHUNK_PREFIX}${job.id}:${i}`);
  }
  await storage.delete(PENDING_MEDIA_KEY);
}

/**
 * alarm 调用：处理待发的长录音。
 * - 转码成功 → 上传 MP3 → 发送
 * - 转码失败 → 兜底发原始文件（降级为文件卡片，但保证消息可达）
 * - 发送失败（WS 断等瞬时错误）→ 保留任务，下次 alarm 重试
 */
export async function processPendingMedia(gateway: CmccGateway): Promise<void> {
  const storage = gateway.state.storage;
  const job = await storage.get<PendingMediaJob>(PENDING_MEDIA_KEY);
  if (!job) return;

  try {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < job.chunks; i += 1) {
      const buf = await storage.get<ArrayBuffer>(`${MEDIA_CHUNK_PREFIX}${job.id}:${i}`);
      if (!buf) throw new Error(`分片缺失: ${i}/${job.chunks}`);
      parts.push(new Uint8Array(buf));
    }
    const bytes = concatBytes(parts, job.bytes);

    const transcode = await transcodeAmrFile(
      new File([bytes.buffer as ArrayBuffer], job.fileName, {
        type: "application/octet-stream",
      }),
    );
    const uploadFile = transcode.file;
    const uploaded = await uploadMedia(gateway, uploadFile);
    const mediaType = inferMediaTypeFromUrl(uploadFile.name || "");
    await sendMedia(gateway, {
      to: job.to,
      mediaType,
      content: job.content,
      mediaUrl: uploaded.mediaUrl,
      mediaFileName: uploadFile.name,
      mediaSize: uploadFile.size,
      mediaMimeType: uploadFile.type || undefined,
    });
    gateway.lastNotice = {
      text: `长录音已发送（${transcode.transcoded ? "MP3 转码" : "原始文件兜底"}，${uploadFile.size}B）`,
      at: Date.now(),
    };
    await clearPendingMedia(gateway, job);
  } catch (error) {
    const attempts = job.attempts + 1;
    if (attempts >= PENDING_MEDIA_MAX_ATTEMPTS) {
      // 重试多次仍失败：兜底发送原始文件后放弃（保证消息至少可达）
      gateway.lastError = `长录音处理失败(${attempts}次)：${errorMessage(error)}`;
      await sendFallbackOriginal(gateway, job);
      await clearPendingMedia(gateway, job);
      return;
    }
    // 瞬时失败（如 WS 未连上）：保留任务等下次 alarm 重试
    gateway.lastError = `长录音处理重试中(${attempts})：${errorMessage(error)}`;
    await storage.put(PENDING_MEDIA_KEY, { ...job, attempts });
  }
}

/** 兜底：跳过转码，直接上传发送原始文件 */
async function sendFallbackOriginal(
  gateway: CmccGateway,
  job: PendingMediaJob,
): Promise<void> {
  try {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < job.chunks; i += 1) {
      const buf = await gateway.state.storage.get<ArrayBuffer>(
        `${MEDIA_CHUNK_PREFIX}${job.id}:${i}`,
      );
      if (!buf) return;
      parts.push(new Uint8Array(buf));
    }
    const bytes = concatBytes(parts, job.bytes);
    const file = new File([bytes.buffer as ArrayBuffer], job.fileName, {
      type: "application/octet-stream",
    });
    const uploaded = await uploadMedia(gateway, file);
    await sendMedia(gateway, {
      to: job.to,
      mediaType: inferMediaTypeFromUrl(job.fileName),
      content: job.content,
      mediaUrl: uploaded.mediaUrl,
      mediaFileName: job.fileName,
      mediaSize: file.size,
      mediaMimeType: file.type || undefined,
    });
    gateway.lastNotice = { text: "长录音兜底发送成功（原始文件）", at: Date.now() };
  } catch (error) {
    gateway.lastError = `长录音兜底发送也失败：${errorMessage(error)}`;
  }
}
