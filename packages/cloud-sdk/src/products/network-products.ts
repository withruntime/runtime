import type { RequestOptions, Transport } from "../transport.js";

/* Custom domains, public TCP ports, dedicated outbound addresses and the
 * WireGuard tunnel into your sandboxes. Paid accounts only: an account that
 * has not added credit gets `payment_required` (402). None of these belongs to
 * one sandbox alone: a domain or a port names the sandbox and port it serves,
 * an address and the tunnel belong to the whole account.
 *
 *   const domain = await runtime.domains.add({ hostname: "app.example.com", sandboxId, port: 3000 });
 *   // set domain.records at your DNS provider, then
 *   await runtime.domains.verify("app.example.com");
 *   const db = await runtime.ports.open({ sandboxId, port: 5432 }); // db.connect: "203.0.113.10:23456"
 *   const ip = await runtime.addresses.reserve();                    // ip.address: every sandbox sends from it
 *   await runtime.tunnel.create();
 *   const office = await runtime.tunnel.addPeer({ name: "office", routes: ["10.0.0.0/16"] });
 *   // office.config is a wg-quick file: sudo wg-quick up ./runtime.conf
 */

export type DnsRecord = { type: string; name: string; value: string; purpose: string };
export type Domain = {
  id: string;
  hostname: string;
  sandboxId: string;
  port: number;
  /** pending until the TXT record proves the name is yours, then active. */
  state: "pending" | "active" | "released";
  url: string;
  /** Turned off by Runtime after a report. */
  disabled: boolean;
  /** The TXT record that proves the name, and the CNAME (or A) that sends visitors here. */
  records: DnsRecord[];
  verifiedAt: string | null;
  checkedAt: string | null;
  checkError: string | null;
  createdAt: string;
};
export type CheckedDomain = Domain & {
  /** The name resolves to Runtime's edge now. */
  pointed: boolean | null;
  hint: string;
};
export type TcpPort = {
  id: string;
  sandboxId: string;
  /** The port inside the sandbox. */
  port: number;
  address: string;
  publicPort: number;
  /** address:publicPort, for a client's host and port. */
  connect: string;
  protocol: "tcp";
  disabled: boolean;
  createdAt: string;
};
export type NetworkFunding = {
  /** False disables traffic; the reservation remains until explicitly released. */
  funded: boolean;
  /** Last funded-through ISO timestamp, possibly past. Null means no meter exists. */
  fundedUntil: string | null;
  /** Immutable monthly quote in millionths of a US dollar. */
  rateMicros: number;
  rateUnit: "unit_month";
};
export type EgressAddress = NetworkFunding & {
  id: string;
  address: string;
  family: 4 | 6;
  createdAt: string;
};
export type TunnelPeer = {
  id: string;
  name: string;
  publicKey: string;
  /** The peer's address inside the tunnel's subnet. */
  address: string;
  /** Your own ranges behind the peer that sandboxes may reach through it. */
  routes: string[];
  createdAt: string;
  rotatedAt: string | null;
};
export type Tunnel = NetworkFunding & {
  id: string;
  subnet: string;
  gatewayAddress: string;
  /** Where peers send WireGuard: address:udpPort. */
  endpoint: string;
  /** Null for a few seconds after creation. */
  gatewayPublicKey: string | null;
  disabled: boolean;
  peers: TunnelPeer[];
  /** Each sandbox's address in the tunnel. */
  sandboxes: { sandboxId: string; name: string | null; address: string; state: string }[];
  createdAt: string;
};
export type TunnelPeerCreated = {
  tunnel: Tunnel;
  peer: TunnelPeer;
  /** A wg-quick file. It holds the private key only when Runtime generated it. */
  config: string | null;
  /** False means config is a draft preserving the private key; fill its gateway PublicKey before use. */
  configReady: boolean;
  hint: string;
};

const enc = encodeURIComponent;
type Listed<T> = { data: T[]; nextCursor: string | null };

/** `runtime.domains`: serve a sandbox's port at your own hostname, with HTTPS. */
export function domains(t: Transport) {
  return {
    /** Claims the hostname and answers the DNS records to set. Calling it again
     * with another sandbox or port points the name there. */
    add: (input: { hostname: string; sandboxId: string; port: number }, options?: RequestOptions) =>
      t.json<CheckedDomain>({ method: "POST", path: "/v1/domains", body: input, ...options }),
    /** Checks the TXT record now; the name goes live when it matches. */
    verify: (hostname: string, options?: RequestOptions) =>
      t.json<CheckedDomain>({
        method: "POST",
        path: `/v1/domains/${enc(hostname)}:verify`,
        ...options,
      }),
    get: (hostname: string, options?: RequestOptions) =>
      t.json<Domain>({ method: "GET", path: `/v1/domains/${enc(hostname)}`, ...options }),
    list: async (options?: RequestOptions) =>
      (await t.json<Listed<Domain>>({ method: "GET", path: "/v1/domains", ...options })).data,
    remove: (hostname: string, options?: RequestOptions) =>
      t.json<{ hostname: string; deleted: true }>({
        method: "DELETE",
        path: `/v1/domains/${enc(hostname)}`,
        ...options,
      }),
  };
}

