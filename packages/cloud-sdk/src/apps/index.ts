/** `withruntime/apps`: Apps alone. An image served on copies that wake on a
 * request and freeze when quiet. In a private beta.
 *
 *   import { apps } from "withruntime/apps";
 *   const client = apps(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/apps.js";

/** `runtime.apps` of a client made with `options`. */
export function apps(options?: RuntimeOptions): Runtime["apps"] {
  return new Runtime(options).apps;
}
