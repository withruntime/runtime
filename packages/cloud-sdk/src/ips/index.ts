/** `withruntime/ips`: IPs alone. Dedicated outbound addresses every sandbox of the account sends from.
 *
 *   import { ips } from "withruntime/ips";
 *   const client = ips(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type { EgressAddress, NetworkFunding } from "../products/network-products.js";

/** `runtime.ips` of a client made with `options`. */
export function ips(options?: RuntimeOptions): Runtime["ips"] {
  return new Runtime(options).ips;
}
