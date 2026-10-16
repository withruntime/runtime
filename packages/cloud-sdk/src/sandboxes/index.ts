/** `withruntime/sandboxes`: Sandboxes alone. Linux microVMs: create, find and list sandboxes.
 *
 *   import { sandboxes } from "withruntime/sandboxes";
 *   const client = sandboxes(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export { Sandbox } from "../index.js";
export { Sandboxes } from "../client.js";
export type * from "../types.js";

/** `runtime.sandboxes` of a client made with `options`. */
export function sandboxes(options?: RuntimeOptions): Runtime["sandboxes"] {
  return new Runtime(options).sandboxes;
}
