/** Only the fixture alias has this type; the bundler resolves the actual pinned JS. */
declare module "@compat/cloudflare-published" {
  import type { getSandbox as factory } from "../../src/cloudflare/worker.js";
  export const getSandbox: typeof factory;
}
