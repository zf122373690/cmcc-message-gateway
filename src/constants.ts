export const DEFAULT_CMCC_SERVER =
  "wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg";
export const DEFAULT_CMCC_UPLOAD =
  "https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api";
export const DEFAULT_CMCC_VERSION = "2.0";

export const RECIPIENT_KEY = "currentRecipient";
export const INBOX_KEY = "inbox";
export const LAST_FRAME_KEY = "lastServerFrame";
export const RECENT_FRAMES_KEY = "recentFrames";
export const MAX_RECENT_FRAMES = 20;
export const MAX_INBOX = 100;

/**
 * Durable Object 实例名（locationHint: "apac" 把它放到亚太机房）。
 * 改名会强制 DO 重建——旧实例的 alarm 会继续每 5 分钟唤醒并抢平台 WS 连接，
 * 因此旧名列入 LEGACY_DO_NAMES，由 alarm() 自杀清理（见 cmcc-gateway.ts）。
 */
export const DO_NAME = "gateway-apac";
/** 历史 DO 实例名，重建后需要自清理 */
export const LEGACY_DO_NAMES = ["default"];

/**
 * 长录音后台处理：AMR 超过该字节数（≈60s @1600B/s）时 /push 立即返回 200，
 * 转码+上传+发送交给 DO alarm 异步执行——前台请求 CPU 超限（Cloudflare
 * 30s/req）会直接杀掉 isolate，导致 T3 上传失败且兜底逻辑没机会跑。
 */
export const INLINE_TRANSCODE_MAX_BYTES = 96_000;
/** 待处理媒体任务的存储 key 与分片前缀 */
export const PENDING_MEDIA_KEY = "pendingMediaJob";
export const MEDIA_CHUNK_PREFIX = "pendingMediaChunk:";
/** 分片大小（DO 单 value 上限 128KB，留余量） */
export const MEDIA_CHUNK_SIZE = 64 * 1024;
/** 后台任务最大重试次数（发送失败时保留任务，下次 alarm 重试） */
export const PENDING_MEDIA_MAX_ATTEMPTS = 6;
