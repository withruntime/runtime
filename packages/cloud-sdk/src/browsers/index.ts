/** `withruntime/browsers`: Browsers alone. Chromium on its own sandbox, with a private CDP address and screenshots, at the sandbox rates. In a private beta.
 *
 *   import { browsers } from "withruntime/browsers";
 *   const client = browsers(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type * from "../products/browsers.js";

/** `runtime.browsers` of a client made with `options`. */
export function browsers(options?: RuntimeOptions): Runtime["browsers"] {
  return new Runtime(options).browsers;
}
