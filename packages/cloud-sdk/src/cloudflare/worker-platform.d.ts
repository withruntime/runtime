/** Scoped aliases to the official module-mode Workers declarations. This avoids
 * loading their global DOM definitions into every Node SDK consumer. */
declare module "cloudflare:workers" {
  import type { CloudflareWorkersModule } from "@cloudflare/workers-types/index.ts";
  export const DurableObject: typeof CloudflareWorkersModule.DurableObject;
  export const RpcTarget: typeof CloudflareWorkersModule.RpcTarget;
}
