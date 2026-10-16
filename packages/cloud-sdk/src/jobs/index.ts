/** `withruntime/jobs`: Jobs alone. A command in a fresh sandbox, once or on a schedule.
 *
 *   import { jobs } from "withruntime/jobs";
 *   const client = jobs(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/jobs.js";

/** `runtime.jobs` of a client made with `options`. */
export function jobs(options?: RuntimeOptions): Runtime["jobs"] {
  return new Runtime(options).jobs;
}
