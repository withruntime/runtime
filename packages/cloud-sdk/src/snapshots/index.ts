/** `withruntime/snapshots`: Snapshots alone. Saved sandboxes, disk and memory, to start or fork from.
 *
 *   import { snapshots } from "withruntime/snapshots";
 *   const client = snapshots(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export { Snapshots, type Snapshot, type SnapshotOptions } from "../snapshots.js";

/** `runtime.snapshots` of a client made with `options`. */
export function snapshots(options?: RuntimeOptions): Runtime["snapshots"] {
  return new Runtime(options).snapshots;
}
