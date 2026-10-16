/** `withruntime/networks`: Networks alone. The account's networks: WireGuard in, sandboxes by name, your proxy out.
 *
 *   import { networks } from "withruntime/networks";
 *   const client = networks(); // RUNTIME_API_KEY, or this machine's saved connection
 */
import { Runtime, type RuntimeOptions } from "../client.js";

export type {
  Tunnel,
  TunnelPeer,
  TunnelPeerCreated,
  UpstreamProxy,
  SetUpstreamProxy,
} from "../products/network-products.js";
export type { PrivateNetwork } from "../products/private-network.js";
export type { SignedRequests } from "../products/signed-requests.js";

/** `runtime.networks` of a client made with `options`. */
export function networks(options?: RuntimeOptions): Runtime["networks"] {
  return new Runtime(options).networks;
}
