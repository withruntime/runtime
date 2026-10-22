/** `withruntime/ci`: CI/CD alone. Each push and pull request of a connected
 * GitHub repository is checked in sandboxes. In a private beta.
 *
 *   import { ci } from "withruntime/ci";
 *   const client = ci(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/ci.js";

/** `runtime.ci` of a client made with `options`. */
export function ci(options?: RuntimeOptions): Runtime["ci"] {
  return new Runtime(options).ci;
}
