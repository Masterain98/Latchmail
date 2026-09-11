import type { Env as AppEnv } from "./worker/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      readonly __appEnvBrand?: never;
    }
  }
}
export {};
