/** `withruntime/agents` in a browser or a worker (package.json's "browser"
 * condition): the client and the deploy's check, without the runtime.yml
 * loader, which reads the file system (agents-file.ts). Node and Bun get
 * index.ts, this and the loader. */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/agents.js";
export type * from "../agents-deploy.js";
export { AGENT_TEMPLATES, AGENT_USES } from "../products/agents.js";
import { withDeploy, type AgentsClient } from "../agents-deploy.js";

export { checkAgentsFile, MANAGED_LABEL, withDeploy } from "../agents-deploy.js";

/** `runtime.agents` of a client made with `options`, with `deploy`. */
export function agents(options?: RuntimeOptions): AgentsClient {
  return withDeploy(new Runtime(options).agents);
}
