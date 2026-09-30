import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

/** Joining a sandbox to your tailnet. */
export type TailscaleJoin = {
  /** The name of a secret stored for jobs (`runtime secrets set NAME --jobs`)
   * that holds a Tailscale auth key. Use an ephemeral, tagged key. */
  authKeySecret: string;
  /** The machine's name on the tailnet, a DNS label. Default: the sandbox's
   * name, or runtime- and the first part of its id. */
  hostname?: string;
  /** Tags to advertise, such as `tag:agents`; the key must be allowed them. */
  tags?: string[];
};

/** A sandbox's machine on your tailnet, as the sandbox reports it. */
export type TailscaleNode = {
  /** Logged in and running now. */
  running: boolean;
  /** Tailscale's own word: Running, NeedsLogin, Starting, Stopped. */
  state: string | null;
  /** kernel: a tailscale0 interface reaches 100.x directly. userspace: the
   * tailnet reaches the sandbox's ports, and programs in it reach the tailnet
   * through `proxy`. */
  mode: "kernel" | "userspace" | null;
  /** Its MagicDNS name, such as agent-1.tail1234.ts.net. */
  dnsName: string | null;
  /** Its tailnet addresses, 100.x and fd7a:… */
  addresses: string[];
  /** SOCKS5 and HTTP proxy to the tailnet in userspace mode. */
  proxy: string | null;
};

/** What a join answers: the node, and what Runtime recorded. */
export type TailscaleJoined = TailscaleNode & {
  hostname: string;
  tags: string[];
  /** The secret the key was read from; never the key. */
  authKeySecret: string | null;
  joinedAt: number;
};

/** What `status()` answers: the node, and the join, or null on none. */
export type TailscaleStatus = TailscaleNode & {
  tailnet: Pick<TailscaleJoined, "hostname" | "tags" | "authKeySecret" | "joinedAt"> | null;
};

const enc = encodeURIComponent;

/** `sbx.tailscale`: this sandbox on your own Tailscale network. Paid
 * sandboxes only.
 *
 *   const node = await sbx.tailscale.up({ authKeySecret: "TS_AUTHKEY", tags: ["tag:agents"] });
 *   console.log(node.addresses);
 *
 * The auth key stays in the sandbox's memory. `down()` takes the machine off
 * the tailnet at once; after a stop or a delete, Tailscale removes it. */
export function sandboxTailscale(t: Transport, sandbox: Sandbox) {
  const path = () => `/v1/sandboxes/${enc(sandbox.id)}/tailscale`;
  return {
    up: (input: TailscaleJoin, options?: RequestOptions) =>
      t.json<TailscaleJoined>({ method: "POST", path: path(), body: input, ...options }),
    status: (options?: RequestOptions) =>
      t.json<TailscaleStatus>({ method: "GET", path: path(), ...options }),
    down: (options?: RequestOptions) =>
      t.json<{ left: boolean }>({ method: "DELETE", path: path(), ...options }),
  };
}
