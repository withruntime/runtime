/** `withruntime/domains`: Domains alone. Your own hostname for a sandbox's port, with HTTPS.
 *
 *   import { domains } from "withruntime/domains";
 *   const client = domains(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type { Domain, CheckedDomain, DnsRecord } from "../products/network-products.js";

/** `runtime.domains` of a client made with `options`. */
export function domains(options?: RuntimeOptions): Runtime["domains"] {
  return new Runtime(options).domains;
}
