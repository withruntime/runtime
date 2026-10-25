/** `withruntime/desktops`: Desktops alone. A Linux desktop on its own sandbox, with a live view and computer use, at the sandbox rates. In a private beta.
 *
 *   import { desktops } from "withruntime/desktops";
 *   const client = desktops(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/desktops.js";

/** `runtime.desktops` of a client made with `options`. */
export function desktops(options?: RuntimeOptions): Runtime["desktops"] {
  return new Runtime(options).desktops;
}
