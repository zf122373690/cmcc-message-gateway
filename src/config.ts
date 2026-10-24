// 配置中心：把“中国移动 API Key / 设备令牌 / 默认接收人”等从 Worker Secret 移到 KV，
// 以便普通用户登录网页后台即可修改保存，无需 wrangler 命令行。环境变量作为兜底。

export const KV_CONFIG = "config";
export const KV_ADMIN = "admin";

export interface GatewayConfig {
  cmccApiKey?: string;
  apiToken?: string;
  defaultRecipient?: string;
  inboundWebhookUrl?: string;
  inboundWebhookToken?: string;
}

export function loadConfigKV(kv?: KVNamespace): Promise<GatewayConfig> {
  if (!kv) return Promise.resolve({});
  return kv.get(KV_CONFIG, "json").then((v) => (v as GatewayConfig) || {});
}

/** 局部更新配置并返回合并后的完整配置 */
export async function saveConfigKV(
  kv: KVNamespace | undefined,
  patch: GatewayConfig,
): Promise<GatewayConfig> {
  if (!kv) throw new Error("CONFIG KV 未绑定");
  const current = await loadConfigKV(kv);
  const next: GatewayConfig = { ...current };
  for (const key of Object.keys(patch) as (keyof GatewayConfig)[]) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (key === "cmccApiKey" || key === "apiToken" || key === "defaultRecipient") {
      if (!trimmed) continue; // 空值表示“不修改”，保留原值
    }
    (next as Record<string, string>)[key] = trimmed;
  }
  await kv.put(KV_CONFIG, JSON.stringify(next));
  return next;
}

/** 前端展示用：把密钥掩码，避免明文出现在页面 */
export function maskSecret(value?: string, head = 6): string {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length <= head + 2) return "•".repeat(v.length);
  return v.slice(0, head) + "•".repeat(Math.max(4, v.length - head));
}
