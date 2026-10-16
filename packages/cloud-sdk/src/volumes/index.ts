/** `withruntime/volumes`: Volumes alone. Persistent disks to attach to sandboxes.
 *
 *   import { volumes } from "withruntime/volumes";
 *   const client = volumes(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/volumes.js";

/** `runtime.volumes` of a client made with `options`. */
export function volumes(options?: RuntimeOptions): Runtime["volumes"] {
  return new Runtime(options).volumes;
}
