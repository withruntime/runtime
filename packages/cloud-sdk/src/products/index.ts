import type { Transport } from "../transport.js";
import type { Sandbox } from "../sandbox.js";
import { images } from "./images.js";
import { sandboxDesktop } from "./desktop.js";
import { sandboxInterpreter } from "./interpreter.js";
import { sandboxNetwork } from "./network.js";
import { addresses, domains, network, ports, tunnel } from "./network-products.js";
import { sandboxPreviews } from "./previews.js";
import { referrals } from "./referrals.js";
import { billing } from "./billing.js";
import { audit } from "./audit.js";
import { sso } from "./sso.js";
import { switching } from "./switching.js";
import { limits } from "./limits.js";
import { volumes } from "./volumes.js";
import { jobs } from "./jobs.js";
import { sandboxMounts } from "./mounts.js";
import { sandboxTailscale } from "./tailscale.js";
import { secrets } from "./secrets.js";
import { mcp, sandboxMcp } from "./mcp.js";
import { events, otel, sandboxMetrics, webhooks } from "./observability.js";

/* HOW A LANE ADDS A PRODUCT TO THE SDK
 *
 * 1. Write src/products/<name>.ts exporting a factory:
 *      export function images(t: Transport) {
 *        return {
 *          create: (input: CreateImage, options?: RequestOptions) =>
 *            t.json<Image>({ method: "POST", path: "/v1/images", body: input, ...options }),
 *          ...
 *        };
 *      }
 *    and, for methods that belong on a sandbox (sbx.previews.create(3000)):
 *      export function sandboxPreviews(t: Transport, sandbox: Sandbox) { return { ... } }
 * 2. Add ONE line to the matching object below. The Runtime client and every
 *    Sandbox pick it up, typed, with the shared auth, retries, keys and errors.
 */
export const clientExtensions = {
  images,
  volumes,
  jobs,
  referrals,
  billing,
  limits,
  switching,
  secrets,
  webhooks,
  otel,
  events,
  audit,
  mcp,
  sso,
  domains,
  ports,
  addresses,
  tunnel,
  network,
} satisfies Record<string, (t: Transport) => unknown>;

export const sandboxExtensions = {
  interpreter: sandboxInterpreter,
  previews: sandboxPreviews,
  network: sandboxNetwork,
  desktop: sandboxDesktop,
  mounts: sandboxMounts,
  tailscale: sandboxTailscale,
  metrics: sandboxMetrics,
  mcp: sandboxMcp,
} satisfies Record<string, (t: Transport, sandbox: Sandbox) => unknown>;

export type ClientExtensions = {
  readonly [K in keyof typeof clientExtensions]: ReturnType<(typeof clientExtensions)[K]>;
};
export type SandboxExtensions = {
  readonly [K in keyof typeof sandboxExtensions]: ReturnType<(typeof sandboxExtensions)[K]>;
};

/** The factories as plain pairs, for the constructors that install them. */
export function clientFactories(): Array<[string, (t: Transport) => unknown]> {
  return Object.entries(clientExtensions);
}
export function sandboxFactories(): Array<[string, (t: Transport, sandbox: Sandbox) => unknown]> {
  return Object.entries(sandboxExtensions);
}
