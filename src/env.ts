import type { CmccGateway } from "./cmcc-gateway.js";

export interface Bindings {
  CMCC_GATEWAY: DurableObjectNamespace<CmccGateway>;
  CONFIG?: KVNamespace;
  CMCC_API_KEY?: string;
  API_TOKEN?: string;
  CMCC_SERVER_URL?: string;
  CMCC_UPLOAD_URL?: string;
  CMCC_VERSION?: string;
  DEFAULT_RECIPIENT?: string;
  INBOUND_WEBHOOK_URL?: string;
  INBOUND_WEBHOOK_TOKEN?: string;
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  SESSION_SECRET?: string;
}

export interface HonoEnv {
  Bindings: Bindings;
}
