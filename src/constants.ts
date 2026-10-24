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
