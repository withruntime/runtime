/** `withruntime/ports`: Ports alone. A public TCP port to a sandbox's port.
 *
 *   import { ports } from "withruntime/ports";
 *   const client = ports(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type { TcpPort } from "../products/network-products.js";

/** `runtime.ports` of a client made with `options`. */
export function ports(options?: RuntimeOptions): Runtime["ports"] {
  return new Runtime(options).ports;
}