/** `runtime.ports`: a public TCP port to a port of a sandbox. */
export function ports(t: Transport) {
  return {
    /** Returns the same public port when called again for the same sandbox and port. */
    open: (input: { sandboxId: string; port: number }, options?: RequestOptions) =>
      t.json<TcpPort & { hint: string }>({
        method: "POST",
        path: "/v1/ports",
        body: input,
        ...options,
      }),
    list: async (filter: { sandboxId?: string } = {}, options?: RequestOptions) =>
      (
        await t.json<Listed<TcpPort>>({
          method: "GET",
          path: `/v1/ports${filter.sandboxId ? `?sandboxId=${enc(filter.sandboxId)}` : ""}`,
          ...options,
        })
      ).data,
    close: (portId: string, options?: RequestOptions) =>
      t.json<{ id: string; deleted: true }>({
        method: "DELETE",
        path: `/v1/ports/${enc(portId)}`,
        ...options,
      }),
  };
}

/** `runtime.addresses`: a dedicated outbound address every sandbox of the
 * account sends from, for allow-lists. */
export function addresses(t: Transport) {
  return {
    reserve: (input: { family?: 4 | 6 } = {}, options?: RequestOptions) =>
      t.json<EgressAddress>({ method: "POST", path: "/v1/addresses", body: input, ...options }),
    list: async (options?: RequestOptions) =>
      (await t.json<Listed<EgressAddress>>({ method: "GET", path: "/v1/addresses", ...options }))
        .data,
    release: (addressId: string, options?: RequestOptions) =>
      t.json<{ id: string; address: string; deleted: true }>({
        method: "DELETE",
        path: `/v1/addresses/${enc(addressId)}`,
        ...options,
      }),
  };
}

/** `runtime.tunnel`: a WireGuard tunnel from your own network into your sandboxes. */
export function tunnel(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<Tunnel>({ method: "GET", path: "/v1/tunnel", ...options }),
    /** Idempotent: returns the tunnel you have. */
    create: (input: { subnet?: string } = {}, options?: RequestOptions) =>
      t.json<Tunnel>({ method: "POST", path: "/v1/tunnel", body: input, ...options }),
    delete: (options?: RequestOptions) =>
      t.json<{ id: string; deleted: true }>({ method: "DELETE", path: "/v1/tunnel", ...options }),
    /** Leave publicKey out and Runtime generates the pair; the private key is
     * then in `config`, shown once. */
    addPeer: (
      input: { name: string; publicKey?: string; routes?: string[] },
      options?: RequestOptions,
    ) =>
      t.json<TunnelPeerCreated>({
        method: "POST",
        path: "/v1/tunnel/peers",
        body: input,
        ...options,
      }),
    rotatePeer: (peerId: string, input: { publicKey?: string } = {}, options?: RequestOptions) =>
      t.json<TunnelPeerCreated>({
        method: "POST",
        path: `/v1/tunnel/peers/${enc(peerId)}:rotate`,
        body: input,
        ...options,
      }),
    removePeer: (peerId: string, options?: RequestOptions) =>
      t.json<Tunnel>({ method: "DELETE", path: `/v1/tunnel/peers/${enc(peerId)}`, ...options }),
  };
}

/** The proxy your sandboxes' outbound connections go through. */
export type UpstreamProxy = {
  /** http://host:port or https://host:port. */
  url: string;
  /** The secret sent as Proxy-Authorization. */
  secret?: string;
  /** The destinations that go through it; every destination when absent. */
  hosts?: string[];
  updatedAt: string;
};
export type SetUpstreamProxy = {
  /** http://host:port or https://host:port. An https proxy's certificate must
   * verify against the public roots. */
  url: string;
  /** One of your secrets, sent as the Proxy-Authorization header's whole
   * value (such as `Basic dXNlcjpwYXNz`). Its hosts must name the proxy's host. */
  secret?: string;
  /** Only connections to these hosts (or `*.domain`) go through the proxy;
   * every connection when absent. 1 to 16. */
  hosts?: string[];
};

/** `runtime.network`: the network settings of the whole account.
 *
 *   await runtime.network.upstreamProxy.set({ url: "http://proxy.example.com:3128" });
 *
 * `upstreamProxy`: after Runtime's own rules allow a connection, the host
 * reaches it with CONNECT through your proxy, so your proxy's controls and
 * logs apply. A proxy that refuses or cannot be reached fails the connection
 * (upstream-proxy-failed); nothing goes around it. Paid accounts only. */
export function network(t: Transport) {
  const path = "/v1/network/upstream-proxy";
  return {
    upstreamProxy: {
      /** Send outbound connections through your proxy, replacing any set before. */
      set: (input: SetUpstreamProxy, options?: RequestOptions) =>
        t.json<UpstreamProxy & { enforced: boolean }>({
          method: "PUT",
          path,
          body: input,
          ...options,
        }),
      /** The proxy in use. Throws `not_found` (404) when none is set. */
      get: (options?: RequestOptions) => t.json<UpstreamProxy>({ method: "GET", path, ...options }),
      /** Connections leave directly again, within seconds. Throws `not_found`
       * (404) when none is set. */
      remove: (options?: RequestOptions) =>
        t.json<{ deleted: true; enforced: boolean }>({ method: "DELETE", path, ...options }),
    },
  };
}
