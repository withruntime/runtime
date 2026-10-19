/** `withruntime/agents`: Agents alone. A harness in a sandbox of its own per
 * session, on your own model key. In a private beta.
 *
 *   import { agents } from "withruntime/agents";
 *   const client = agents(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/agents.js";
export { AGENT_TEMPLATES, AGENT_USES } from "../products/agents.js";

/** `runtime.agents` of a client made with `options`. */
export function agents(options?: RuntimeOptions): Runtime["agents"] {
  return new Runtime(options).agents;
}
