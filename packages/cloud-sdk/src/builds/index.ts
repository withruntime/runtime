/** `withruntime/builds`: Builds alone. An image built from a repository's
 * commit, at the sandbox rates. In a private beta.
 *
 *   import { builds } from "withruntime/builds";
 *   const client = builds(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/builds.js";

/** `runtime.builds` of a client made with `options`. */
export function builds(options?: RuntimeOptions): Runtime["builds"] {
  return new Runtime(options).builds;
}
