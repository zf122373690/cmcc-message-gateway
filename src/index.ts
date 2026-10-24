import { app } from "./app.js";
import type { Bindings } from "./env.js";
import { DO_NAME } from "./constants.js";

export { CmccGateway } from "./cmcc-gateway.js";

export default {
  fetch: app.fetch,

  // 如果配置了 Cron Trigger，定期唤醒 Durable Object 做连接自检。
  scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): void {
    const id = env.CMCC_GATEWAY.idFromName(DO_NAME);
    const stub = env.CMCC_GATEWAY.get(id, { locationHint: "apac" });
    ctx.waitUntil(
      stub.fetch(new Request("https://cmcc.internal/connect")).then(() => {}),
    );
  },
} satisfies ExportedHandler<Bindings>;
