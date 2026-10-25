/** `withruntime/functions`: Functions alone. An HTTP handler on copies that
 * start when calls come and sleep a second after the last. In a private beta.
 *
 *   import { functions } from "withruntime/functions";
 *   const client = functions(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/functions.js";

/** `runtime.functions` of a client made with `options`. */
export function functions(options?: RuntimeOptions): Runtime["functions"] {
  return new Runtime(options).functions;
}
