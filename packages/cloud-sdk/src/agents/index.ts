/** `withruntime/agents`: Agents alone. A harness in a sandbox of its own per
 * session, on your own model key. In a private beta.
 *
 *   import { agents, loadAgentsFile } from "withruntime/agents";
 *   const client = agents(); // RUNTIME_API_KEY, or this machine's saved connection
 *   await client.deploy(loadAgentsFile("runtime.yml"), { dryRun: true }); // what CI runs
 *
 * A browser or worker bundle gets browser.ts instead: all of this but the
 * runtime.yml loader, which reads the file system. */
export * from "./browser.js";
export { AGENTS_FILE, loadAgentsFile, parseAgentsFile } from "../agents-file.js";
