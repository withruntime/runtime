/** `withruntime/images`: Images alone. Custom images to start sandboxes from.
 *
 *   import { images } from "withruntime/images";
 *   const client = images(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/images.js";

/** `runtime.images` of a client made with `options`. */
export function images(options?: RuntimeOptions): Runtime["images"] {
  return new Runtime(options).images;
}
