/** `withruntime/containers`: Containers alone. One OCI image's process on its
 * own microVM, at the sandbox rates. In a private beta.
 *
 *   import { containers } from "withruntime/containers";
 *   const client = containers(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/containers.js";

/** `runtime.containers` of a client made with `options`. */
export function containers(options?: RuntimeOptions): Runtime["containers"] {
  return new Runtime(options).containers;
}
